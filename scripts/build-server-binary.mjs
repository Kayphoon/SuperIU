#!/usr/bin/env node
/**
 * Build the headless `superiu-server` daemon into standalone Linux binaries.
 *
 * `bun build --compile` embeds the JS runtime AND every dependency (including
 * `ws` plus bun's `node:http` shim) into a single file with no interpreter, no
 * `node_modules`, and no Node install on the target VPS.
 *
 * This script drives `Bun.build()` rather than the `bun build` CLI because it
 * needs two things the CLI cannot express:
 *
 *   1. A `--define` that bakes the package version in. A compiled binary's
 *      `import.meta.url` is `file:///$bunfs/root/...`, so the daemon's
 *      `package.json` walk cannot reach the real manifest at runtime.
 *   2. A plugin that strips `packages/ui/src/server.ts`'s standalone
 *      `isMainModule` block. bun flattens `import.meta.url` to the SAME value
 *      for every bundled module, so that guard is spuriously TRUE inside the
 *      compiled binary — it would boot a second, default-options server
 *      alongside the daemon's own. The block is removed at bundle time only;
 *      `server.ts` on disk is untouched, so `node dist/server.js` still works.
 *
 * Usage:
 *   node scripts/build-server-binary.mjs                 # x64 only (default)
 *   node scripts/build-server-binary.mjs --all           # both linux targets
 *   node scripts/build-server-binary.mjs --target=bun-linux-arm64
 *
 * Version source (`SUPERIU_VERSION`):
 *   Tagged releases pass the git tag (e.g. `v0.2.9`) and it is baked in with
 *   the single leading `v` stripped (`0.2.9`). A value that is not valid
 *   semver (e.g. the literal `master` the rolling channel would pass) is
 *   ignored, and the version falls back to the root `package.json` — which is
 *   also the behaviour when the variable is unset or empty.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(REPO_ROOT, 'packages', 'ui', 'src', 'daemon.ts');
const SERVER_SOURCE = path.join(REPO_ROOT, 'packages', 'ui', 'src', 'server.ts');
const PUBLIC_DIR = path.join(REPO_ROOT, 'packages', 'ui', 'public');

/** Virtual module id the daemon imports the build-time asset bundle from. */
const ASSET_MODULE_ID = 'superiu:assets';

/** MIME-independent: every file is inlined as base64 and written back verbatim. */
const ASSET_EXTENSIONS = new Set(['.html', '.js', '.css', '.png', '.svg', '.ico', '.json', '.map', '.woff2']);
const OUT_DIR = path.join(REPO_ROOT, 'dist', 'server');

/** bun compile target -> output file name. Order is the `--all` build order. */
const TARGETS = [
  { target: 'bun-linux-x64', output: 'superiu-server-linux-x64' },
  { target: 'bun-linux-arm64', output: 'superiu-server-linux-arm64' }
];

/**
 * The standalone-entry block in `server.ts`, matched verbatim from the
 * comment through the closing brace. Anchored to the end of the file so a
 * future edit that keeps the block elsewhere is not silently over-stripped —
 * if it no longer matches, the build fails loudly rather than shipping a
 * double-booting binary.
 */
const SERVER_GUARD_PATTERN =
  /\/\/ Standalone entry point:[\s\S]*?\nif \(isMainModule\) \{[\s\S]*?\n\}\n?$/;

function parseSelection(argv) {
  const all = argv.includes('--all');
  const requested = [];
  for (const arg of argv) {
    if (arg === '--all') continue;
    const match = /^--target=(.+)$/.exec(arg);
    if (match) requested.push(match[1]);
  }

  if (all || requested.length === 0) return TARGETS;
  return requested.map((target) => {
    const known = TARGETS.find((entry) => entry.target === target);
    if (!known) {
      throw new Error(
        `Unknown target '${target}'. Supported: ${TARGETS.map((t) => t.target).join(', ')}`
      );
    }
    return known;
  });
}

function assertBunAvailable() {
  if (typeof Bun === 'undefined') {
    throw new Error(
      'bun is required but this script is not running under bun and the Bun global is unavailable.\n' +
        'Install it (https://bun.sh) and re-run with `bun scripts/build-server-binary.mjs` or ensure `bun` is on PATH.'
    );
  }
  return Bun.version;
}

/** Release tags are `v1.2.3`, optionally with a prerelease suffix. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readPackageVersion() {
  const envVersion = process.env.SUPERIU_VERSION;
  if (typeof envVersion === 'string' && envVersion) {
    const candidate = envVersion.replace(/^[vV]/, '');
    if (SEMVER_PATTERN.test(candidate)) {
      return candidate;
    }
    // e.g. the rolling `master` channel passes a non-semver marker: fall back
    // to the root package.json rather than baking an unusable version.
  }
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8');
  const version = JSON.parse(raw).version;
  if (typeof version !== 'string' || !version) {
    throw new Error('Could not read a version from the root package.json');
  }
  return version;
}

/**
 * Strip the standalone-entry guard from `server.ts` as it is loaded. Returned
 * as `contents`, so `server.ts` itself is never modified.
 */
function serverStrippingPlugin() {
  return {
    name: 'strip-server-standalone-guard',
    setup(build) {
      build.onLoad({ filter: /packages[/\\]ui[/\\]src[/\\]server\.ts$/ }, async (args) => {
        const source = await Bun.file(args.path).text();
        const stripped = source.replace(SERVER_GUARD_PATTERN, '');
        if (stripped === source) {
          throw new Error(
            `Could not strip the standalone guard from ${path.relative(REPO_ROOT, args.path)}. ` +
              'The block has changed shape; update SERVER_GUARD_PATTERN in scripts/build-server-binary.mjs.'
          );
        }
        return { contents: stripped, loader: 'ts' };
      });
    }
  };
}

/**
 * Collect `packages/ui/public/` into a base64 map exposed as the virtual module
 * `superiu:assets`. The daemon writes these to a temp directory at startup and
 * hands that path to `startServer` as `publicDir` — see `materializeEmbeddedAssets`
 * in `daemon.ts` for why the raw `$bunfs` path is not usable.
 */
function assetBundlingPlugin() {
  const files = [];

  function collect(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        collect(full, name);
      } else if (entry.isFile()) {
        files.push({ name, full });
      }
    }
  }

  return {
    name: 'embed-public-assets',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${ASSET_MODULE_ID}$`) }, () => ({
        path: ASSET_MODULE_ID,
        namespace: 'superiu-assets'
      }));
      build.onLoad({ filter: /.*/, namespace: 'superiu-assets' }, () => {
        // Collected lazily, once, on first load.
        if (files.length === 0) collect(PUBLIC_DIR, '');

        const entries = files
          .filter((file) => ASSET_EXTENSIONS.has(path.extname(file.name).toLowerCase()))
          .map((file) => {
            const base64 = fs.readFileSync(file.full).toString('base64');
            return `${JSON.stringify(file.name)}: ${JSON.stringify(base64)}`;
          });

        if (entries.length === 0) {
          throw new Error(`No static assets found under ${path.relative(REPO_ROOT, PUBLIC_DIR)}`);
        }

        return {
          contents: `export default {${entries.join(',')}};`,
          loader: 'js'
        };
      });
    }
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB (${bytes} bytes)`;
}

async function buildOne({ target, output }, version) {
  const outfile = path.join(OUT_DIR, output);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: 'bun',
    minify: false,
    sourcemap: 'none',
    compile: { target, outfile },
    define: {
      SUPERIU_BUILD_VERSION: JSON.stringify(version),
      SUPERIU_ASSET_MODULE: JSON.stringify(ASSET_MODULE_ID)
    },
    plugins: [serverStrippingPlugin(), assetBundlingPlugin()]
  });

  if (!result.success) {
    const detail = result.logs.map((log) => `${log.level}: ${log.message}`).join('\n');
    throw new Error(`bun build failed for ${target}\n${detail}`);
  }
  for (const log of result.logs) {
    console.log(`  [${log.level}] ${log.message}`);
  }

  if (!fs.existsSync(outfile)) {
    throw new Error(`bun build reported success but ${outfile} does not exist`);
  }
  fs.chmodSync(outfile, 0o755);

  const size = fs.statSync(outfile).size;
  console.log(`  ${output}: ${formatBytes(size)}`);
  return { output, outfile, size };
}

async function main() {
  // The plugin + `Bun.build` API require bun. Under plain node (the documented
  // entrypoint and what CI runs) re-exec the SAME script under bun, so callers
  // never have to know which runtime is needed.
  if (typeof Bun === 'undefined') {
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync('bun', ['--version'], { encoding: 'utf-8' });
    if (probe.error || probe.status !== 0) {
      console.error(
        'error: bun was not found on PATH. Install it (https://bun.sh) or run this script where bun is available.'
      );
      process.exitCode = 1;
      return;
    }
    const relay = spawnSync('bun', [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit'
    });
    process.exitCode = relay.status ?? 1;
    return;
  }

  let selection;
  try {
    selection = parseSelection(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  let bunVersion;
  try {
    bunVersion = assertBunAvailable();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(ENTRY)) {
    console.error(`error: entrypoint not found: ${ENTRY}`);
    process.exitCode = 1;
    return;
  }

  let version;
  try {
    version = readPackageVersion();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`bun ${bunVersion} | version ${version}`);
  console.log(`building ${selection.length} target(s) -> ${path.relative(REPO_ROOT, OUT_DIR)}/`);

  try {
    for (const entry of selection) await buildOne(entry, version);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  console.log('done.');
}

await main();

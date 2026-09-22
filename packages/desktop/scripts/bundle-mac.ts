/**
 * bundle-mac.ts — turn `@agent/desktop` into a real, Spotlight-indexable macOS
 * application.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `pnpm desktop` runs `electron .`, which boots `node_modules/electron/dist/
 * Electron.app`. That bundle is named "Electron" (`CFBundleName = Electron`,
 * `CFBundleIdentifier = com.github.Electron`), so the window, the Dock tile, the
 * menu bar and Spotlight all report the *framework*, not the product. Spotlight
 * resolves ⌘+Space queries through LaunchServices, which only knows about `.app`
 * bundles in indexed locations whose `Info.plist` carries the product name —
 * a bare `electron .` is invisible to it no matter how the window is titled.
 *
 * This script produces the missing artifact: a self-contained `SuperIU.app`
 * whose identity is SuperIU end to end, installed where LaunchServices and
 * `mdimport` actually look (`~/Applications`).
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *  1. Ensure the three packages are compiled (`dist/` fresh against `src/`).
 *  2. Compile `assets/icon.png` into `assets/icon.icns` via `iconutil` when the
 *     PNG is newer.
 *  3. Copy `Electron.app` into `dist/SuperIU.app` and rename the executable.
 *  4. Rewrite the bundle identity (name, id, executable, icon, version) in
 *     `Contents/Info.plist`, and the four helper bundles' identifiers.
 *  5. Install the compiled icon as `Contents/Resources/app.icns`.
 *  6. Build `Contents/Resources/app`: the desktop `dist/`, its `package.json`,
 *     the docs the Help menu opens, and a `node_modules/` holding the exact
 *     runtime dependency closure of `@agent/core` + `@agent/ui`. Because
 *     `Resources/app` exists, Electron loads it as a *packaged* app and ignores
 *     `default_app.asar` (which is removed).
 *  7. Ad-hoc re-sign the bundle, so the seal matches the edited `Info.plist`.
 *  8. Install to `~/Applications/SuperIU.app`, clear quarantine, and register
 *     with LaunchServices + `mdimport` so ⌘+Space finds it immediately.
 *
 * Usage:
 *   tsx scripts/bundle-mac.ts                 # bundle, install, register
 *   tsx scripts/bundle-mac.ts --no-install    # bundle only (dist/SuperIU.app)
 *   tsx scripts/bundle-mac.ts --zip           # also write a distributable .zip
 *                                             # next to the bundle
 *
 * macOS only: it drives `plutil`, `codesign`, `xattr`, `lsregister`, `mdimport`,
 * `sips` and `iconutil`. Re-runnable; every step is idempotent.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths and constants
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(HERE, '..'); // packages/desktop
const REPO_ROOT = path.resolve(PKG_DIR, '..', '..');

const ASSETS_DIR = path.join(PKG_DIR, 'assets');
const ICON_ICNS = path.join(ASSETS_DIR, 'icon.icns');
const DIST_DIR = path.join(PKG_DIR, 'dist');
const APP_PATH = path.join(DIST_DIR, 'SuperIU.app');
const CONTENTS = path.join(APP_PATH, 'Contents');
const RESOURCES = path.join(CONTENTS, 'Resources');
const APP_RESOURCES = path.join(RESOURCES, 'app');
const APP_NODE_MODULES = path.join(APP_RESOURCES, 'node_modules');

const APP_NAME = 'SuperIU';
const BUNDLE_ID = 'com.superiu.desktop';
const ICON_FILE = 'app.icns';

/** Where LaunchServices + Spotlight actually look for user-installed apps. */
const INSTALL_DIR = path.join(os.homedir(), 'Applications');
const INSTALLED_APP = path.join(INSTALL_DIR, `${APP_NAME}.app`);

const ICON_PNG = path.join(ASSETS_DIR, 'icon.png');

/** The ten members `iconutil` expects, as `<pixels> <member name>` pairs. */
const ICONSET_MEMBERS: ReadonlyArray<readonly [number, string]> = [
  [16, 'icon_16x16'],
  [32, 'icon_16x16@2x'],
  [32, 'icon_32x32'],
  [64, 'icon_32x32@2x'],
  [128, 'icon_128x128'],
  [256, 'icon_128x128@2x'],
  [256, 'icon_256x256'],
  [512, 'icon_256x256@2x'],
  [512, 'icon_512x512'],
  [1024, 'icon_512x512@2x']
];

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** Packages whose `dist/` must exist, source-fresh, before bundling. */
const BUILD_TARGETS = [
  { name: '@agent/core', dir: path.join(REPO_ROOT, 'packages', 'core') },
  { name: '@agent/ui', dir: path.join(REPO_ROOT, 'packages', 'ui') },
  { name: '@agent/desktop', dir: PKG_DIR }
];

/** The packages the bundle's own entry points import. */
const ENTRY_PACKAGES = ['@agent/core', '@agent/ui'];

const INSTALL = !process.argv.includes('--no-install');
const CREATE_ZIP = process.argv.includes('--zip');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `log` is the script's entire output vocabulary: one aligned prefix per step. */
function log(step: string, message: string): void {
  console.log(`${step.padEnd(14)} ${message}`);
}

/** Runs a tool, surfacing its stderr instead of a raw stack when it fails. */
function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : String(error);
    fail(`${path.basename(command)} ${args.join(' ')} failed:\n${stderr.trim()}`);
  }
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** Synchronous pause, so `verify` can poll without becoming async. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Newest mtime (ms) of any file under `dir`, or 0 when it does not exist. */
function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const { mtimeMs } = fs.statSync(full);
        if (mtimeMs > newest) newest = mtimeMs;
      }
    }
  };
  walk(dir);
  return newest;
}

// ---------------------------------------------------------------------------
// 1. Compile the packages that go into the bundle
// ---------------------------------------------------------------------------

function ensureBuilt(): void {
  const tsc = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc');

  for (const target of BUILD_TARGETS) {
    const srcDir = path.join(target.dir, 'src');
    const outDir = path.join(target.dir, 'dist');

    if (fs.existsSync(outDir) && newestMtime(srcDir) <= newestMtime(outDir)) {
      log('build', `${target.name} up to date`);
      continue;
    }
    if (!fs.existsSync(tsc)) {
      fail(`TypeScript compiler not found at ${tsc}. Run \`pnpm install\` first.`);
    }

    log('build', `compiling ${target.name}`);
    run(tsc, ['-p', target.dir]);
  }
}

// ---------------------------------------------------------------------------
// 2. Compile the icon
// ---------------------------------------------------------------------------

/**
 * Derive `icon.icns` from `icon.png` when the PNG is newer.
 *
 * `icon.png` is the committed source of truth (see `scripts/make-icon.swift`);
 * the `.icns` is a build product of it. Compiling it here rather than checking
 * it in keeps the two from ever drifting apart.
 */
function ensureIcon(): void {
  if (!fs.existsSync(ICON_PNG)) {
    fail(`Icon source missing: ${ICON_PNG}\nRegenerate it with scripts/make-icon.swift.`);
  }

  const pngMtime = fs.statSync(ICON_PNG).mtimeMs;
  if (fs.existsSync(ICON_ICNS) && fs.statSync(ICON_ICNS).mtimeMs >= pngMtime) {
    log('icon', 'Contents/Resources/app.icns (up to date)');
    return;
  }

  const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-iconset-'));
  const iconsetDir = path.join(iconset, 'SuperIU.iconset');
  fs.mkdirSync(iconsetDir);

  try {
    for (const [pixels, member] of ICONSET_MEMBERS) {
      // `sips` resamples in the source's colour space and keeps the alpha
      // channel, which `iconutil` requires for the rounded plate's corners.
      run('/usr/bin/sips', [
        '-z',
        String(pixels),
        String(pixels),
        ICON_PNG,
        '--out',
        path.join(iconsetDir, `${member}.png`)
      ]);
    }
    run('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', ICON_ICNS]);
    log('icon', `compiled ${ICONSET_MEMBERS.length} sizes → assets/icon.icns`);
  } finally {
    fs.rmSync(iconset, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. Dependency closure
// ---------------------------------------------------------------------------

interface PackageRef {
  /** Package directory in the repository. */
  dir: string;
  /** Real path, used to recognise the same package reached by two routes. */
  real: string;
}

/**
 * Walk up from `fromDir` looking for `node_modules/<name>`.
 *
 * This is Node's own resolution order, and it is why a pnpm workspace resolves
 * at all: `packages/core/node_modules/ai` is a symlink into the store, and the
 * walk finds it from `packages/core/dist/`.
 */
function findPackageDir(name: string, fromDir: string): string | null {
  let current = fromDir;
  for (;;) {
    const candidate = path.join(current, 'node_modules', name);
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readPackageRef(name: string, fromDir: string): PackageRef | null {
  const dir = findPackageDir(name, fromDir);
  return dir ? { dir, real: fs.realpathSync(dir) } : null;
}

function dependenciesOf(ref: PackageRef): string[] {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ref.dir, 'package.json'), 'utf-8')
  ) as { dependencies?: Record<string, string> };
  return Object.keys(manifest.dependencies ?? {});
}

function copyPackage(ref: PackageRef, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(ref.dir, dest, {
    recursive: true,
    // Packages in the store are symlinked; the bundle must hold real files.
    dereference: true,
    // A package's own `node_modules/` holds store symlinks. The closure walk
    // recreates whatever is genuinely reachable from real directories.
    filter: (source) => !['node_modules', '.DS_Store'].includes(path.basename(source))
  });
}

/** dest path → the package that was written there. */
type Placements = Map<string, PackageRef>;

/**
 * Materialise the runtime closure of `name` into `destNodeModules`.
 *
 * A dependency is hoisted to the bundle root when nothing else occupies the
 * name, and nested under the *requiring* package when a different version is
 * already there. That is the layout Node's resolver expects, so no package is
 * ever handed a version it did not ask for. This closure has exactly one such
 * conflict — `path-key@3` for cross-spawn vs `path-key@4` for npm-run-path —
 * which is precisely what a flat copy would silently break.
 */
function materialize(
  name: string,
  fromDir: string,
  destNodeModules: string,
  rootNodeModules: string,
  placements: Placements,
  seen: Set<string>
): void {
  const ref = readPackageRef(name, fromDir);
  if (!ref) {
    fail(
      `Cannot resolve dependency "${name}" from ${fromDir}.\n` +
        'Run `pnpm install` so the workspace is fully linked.'
    );
  }

  const nested = path.join(destNodeModules, name);
  const hoisted = path.join(rootNodeModules, name);

  if (fs.existsSync(nested)) return; // Already materialised for this requirer.
  if (placements.get(hoisted)?.real === ref.real) return; // Hoisted and reachable.

  // Free name at the root → hoist; taken by another version → nest it here.
  const dest = fs.existsSync(hoisted) ? nested : hoisted;

  copyPackage(ref, dest);
  placements.set(dest, ref);

  // Cycles are impossible in a valid tree, but a package is only walked once
  // per destination regardless.
  const key = `${ref.real}→${dest}`;
  if (seen.has(key)) return;
  seen.add(key);

  for (const dependency of dependenciesOf(ref)) {
    materialize(
      dependency,
      ref.dir,
      path.join(dest, 'node_modules'),
      rootNodeModules,
      placements,
      seen
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Info.plist identity
// ---------------------------------------------------------------------------

const PLUTIL = '/usr/bin/plutil';

function plistSet(plist: string, key: string, value: string): void {
  run(PLUTIL, ['-replace', key, '-string', value, plist]);
}

function writeBundleIdentity(version: string): void {
  const plist = path.join(CONTENTS, 'Info.plist');

  plistSet(plist, 'CFBundleName', APP_NAME);
  plistSet(plist, 'CFBundleDisplayName', APP_NAME);
  plistSet(plist, 'CFBundleIdentifier', BUNDLE_ID);
  plistSet(plist, 'CFBundleExecutable', APP_NAME);
  plistSet(plist, 'CFBundleIconFile', ICON_FILE);
  plistSet(plist, 'CFBundleShortVersionString', version);
  plistSet(plist, 'CFBundleVersion', version);

  // The seal referenced `Resources/default_app.asar`, which this script removes
  // in favour of `Resources/app`; a stale hash there would be a lie.
  try {
    run(PLUTIL, ['-remove', 'ElectronAsarIntegrity', plist]);
  } catch {
    // Key absent (already bundled once) — nothing to remove.
  }

  log('identity', `${APP_NAME} · ${BUNDLE_ID} · ${version}`);
}

/**
 * Re-identify the four helper bundles (GPU / Renderer / Plugin / main helper).
 *
 * Electron locates helpers by their hard-coded *paths*, so directory and
 * executable names must stay as shipped — but the bundle identifiers are what
 * LaunchServices, Activity Monitor and the Dock key off. They must be distinct
 * (duplicate identifiers confuse LaunchServices) and namespaced under SuperIU
 * so the helpers read as part of this app rather than as stray Electron.
 */
function writeHelperIdentity(): void {
  const frameworks = path.join(CONTENTS, 'Frameworks');
  if (!fs.existsSync(frameworks)) return;

  let count = 0;
  for (const entry of fs.readdirSync(frameworks, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
    const plist = path.join(frameworks, entry.name, 'Contents', 'Info.plist');
    if (!fs.existsSync(plist)) continue;

    // "Electron Helper (Renderer).app" → "helper.renderer"; "Electron Helper.app" → "helper".
    const role = /\(([^)]+)\)/.exec(entry.name)?.[1];
    const suffix = role ? `.helper.${role.toLowerCase()}` : '.helper';
    const label = role ? `${APP_NAME} Helper (${role})` : `${APP_NAME} Helper`;

    plistSet(plist, 'CFBundleIdentifier', `${BUNDLE_ID}${suffix}`);
    plistSet(plist, 'CFBundleName', label);
    plistSet(plist, 'CFBundleDisplayName', label);
    count += 1;
  }
  log('identity', `${count} helper bundle(s) → ${BUNDLE_ID}.helper*`);
}

// ---------------------------------------------------------------------------
// 5. Contents/Resources/app
// ---------------------------------------------------------------------------

/**
 * Build `Contents/Resources/app`.
 *
 * The payload is assembled in a temp directory first: `dist/` is both the
 * bundle's staging parent *and* the source of the main process, so copying it
 * straight into the bundle would be a copy of a directory into itself.
 */
function writeAppResources(version: string): void {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-app-'));
  const stagingModules = path.join(staging, 'node_modules');
  try {
    // `dist/` holds the bundle being assembled, so the copy must skip it —
    // otherwise the app would recursively contain itself.
    fs.cpSync(path.join(PKG_DIR, 'dist'), path.join(staging, 'dist'), {
      recursive: true,
      filter: (source) => path.resolve(source) !== path.resolve(APP_PATH)
    });

    // Electron reads this for `app.getName()`, `app.getVersion()` and the entry
    // point (`main`, resolved relative to the app root).
    fs.writeFileSync(
      path.join(staging, 'package.json'),
      `${JSON.stringify(
        {
          name: 'superiu',
          productName: APP_NAME,
          version,
          private: true,
          type: 'module',
          main: 'dist/main.js'
        },
        null,
        2
      )}\n`,
      'utf-8'
    );

    // The Help menu opens these; shipping them keeps that action working in the
    // packaged app, where no repository checkout exists.
    const docs = path.join(REPO_ROOT, 'docs');
    if (fs.existsSync(docs)) {
      fs.cpSync(docs, path.join(staging, 'docs'), { recursive: true });
    }

    const placements: Placements = new Map();
    const seen = new Set<string>();
    fs.mkdirSync(stagingModules, { recursive: true });
    for (const entry of ENTRY_PACKAGES) {
      materialize(entry, PKG_DIR, stagingModules, stagingModules, placements, seen);
    }

    fs.rmSync(APP_RESOURCES, { recursive: true, force: true });
    run('/usr/bin/ditto', [staging, APP_RESOURCES]);
    log('resources', `${placements.size} package(s) → Contents/Resources/app/node_modules`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 6. Bundle assembly
// ---------------------------------------------------------------------------

function locateElectronApp(): string {
  const candidates = [
    path.join(PKG_DIR, 'node_modules', 'electron', 'dist', 'Electron.app'),
    path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // A clean CI runner may have the `electron` package installed without its
  // postinstall having run (frozen lockfile, `--ignore-scripts`, cache hits).
  // The package ships an `install.js` that downloads the binary; run it and
  // re-check before giving up.
  const installScripts = [
    path.join(PKG_DIR, 'node_modules', 'electron', 'install.js'),
    path.join(REPO_ROOT, 'node_modules', 'electron', 'install.js')
  ];
  const installScript = installScripts.find((script) => fs.existsSync(script));
  if (installScript) {
    log('electron', 'Runtime missing — downloading via install.js');
    execFileSync(process.execPath, [installScript], { stdio: 'inherit' });
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  fail(
    `Electron.app not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
      'Run `pnpm install` to download the Electron runtime.'
  );
}

function assembleBundle(version: string): void {
  if (process.platform !== 'darwin') {
    fail(`This bundler builds a macOS app and cannot run on ${process.platform}.`);
  }
  if (!fs.existsSync(ICON_ICNS)) {
    fail(`Icon missing: ${ICON_ICNS}\nRegenerate it from assets/icon.png (see README).`);
  }

  const electronApp = locateElectronApp();
  fs.rmSync(APP_PATH, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // `ditto` is the macOS-native way to copy a bundle: it preserves resource
  // forks, extended attributes and the symlinks inside the framework.
  run('/usr/bin/ditto', [electronApp, APP_PATH]);
  log('copy', `Electron.app → ${path.relative(REPO_ROOT, APP_PATH)}`);

  // Electron decides what to load from the executable's own name, and the
  // plist's CFBundleExecutable must agree with the file on disk.
  const macOsDir = path.join(CONTENTS, 'MacOS');
  fs.renameSync(path.join(macOsDir, 'Electron'), path.join(macOsDir, APP_NAME));
  log('executable', `Contents/MacOS/${APP_NAME}`);

  // `Resources/app` replaces the stub that makes Electron open its demo window.
  fs.rmSync(path.join(RESOURCES, 'default_app.asar'), { force: true });

  // Electron ships its own `electron.icns`; `CFBundleIconFile` no longer points
  // at it, and no helper bundle references it either, so it is 266 KB of dead
  // weight that would also be the icon a tool picked if it ignored the plist.
  fs.rmSync(path.join(RESOURCES, 'electron.icns'), { force: true });

  fs.copyFileSync(ICON_ICNS, path.join(RESOURCES, ICON_FILE));
  log('icon', `Contents/Resources/${ICON_FILE}`);

  writeBundleIdentity(version);
  writeHelperIdentity();
  writeAppResources(version);
}

/**
 * Re-sign ad-hoc.
 *
 * Editing `Info.plist` invalidates the seal Electron ships with, and a bundle
 * whose signature disagrees with its contents is refused by Gatekeeper and
 * reported as damaged by LaunchServices. An ad-hoc signature (`-`) carries no
 * identity requirements, which is the correct choice for a locally built app.
 */
function signBundle(): void {
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', APP_PATH]);
  run('/usr/bin/codesign', ['--verify', APP_PATH]);
  log('sign', 'ad-hoc signature verified');
}

// ---------------------------------------------------------------------------
// 7. Install + register
// ---------------------------------------------------------------------------

function installAndRegister(): void {
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.rmSync(INSTALLED_APP, { recursive: true, force: true });
  run('/usr/bin/ditto', [APP_PATH, INSTALLED_APP]);
  log('install', `~/Applications/${APP_NAME}.app`);

  // A locally built bundle is never quarantined, but a stale flag from an
  // earlier download would make Gatekeeper refuse it.
  run('/usr/bin/xattr', ['-cr', INSTALLED_APP]);
  log('quarantine', 'cleared');

  // LaunchServices must learn the bundle before Spotlight can resolve it, and
  // `mdimport` forces the metadata record rather than waiting for the indexer.
  run(LSREGISTER, ['-f', INSTALLED_APP]);
  log('launchservices', 'registered');

  try {
    run('/usr/bin/mdimport', [INSTALLED_APP]);
    log('spotlight', 'imported');
  } catch (error) {
    log('spotlight', `mdimport reported: ${String(error).split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------------------
// 8. Verification
// ---------------------------------------------------------------------------

function readPlistValue(plist: string, key: string): string {
  return run(PLUTIL, ['-extract', key, 'raw', '-o', '-', plist]).trim();
}

function verify(): void {
  const plist = path.join(INSTALLED_APP, 'Contents', 'Info.plist');

  const bundleName = readPlistValue(plist, 'CFBundleName');
  const bundleId = readPlistValue(plist, 'CFBundleIdentifier');
  if (bundleName !== APP_NAME) fail(`CFBundleName is "${bundleName}", expected "${APP_NAME}".`);
  if (bundleId !== BUNDLE_ID) fail(`CFBundleIdentifier is "${bundleId}", expected "${BUNDLE_ID}".`);
  log('verify', `CFBundleName=${bundleName} · CFBundleIdentifier=${bundleId}`);

  // `mdimport` returns before the metadata server has published the record, so
  // both queries are polled. A cold index can take a second or two; anything
  // longer means Spotlight genuinely has not picked the bundle up.
  const deadline = Date.now() + 10_000;
  let displayName = '';
  let indexed = false;
  for (;;) {
    displayName = run('/usr/bin/mdls', ['-name', 'kMDItemDisplayName', INSTALLED_APP])
      .split('=')
      .slice(1)
      .join('=')
      .trim();
    indexed = displayName.includes(APP_NAME);
    if (indexed || Date.now() > deadline) break;
    sleep(250);
  }
  log(
    'verify',
    indexed
      ? `Spotlight: kMDItemDisplayName=${displayName}`
      : `Spotlight has not indexed it (kMDItemDisplayName=${displayName || 'missing'})`
  );

  const found = run('/usr/bin/mdfind', [`kMDItemFSName == '${APP_NAME}.app'`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  log(
    'verify',
    found.includes(INSTALLED_APP)
      ? `mdfind resolves ~/Applications/${APP_NAME}.app`
      : `mdfind has not caught up (saw: ${found.join(', ') || 'nothing'})`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log(`\n=== Packaging ${APP_NAME}.app ===\n`);

  const { version } = JSON.parse(
    fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf-8')
  ) as { version: string };

  ensureBuilt();
  ensureIcon();
  assembleBundle(version);
  signBundle();

  if (INSTALL) {
    installAndRegister();
    verify();
  } else {
    log('bundle', `ready at ${path.relative(REPO_ROOT, APP_PATH)}`);
  }

  if (CREATE_ZIP) {
    const zipName = `${APP_NAME}-${version}-mac-${process.arch}.zip`;
    const zipPath = path.join(DIST_DIR, zipName);
    fs.rmSync(zipPath, { force: true });
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', APP_PATH, zipPath]);
    const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
    log('zip', `distribution archive ${path.relative(REPO_ROOT, zipPath)} (${sizeMb} MB)`);
  }

  console.log(`\n✓ ${APP_NAME} ${version} packaged${INSTALL ? ' and installed' : ''}.\n`);
}

main();

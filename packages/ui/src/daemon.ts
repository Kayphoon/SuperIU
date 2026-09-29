/**
 * `superiu-server` — the headless VPS daemon entrypoint.
 *
 * This module is a thin process wrapper around {@link startServer}: it resolves
 * CLI options, boots the SPA + WebSocket gateway on one HTTP server, and manages
 * a small state file so a second invocation (`status` / `stop`) can find the
 * running instance.
 *
 * Every subcommand prints exactly one machine-readable JSON line on stdout as
 * its LAST line, so the desktop client can parse the result without a protocol.
 *
 * The module is side-effect free when imported: {@link main} only runs under the
 * `import.meta.url === fileURLToPath(process.argv[1])` guard at the bottom, which
 * is also what makes it safe to `bun build --compile` into a standalone binary.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startServer } from './server.js';

/**
 * Module id bun resolves to the build-time asset bundle (see
 * `scripts/build-server-binary.mjs`). Injected as a `--define`; absent in a
 * plain `tsc` build, where the `server.ts` default `public/` directory is used.
 */
declare const SUPERIU_ASSET_MODULE: string | undefined;

const USAGE = `Usage: superiu-server <command> [options]

Commands:
  start    Boot the SuperIU web shell + WebSocket gateway
  status   Report whether a daemon is running in the workspace
  stop     Ask a running daemon to shut down
  token    Print a fresh 64-hex-character gateway token
  version  Print the package version

Options:
  --port <n>        Port to bind (start). Default: $PORT or 3000; 0 = ephemeral
  --host <h>        Interface to bind (start). Default: $HOST or 127.0.0.1
  --token <t>       Gateway token (start). Default: $SUPERIU_GATEWAY_TOKEN or random
  --workspace <dir> Workspace root owning .superiu/. Default: current directory
  -h, --help        Show this help`;

/** Name of the JSON state file written under `<workspace>/.superiu/`. */
const STATE_FILE_NAME = 'server.json';

const STATE_DIR_MODE = 0o700;
/**
 * The state file carries the gateway token, which is a bearer credential for
 * the whole gateway. It is created 0600, and an existing file is re-chmodded
 * after every write rather than trusted.
 */
const STATE_FILE_MODE = 0o600;

/** How long `stop` waits for a SIGTERM'd daemon to actually exit. */
const STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_MS = 100;

interface ParsedArgs {
  command: string | undefined;
  port?: number;
  host?: string;
  token?: string;
  workspace?: string;
  help: boolean;
}

/**
 * Hand-rolled flag parsing: the daemon ships as a single compiled binary, so it
 * must not drag an argument-parsing dependency into the bundle. Only the
 * `--flag value` and `--flag=value` spellings are accepted, which is what the
 * installer and systemd unit use.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: undefined, help: false };
  let index = 0;

  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    parsed.command = argv[0];
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }

    // Split on the first `=` only: a token may legitimately contain one.
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) return undefined;
      index += 1;
      return next;
    };

    switch (flag) {
      case '--port': {
        const value = takeValue();
        const parsedPort = Number.parseInt(value ?? '', 10);
        if (parsedPort === undefined || Number.isNaN(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
          throw new UsageError(`Invalid --port value: ${value ?? '(missing)'}`);
        }
        parsed.port = parsedPort;
        break;
      }
      case '--host': {
        const value = takeValue();
        if (!value) throw new UsageError('Missing value for --host');
        parsed.host = value;
        break;
      }
      case '--token': {
        const value = takeValue();
        if (!value) throw new UsageError('Missing value for --token');
        parsed.token = value;
        break;
      }
      case '--workspace': {
        const value = takeValue();
        if (!value) throw new UsageError('Missing value for --workspace');
        parsed.workspace = value;
        break;
      }
      default:
        throw new UsageError(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

/** A malformed command line: reported on stderr with usage, exit code 2. */
class UsageError extends Error {}

/** Resolve the workspace root; `--workspace` wins, else the current directory. */
function resolveWorkspace(workspace: string | undefined): string {
  return path.resolve(workspace ?? process.cwd());
}

function stateDir(workspace: string): string {
  return path.join(workspace, '.superiu');
}

function statePath(workspace: string): string {
  return path.join(stateDir(workspace), STATE_FILE_NAME);
}

interface DaemonState {
  pid: number;
  port: number;
  host: string;
  url: string;
  gatewayUrl?: string;
  token: string;
  version: string;
  startedAt: string;
}

/**
 * Build-time version injected by `scripts/build-server-binary.mjs` via bun's
 * `--define` (as the global `SUPERIU_BUILD_VERSION`). Absent in a plain `tsc`
 * build, where the `package.json` walk below takes over.
 */
declare const SUPERIU_BUILD_VERSION: string | undefined;

/**
 * Resolve the package version.
 *
 * A bun-compiled binary reports `import.meta.url` as `file:///$bunfs/root/...`,
 * so walking up from it can never reach the real `package.json`. The build
 * script therefore bakes the version in as a define; the walk below is the
 * fallback for `node dist/daemon.js` (and any embedder that skips the build
 * script). Both are guarded so a failure degrades to `'0.0.0'` rather than
 * throwing — a missing version must never stop the server.
 */
function resolveBakedVersion(): string | undefined {
  try {
    if (typeof SUPERIU_BUILD_VERSION === 'string' && SUPERIU_BUILD_VERSION) return SUPERIU_BUILD_VERSION;
  } catch {
    // The define was not applied (plain tsc build): fall through to the walk.
  }
  return undefined;
}

function resolveVersion(): string {
  const baked = resolveBakedVersion();
  if (baked) return baked;

  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return '0.0.0';
  }

  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const candidate = path.join(dir, 'package.json');
      const raw = fs.readFileSync(candidate, 'utf-8');
      const pkg = JSON.parse(raw) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch {
      // No readable package.json here (or unparseable): keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

/** A fresh 256-bit token. `crypto` is available in both Node and the bun binary. */
function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function writeState(workspace: string, state: DaemonState): string {
  const dir = stateDir(workspace);
  fs.mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  // mkdirSync's mode is only applied when the directory is created, and umask
  // can narrow it — force the exact mode so the token's directory stays private.
  try {
    fs.chmodSync(dir, STATE_DIR_MODE);
  } catch {
    // A filesystem that refuses chmod still gets the 0600 file below; do not
    // fail a boot over directory permissions.
  }
  const file = statePath(workspace);
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: STATE_FILE_MODE });
  try {
    fs.chmodSync(file, STATE_FILE_MODE);
  } catch {
    // Same rationale as the directory chmod above.
  }
  return file;
}

function removeState(workspace: string): void {
  try {
    fs.rmSync(statePath(workspace), { force: true });
  } catch {
    // A state file we cannot remove must not block shutdown.
  }
}

/** Read and validate the state file; `null` when missing, corrupt, or unknown shape. */
function readState(workspace: string): DaemonState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath(workspace), 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const pid = typeof record.pid === 'number' ? record.pid : Number.parseInt(String(record.pid ?? ''), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  return {
    pid,
    port: typeof record.port === 'number' ? record.port : 0,
    host: typeof record.host === 'string' ? record.host : '127.0.0.1',
    url: typeof record.url === 'string' ? record.url : '',
    gatewayUrl: typeof record.gatewayUrl === 'string' ? record.gatewayUrl : undefined,
    token: typeof record.token === 'string' ? record.token : '',
    version: typeof record.version === 'string' ? record.version : '0.0.0',
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : ''
  };
}

/** `true` while `pid` names a live process this user may signal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Materialize the SPA assets bundled into the binary, returning the directory
 * they were written to — or `undefined` when running from a plain `tsc` build,
 * where `server.ts`'s own `<package>/public` default is correct.
 *
 * Why this exists: a bun-compiled binary resolves `import.meta.url` to
 * `/$bunfs/root/<binary>`, so `server.ts`'s `path.resolve(HERE, '..', 'public')`
 * becomes `/$bunfs/public` — outside bun's embedded root and therefore ENOENT
 * for the `fs.statSync`/`createReadStream` calls `handleStatic` uses. Embedding
 * the files as base64 and writing them to a private temp dir keeps those calls
 * working against a real filesystem without changing `server.ts`'s public API.
 *
 * The directory lives for the process lifetime (removed on exit) and is created
 * 0700: it holds only shipped static assets, but the process may run as a
 * shared user.
 */
async function materializeEmbeddedAssets(): Promise<string | undefined> {
  let moduleId: string | undefined;
  try {
    // Undefined in a tsc build: the `typeof` guard never yields a ReferenceError here.
    if (typeof SUPERIU_ASSET_MODULE === 'string') moduleId = SUPERIU_ASSET_MODULE;
  } catch {
    moduleId = undefined;
  }
  // Absent under plain node/tsc: server.ts falls back to its own `public/`.
  if (!moduleId) return undefined;

  let assets: Record<string, string>;
  try {
    // The `import(SUPERIU_ASSET_MODULE)` spelling is deliberate and MUST stay
    // literal: bun only routes a dynamic import through the bundler's
    // `onResolve` hook when it can see the module specifier statically. Assigning
    // the define to a variable first defeats that and the virtual module is
    // looked up at runtime, where it does not exist. The `typeof` guard above
    // already proved the define is present, so this never throws a
    // ReferenceError inside the bundler's output.
    const mod = (await import(SUPERIU_ASSET_MODULE as string)) as { default?: Record<string, string> };
    if (!mod.default || typeof mod.default !== 'object') return undefined;
    assets = mod.default;
  } catch (err) {
    process.stderr.write(
      `superiu-server: could not load embedded assets: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return undefined;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-public-'));
  fs.chmodSync(dir, 0o700);
  try {
    for (const [name, base64] of Object.entries(assets)) {
      // Flatten any nested path, and refuse to escape the temp dir.
      const relative = name.split('/').filter((part) => part && part !== '.' && part !== '..').join(path.sep);
      if (!relative) continue;
      const target = path.join(dir, relative);
      if (!target.startsWith(dir + path.sep)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(base64, 'base64'));
    }
  } catch (err) {
    // A partial extraction is worse than none: fall back to server.ts's default.
    fs.rmSync(dir, { recursive: true, force: true });
    process.stderr.write(
      `superiu-server: could not extract embedded assets: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return undefined;
  }

  const cleanup = (): void => fs.rmSync(dir, { recursive: true, force: true });
  process.once('exit', cleanup);
  return dir;
}

async function commandStart(parsed: ParsedArgs): Promise<number> {
  const workspace = resolveWorkspace(parsed.workspace);
  const port = parsed.port ?? Number.parseInt(process.env.PORT ?? '3000', 10);
  const host = parsed.host ?? process.env.HOST ?? '127.0.0.1';
  const token = parsed.token ?? process.env.SUPERIU_GATEWAY_TOKEN ?? generateToken();
  const version = resolveVersion();

  const publicDir = await materializeEmbeddedAssets();

  const handle = await startServer({
    port,
    host,
    workspaceDir: workspace,
    gatewayToken: token,
    quiet: true,
    // Undefined lets server.ts use its own `public/` default (tsc build).
    ...(publicDir ? { publicDir } : {})
  });

  const state: DaemonState = {
    pid: process.pid,
    port: handle.port,
    host: handle.host,
    url: handle.url,
    gatewayUrl: handle.gatewayUrl,
    token,
    version,
    startedAt: new Date().toISOString()
  };

  let stateFile: string | null = null;
  try {
    stateFile = writeState(workspace, state);
  } catch (err) {
    // The server is up even if the state file could not be written; warn and
    // continue so the ready line (which the desktop parses) is still emitted.
    process.stderr.write(`superiu-server: could not write state file: ${(err as Error).message}\n`);
  }

  // Idempotent shutdown: a second signal during teardown is ignored rather than
  // racing a second `close()` or a second exit.
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void handle
      .close()
      .catch(() => undefined)
      .then(() => {
        if (stateFile) removeState(workspace);
        process.exit(0);
      });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  printJson({
    event: 'ready',
    pid: process.pid,
    port: handle.port,
    host: handle.host,
    url: handle.url,
    gatewayUrl: handle.gatewayUrl,
    token,
    version
  });
  // The literal prefix on the SAME line lets a caller that only greps stdout
  // find the payload without parsing every log line.
  process.stdout.write(
    `SUPERIU_READY ${JSON.stringify({
      pid: process.pid,
      port: handle.port,
      host: handle.host,
      url: handle.url,
      gatewayUrl: handle.gatewayUrl,
      token,
      version
    })}\n`
  );

  // Keep the event loop alive for the daemon's lifetime. The HTTP server holds
  // it open already; this promise never resolves until a signal fires.
  await new Promise<void>(() => {});
  return 0;
}

function commandStatus(parsed: ParsedArgs): number {
  const workspace = resolveWorkspace(parsed.workspace);
  const state = readState(workspace);

  if (!state || !isAlive(state.pid)) {
    // A stale state file is reported as not-running and left in place: removing
    // it here would race a daemon that is merely slow to write its own.
    printJson({ running: false });
    return 1;
  }

  printJson({
    running: true,
    pid: state.pid,
    port: state.port,
    host: state.host,
    url: state.url,
    gatewayUrl: state.gatewayUrl,
    version: state.version,
    startedAt: state.startedAt
  });
  return 0;
}

async function commandStop(parsed: ParsedArgs): Promise<number> {
  const workspace = resolveWorkspace(parsed.workspace);
  const state = readState(workspace);

  if (!state || !isAlive(state.pid)) {
    printJson({ stopped: false });
    return 1;
  }

  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    // Raced with the process exiting on its own; fall through to the wait loop.
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(state.pid)) {
      removeState(workspace);
      printJson({ stopped: true, pid: state.pid });
      return 0;
    }
    await sleep(STOP_POLL_MS);
  }

  printJson({ stopped: false, pid: state.pid });
  return 1;
}

function commandToken(): number {
  printJson({ token: generateToken() });
  return 0;
}

function commandVersion(): number {
  printJson({ version: resolveVersion() });
  return 0;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Dispatch a command. Exported so an embedder (or a test) can drive it without
 * going through `process.argv`, and to keep the import-side-effect-free rule.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (!parsed.command) {
    process.stderr.write(`superiu-server: missing command\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    switch (parsed.command) {
      case 'start':
        process.exitCode = await commandStart(parsed);
        return;
      case 'status':
        process.exitCode = commandStatus(parsed);
        return;
      case 'stop':
        process.exitCode = await commandStop(parsed);
        return;
      case 'token':
        process.exitCode = commandToken();
        return;
      case 'version':
        process.exitCode = commandVersion();
        return;
      default:
        process.stderr.write(`superiu-server: unknown command '${parsed.command}'\n\n${USAGE}\n`);
        process.exitCode = 2;
        return;
    }
  } catch (err) {
    // A boot failure (port in use, bad bind address) is a runtime error, not a
    // usage one: report it plainly and exit non-zero without a raw stack trace.
    process.stderr.write(`superiu-server: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

// Standalone guard: importing this module must do nothing. Compares against the
// `file://` form of argv[1] so it works under every path spelling.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

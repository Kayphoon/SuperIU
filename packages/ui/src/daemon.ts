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
import { execFileSync, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyDelta, DELTA_HEADER_SIZE, parseDeltaHeader, sha256File, type DeltaHeader } from './delta.js';
import { PairingStore } from './auth/store.js';
import { startServer, type ServerHandle } from './server.js';

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
  update   Upgrade the installed binary from GitHub Releases
  token    Print a fresh 64-hex-character gateway token
  pair     Mint a one-time web-console pairing link (or --list / --revoke / --rename)
  version  Print the package version

Options:
  --port <n>        Port to bind (start). Default: $PORT or 3000; 0 = ephemeral
  --host <h>        Interface to bind (start). Default: $HOST or 127.0.0.1
  --socket <path>   Listen on a Unix domain socket instead of --port/--host (start)
  --token <t>       Gateway token (start). Default: $SUPERIU_GATEWAY_TOKEN or random
  --workspace <dir> Workspace root owning .superiu/. Default: current directory
  --url <base>      Advertised origin for 'pair' (e.g. https://host:3000)
  --name <label>    'pair': device name for minted code (or for --rename)
  --list            'pair': list active pairing keys instead of minting
  --revoke <id>     'pair': revoke the key with this id
  --rename <id>     'pair': rename an existing key to --name <label>
  -h, --help        Show this help

Auto-update options:
  --auto-update-idle            Periodically update from GitHub Releases when idle
                                ($SUPERIU_AUTO_UPDATE_IDLE=1)
  --no-auto-update-idle         Explicitly disable idle auto-update and forget any
                                persisted setting ($SUPERIU_AUTO_UPDATE_IDLE=0)
  --auto-update-interval-hours <n>
                                Check interval in hours. Default: $SUPERIU_AUTO_UPDATE_INTERVAL_HOURS or 6

Update options:
  --check               Report whether an update is available, then exit
  --force               Upgrade even when the latest version is not newer
  --version <v>         Upgrade to this exact version instead of the latest release
  --release-base <url>  Release download base. Default: $SUPERIU_RELEASE_BASE or
                        https://github.com/Kayphoon/SuperIU/releases/latest/download
  --target <path>       Binary to replace. Default: the running superiu-server binary`;

/** Name of the JSON state file written under `<workspace>/.superiu/`. */
const STATE_FILE_NAME = 'server.json';

const STATE_DIR_MODE = 0o700;
/**
 * The state file carries the gateway token, which is a bearer credential for
 * the whole gateway. It is created 0600, and an existing file is re-chmodded
 * after every write rather than trusted.
 */
const STATE_FILE_MODE = 0o600;

/** Hours between idle update checks when neither the flag nor the state names one. */
const DEFAULT_AUTO_UPDATE_INTERVAL_HOURS = 1;

/** How long `stop` waits for a SIGTERM'd daemon to actually exit. */
const STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_MS = 100;

interface ParsedArgs {
  command: string | undefined;
  port?: number;
  host?: string;
  /** `--socket <path>`: listen on a Unix domain socket instead of TCP. */
  socketPath?: string;
  token?: string;
  workspace?: string;
  /** Periodically update from GitHub Releases when idle. */
  autoUpdateIdle: boolean;
  /**
   * `--no-auto-update-idle`: an explicit OFF. Distinguished from the default
   * "no opinion" so an operator can switch the feature off without the
   * persisted `true` resurrecting it on the next flagless start.
   */
  noAutoUpdateIdle?: boolean;
  /** Hours between idle update checks. Default 6. */
  autoUpdateIntervalHours: number;
  /** `update --check`: report availability only, never download. */
  check: boolean;
  /** `update --force`: upgrade even when the latest version is not newer. */
  force: boolean;
  /** `update --version <v>`: pin the release tag instead of tracking latest. */
  version?: string;
  /** `update --release-base <url>`: override the release download base. */
  releaseBase?: string;
  /** `update --target <path>`: binary to replace instead of `process.execPath`. */
  target?: string;
  /** `pair --list`: list active keys instead of minting a code. */
  list: boolean;
  /** `pair --revoke <id>`: revoke the key with this id. */
  revoke?: string;
  /** `pair --url <base>`: advertised origin for the connect URL. */
  advertiseUrl?: string;
  /** `pair --name <label>` or `--label <label>`: device label. */
  label?: string;
  /** `pair --rename <id>`: rename key to label. */
  rename?: string;
  help: boolean;
}

/**
 * Hand-rolled flag parsing: the daemon ships as a single compiled binary, so it
 * must not drag an argument-parsing dependency into the bundle. Only the
 * `--flag value` and `--flag=value` spellings are accepted, which is what the
 * installer and systemd unit use.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const envAutoUpdate = parseTriStateEnv(process.env.SUPERIU_AUTO_UPDATE_IDLE) === true;
  let autoUpdateIntervalHours = DEFAULT_AUTO_UPDATE_INTERVAL_HOURS;
  const envInterval = process.env.SUPERIU_AUTO_UPDATE_INTERVAL_HOURS;
  if (envInterval !== undefined && envInterval.trim() !== '') {
    const parsedInterval = Number(envInterval);
    if (!Number.isFinite(parsedInterval) || parsedInterval <= 0) {
      throw new UsageError(`Invalid SUPERIU_AUTO_UPDATE_INTERVAL_HOURS: ${envInterval}`);
    }
    autoUpdateIntervalHours = parsedInterval;
  }
  const parsed: ParsedArgs = {
    command: undefined,
    autoUpdateIdle: envAutoUpdate,
    autoUpdateIntervalHours,
    check: false,
    force: false,
    list: false,
    help: false
  };
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
      case '--socket': {
        const value = takeValue();
        if (!value) throw new UsageError('Missing value for --socket');
        parsed.socketPath = value;
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
      case '--check': {
        parsed.check = true;
        break;
      }
      case '--force': {
        parsed.force = true;
        break;
      }
      case '--version': {
        const value = takeValue();
        if (!value) throw new UsageError('Missing value for --version');
        parsed.version = value;
        break;
      }
      case '--release-base': {
        const value = takeValue();
        if (!value) throw new UsageError('Missing value for --release-base');
        parsed.releaseBase = value;
        break;
      }
      case '--target': {
        const value = takeValue();
        if (!value) throw new UsageError('Missing value for --target');
        parsed.target = value;
        break;
      }
      case '--list': {
        parsed.list = true;
        break;
      }
      case '--revoke': {
        const value = takeValue();
        if (!value) throw new UsageError('Missing value for --revoke');
        parsed.revoke = value;
        break;
      }
      case '--rename': {
        const value = takeValue();
        if (!value) throw new UsageError('Missing value for --rename');
        parsed.rename = value;
        break;
      }
      case '--name':
      case '--label': {
        const value = takeValue();
        if (!value) throw new UsageError(`Missing value for ${arg}`);
        parsed.label = value;
        break;
      }
      case '--url': {
        const value = takeValue();
        if (!value) throw new UsageError('Missing value for --url');
        parsed.advertiseUrl = value;
        break;
      }
      case '--auto-update-idle': {
        if (inlineValue !== undefined) {
          parsed.autoUpdateIdle = /^(1|true|yes)$/i.test(inlineValue);
        } else {
          parsed.autoUpdateIdle = true;
        }
        break;
      }
      case '--no-auto-update-idle': {
        parsed.noAutoUpdateIdle = true;
        break;
      }
      case '--auto-update-interval-hours': {
        const value = takeValue();
        const parsedInterval = Number(value ?? '');
        if (value === undefined || !Number.isFinite(parsedInterval) || parsedInterval <= 0) {
          throw new UsageError(`Invalid --auto-update-interval-hours value: ${value ?? '(missing)'}`);
        }
        parsed.autoUpdateIntervalHours = parsedInterval;
        break;
      }
      default:
        throw new UsageError(`Unknown option: ${arg}`);
    }
  }

  // A command line that contradicts itself is a usage bug, not a last-one-wins
  // decision: reject it instead of silently honouring whichever flag came last.
  if (parsed.autoUpdateIdle && parsed.noAutoUpdateIdle) {
    throw new UsageError('--auto-update-idle and --no-auto-update-idle are mutually exclusive');
  }

  return parsed;
}

/**
 * Parse a tri-state boolean spelling from the environment.
 *
 * `1|true|yes` -> explicit ON, `0|false|no` -> explicit OFF, anything else
 * (including unset or empty) -> `undefined`, meaning "no opinion". The OFF
 * spellings matter: without them an operator could turn the feature on through
 * the environment but never off, since an unset variable is indistinguishable
 * from an explicit `false`.
 */
function parseTriStateEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (/^(1|true|yes)$/.test(value)) return true;
  if (/^(0|false|no)$/.test(value)) return false;
  return undefined;
}

/** The inputs the idle auto-update settings are resolved from. */
export interface AutoUpdateResolutionInputs {
  /** `--auto-update-idle` (or a truthy `SUPERIU_AUTO_UPDATE_IDLE`). */
  autoUpdateIdle: boolean;
  /** `--no-auto-update-idle`: an explicit OFF. */
  noAutoUpdateIdle?: boolean;
  /** `--auto-update-interval-hours <n>`, if given. */
  autoUpdateIntervalHours?: number;
  /** `--release-base <url>`, if given. */
  releaseBase?: string;
}

/** The idle auto-update settings a `start` boots with, and what to persist. */
export interface AutoUpdateSettings {
  /** Whether the idle self-update loop runs for this boot. */
  enabled: boolean;
  /** Hours between checks; the flag, else the persisted value, else 6. */
  intervalHours: number;
  /** Release download base; the flag, else the persisted value, else `undefined`. */
  releaseBase: string | undefined;
  /**
   * The caller must delete `autoUpdateIdle` and `autoUpdateIntervalHours` from
   * the state file it writes: an explicit OFF is authoritative, and a leftover
   * `true` would resurrect the feature on the next flagless start.
   */
  clearPersisted: boolean;
}

/**
 * Resolve the idle auto-update settings with the precedence CLI > env >
 * persisted, as a pure function so every combination is unit-testable without
 * booting a daemon.
 *
 * The environment sits ABOVE the persisted value on purpose: a systemd unit
 * cannot pass CLI flags, so `EnvironmentFile` is the operator's configuration
 * channel and must be able to override what a previous desktop session wrote.
 *
 * `autoUpdateIdle` and `noAutoUpdateIdle` are mutually exclusive; `parseArgs`
 * rejects the combination before it reaches here.
 */
export function resolveAutoUpdateSettings(
  parsed: AutoUpdateResolutionInputs,
  existingState: Pick<DaemonState, 'autoUpdateIdle' | 'autoUpdateIntervalHours' | 'releaseBase'> | null | undefined,
  env: string | undefined
): AutoUpdateSettings {
  const envTri = parseTriStateEnv(env);
  // CLI > env > persisted. An explicit OFF wins outright; an explicit ON (flag
  // or truthy env) beats the persisted value; only when neither is expressed
  // does the persisted setting become the default. `clearPersisted` follows the
  // signal that actually won: a flag saying ON is not overridden by a falsy env.
  let enabled: boolean;
  let clearPersisted = false;
  if (parsed.noAutoUpdateIdle) {
    enabled = false;
    clearPersisted = true;
  } else if (parsed.autoUpdateIdle || envTri === true) {
    enabled = true;
  } else if (envTri === false) {
    enabled = false;
    clearPersisted = true;
  } else {
    enabled = existingState?.autoUpdateIdle === true;
  }

  const intervalHours = parsed.autoUpdateIdle
    ? parsed.autoUpdateIntervalHours ?? DEFAULT_AUTO_UPDATE_INTERVAL_HOURS
    : existingState?.autoUpdateIntervalHours ?? DEFAULT_AUTO_UPDATE_INTERVAL_HOURS;

  return {
    enabled,
    intervalHours,
    // Same precedence as the tick and `update`: the flag wins, else the
    // persisted base, else the tick falls back to the env / public default.
    releaseBase: parsed.releaseBase ?? existingState?.releaseBase,
    clearPersisted
  };
}

/** A malformed command line: reported on stderr with usage, exit code 2. */
class UsageError extends Error {}

/** Resolve the workspace root; `--workspace` wins, else the current directory. */
function resolveWorkspace(workspace: string | undefined): string {
  return path.resolve(workspace ?? process.cwd());
}

/**
 * Resolve the workspace of the daemon that is *actually running*, for a command
 * that was not told where it lives.
 *
 * The desktop app provisions its remote daemon with a fixed workspace —
 * `packages/desktop/src/remote/bootstrap.ts` starts it with
 * `--workspace "$HOME/.superiu/workspace"` — so a daemon started by the desktop
 * is invisible to an updater run from any other directory. Candidates are
 * therefore probed in this order and the first one holding a LIVE daemon wins:
 *
 *   1. an explicit `--workspace`,
 *   2. `$HOME/.superiu/workspace` (the desktop layout above),
 *   3. the current directory (the pre-existing behaviour),
 *   4. `$HOME` (a systemd unit starts the daemon with `WorkingDirectory=%h`).
 *
 * Only `update` resolves this way. `status` / `stop` keep resolving strictly
 * from `--workspace`: their callers (the installer, the desktop) always pass
 * one and must never be answered about a different daemon. When no candidate is
 * live, the workspace `update` would have used before probing (the explicit
 * value, else cwd) is returned, so single-shot behaviour is unchanged.
 */
function resolveLiveWorkspace(explicit: string | undefined): string {
  if (explicit !== undefined) return path.resolve(explicit);

  const home = process.env.HOME ?? '';
  const candidates = [home ? path.join(home, '.superiu', 'workspace') : '', process.cwd(), home];

  const probed = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (probed.has(resolved)) continue;
    probed.add(resolved);

    const state = readState(resolved);
    if (state && isAlive(state.pid)) return resolved;
  }

  return resolveWorkspace(explicit);
}

function stateDir(workspace: string): string {
  return path.join(workspace, '.superiu');
}

function statePath(workspace: string): string {
  return path.join(stateDir(workspace), STATE_FILE_NAME);
}

/** Pairing credential store written under `<workspace>/.superiu/`. */
function pairingPath(workspace: string): string {
  return path.join(stateDir(workspace), 'pairing.json');
}

/** Name of the JSON update state file written under `<workspace>/.superiu/`. */
const UPDATE_STATE_FILE_NAME = 'update-state.json';

function updateStatePath(workspace: string): string {
  return path.join(stateDir(workspace), UPDATE_STATE_FILE_NAME);
}

export interface UpdateBackoffState {
  lastCheckAt?: string;
  lastFailedAt?: string;
  lastFailedVersion?: string;
}

/** Read and validate the update state file; `{}` when missing, corrupt, or unknown shape. */
export function readUpdateState(workspace: string): UpdateBackoffState {
  let raw: string;
  try {
    raw = fs.readFileSync(updateStatePath(workspace), 'utf-8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const result: UpdateBackoffState = {};
  if (typeof record.lastCheckAt === 'string') result.lastCheckAt = record.lastCheckAt;
  if (typeof record.lastFailedAt === 'string') result.lastFailedAt = record.lastFailedAt;
  if (typeof record.lastFailedVersion === 'string') result.lastFailedVersion = record.lastFailedVersion;
  return result;
}

/** Write the update state file with 0600 mode; never throws. */
export function writeUpdateState(workspace: string, state: UpdateBackoffState): string {
  const dir = stateDir(workspace);
  fs.mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  try {
    fs.chmodSync(dir, STATE_DIR_MODE);
  } catch {
    // A filesystem that refuses chmod still gets the 0600 file below
  }
  const file = updateStatePath(workspace);
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: STATE_FILE_MODE });
  try {
    fs.chmodSync(file, STATE_FILE_MODE);
  } catch {
    // Same rationale as the directory chmod above
  }
  return file;
}

const BACKOFF_WINDOW_MS = 24 * 60 * 60 * 1000;

/** True when candidate matches last failed version within the 24h backoff window. */
export function isBackoffBlocked(
  state: UpdateBackoffState,
  candidate: string,
  now: number = Date.now()
): boolean {
  if (state.lastFailedVersion !== candidate) return false;
  if (!state.lastFailedAt) return false;
  const failedAt = Date.parse(state.lastFailedAt);
  if (Number.isNaN(failedAt)) return false;
  return now - failedAt < BACKOFF_WINDOW_MS;
}

interface DaemonState {
  pid: number;
  port: number;
  host: string;
  url: string;
  /** Absolute Unix domain socket path when the daemon listens on one. */
  socketPath?: string;
  gatewayUrl?: string;
  /** Absolute workspace root owning the `.superiu/` state directory. */
  workspace: string;
  token: string;
  version: string;
  startedAt: string;
  /**
   * The idle self-update settings this daemon was started with. Persisted so a
   * self-update respawn — a fresh process that cannot inherit the parent's CLI
   * flags — can replay them; env-var driven runs need no replay, but recording
   * them keeps the file an accurate description of the running daemon.
   * Absent in a state file written by a build that predates the fields.
   */
  autoUpdateIdle?: boolean;
  autoUpdateIntervalHours?: number;
  /**
   * The release download base the daemon was started with (`--release-base`),
   * persisted so a self-update respawn — a fresh process that cannot inherit the
   * parent's CLI flags — can replay it. Without this, an idle tick started from a
   * private mirror would silently upgrade from the default GitHub base, which is
   * the wrong release channel. Absent in a state file written by a build that
   * predates the field.
   */
  releaseBase?: string;
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

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------
//
// A deliberately tiny reimplementation of the precedence rules in
// `packages/desktop/src/updater.ts`. It cannot be imported: that module pulls in
// `electron` at module scope, which would both break the daemon under plain node
// and drag Electron into the standalone binary.

/** A parsed `major.minor.patch` (with optional pre-release) tuple. */
interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers, e.g. `['rc', '1']`; empty for a stable release. */
  prerelease: string[];
}

/**
 * Parse a semver-ish string, tolerating a leading `v` and a missing
 * minor/patch (e.g. `1` -> `1.0.0`). Returns `null` for anything without a
 * leading numeric component — which is what keeps the rolling `latest` tag from
 * ever being mistaken for a version.
 */
function parseVersion(raw: string | undefined | null): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^v/i, '');
  if (!trimmed) return null;

  // Split off build metadata (`+...`), which does not participate in precedence.
  const withoutBuild = trimmed.split('+', 1)[0] ?? '';
  const [core = '', ...preParts] = withoutBuild.split('-');
  const segments = core.split('.');

  if (!/^\d+$/.test(segments[0] ?? '')) return null;

  const major = Number.parseInt(segments[0] ?? '0', 10);
  const minor = /^\d+$/.test(segments[1] ?? '') ? Number.parseInt(segments[1] as string, 10) : 0;
  const patch = /^\d+$/.test(segments[2] ?? '') ? Number.parseInt(segments[2] as string, 10) : 0;

  const prerelease = preParts.length > 0 && preParts[0] ? preParts[0].split('.') : [];

  return { major, minor, patch, prerelease };
}

/** Compare two dot-separated pre-release identifier lists per semver §11. */
function comparePrerelease(a: string[], b: string[]): number {
  // A version WITHOUT a pre-release is HIGHER than one with (1.0.0 > 1.0.0-rc.1).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1; // shorter list is lower (1.0.0-alpha < 1.0.0-alpha.1)
    if (right === undefined) return 1;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);

    if (leftNumeric && rightNumeric) {
      const diff = Number.parseInt(left, 10) - Number.parseInt(right, 10);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (leftNumeric) {
      return -1; // numeric identifiers are lower than alphanumeric
    } else if (rightNumeric) {
      return 1;
    } else if (left !== right) {
      return left > right ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Standard semver precedence: `true` when `remote` is strictly newer than
 * `current`. Unparseable inputs compare as not-newer, so a malformed tag can
 * never trigger an update.
 */
function semverGt(remote: string | undefined | null, current: string | undefined | null): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(current);
  if (!a || !b) return false;

  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  return comparePrerelease(a.prerelease, b.prerelease) > 0;
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
    // Absent in a state file written by a build predating socket support.
    socketPath: typeof record.socketPath === 'string' && record.socketPath ? record.socketPath : undefined,
    gatewayUrl: typeof record.gatewayUrl === 'string' ? record.gatewayUrl : undefined,
    // Absent in a state file written by a pre-`workspace` build: default to the
    // directory the file was read from so the field is never empty.
    workspace: typeof record.workspace === 'string' && record.workspace ? record.workspace : path.resolve(workspace),
    token: typeof record.token === 'string' ? record.token : '',
    version: typeof record.version === 'string' ? record.version : '0.0.0',
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    // Tolerated as absent: state files written before the fields existed (and
    // by builds without auto-update) simply carry no auto-update settings.
    autoUpdateIdle: record.autoUpdateIdle === true ? true : undefined,
    autoUpdateIntervalHours:
      typeof record.autoUpdateIntervalHours === 'number' && record.autoUpdateIntervalHours > 0
        ? record.autoUpdateIntervalHours
        : undefined,
    // Absent in a state file written before the field existed; `undefined` makes
    // the tick fall back to `SUPERIU_RELEASE_BASE` / the default base.
    releaseBase: typeof record.releaseBase === 'string' && record.releaseBase ? record.releaseBase : undefined
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

/** One-line rendering of a thrown value for the user-facing stderr messages. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * SIGTERM a live daemon and wait, bounded, for it to actually exit. Shared by
 * `start`'s stale-binary takeover and the `update` restart path.
 */
async function terminateAndWait(pid: number, timeoutMs: number = STOP_TIMEOUT_MS): Promise<boolean> {
  if (!isAlive(pid)) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Raced with the process exiting on its own; the wait loop below settles it.
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(STOP_POLL_MS);
  }
  return !isAlive(pid);
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

  // Read BEFORE the takeover block below, which may `removeState(workspace)`:
  // the auto-update settings of the daemon this process replaces are the
  // defaults for this boot (see the persistence block further down).
  const existingState = readState(workspace);

  // A freshly-upgraded binary takes over from the daemon it replaced: an old
  // process still holding the port would keep serving the old build, so stop it
  // before binding. No-op when nothing is running or the version already matches.
  if (
    existingState &&
    existingState.pid !== process.pid &&
    existingState.version !== version &&
    isAlive(existingState.pid)
  ) {
    process.stderr.write(
      `superiu-server: replacing running daemon pid ${existingState.pid} (version ${existingState.version} -> ${version})\n`
    );
    const exited = await terminateAndWait(existingState.pid);
    if (!exited) {
      process.stderr.write(`superiu-server: daemon pid ${existingState.pid} did not exit; continuing anyway\n`);
    }
    removeState(workspace);
  }

  const publicDir = await materializeEmbeddedAssets();

  const handle = await startServer({
    // A Unix socket and a TCP port are independent listeners: passing both makes
    // the server dual-listen, so a `--socket` daemon still serves browsers on
    // `--port`/`--host`. With `--socket` alone, `port` defaults and the TCP
    // listener comes up alongside the socket; `--port 0` keeps it socket-only.
    port,
    host,
    ...(parsed.socketPath ? { socketPath: parsed.socketPath } : {}),
    workspaceDir: workspace,
    gatewayToken: token,
    quiet: true,
    // Undefined lets server.ts use its own `public/` default (tsc build).
    ...(publicDir ? { publicDir } : {}),
    // Reported by `/api/status` and the gateway handshake.
    version
  });

  const state: DaemonState = {
    pid: process.pid,
    port: handle.port,
    host: handle.host,
    url: handle.url,
    socketPath: handle.socketPath,
    gatewayUrl: handle.gatewayUrl,
    workspace,
    token,
    version,
    startedAt: new Date().toISOString()
  };

  // The persisted settings of the daemon being replaced are the DEFAULT: a
  // restart that does not repeat the flag must not silently turn auto-update
  // off. An explicit ON (`--auto-update-idle` / `SUPERIU_AUTO_UPDATE_IDLE=1`)
  // turns it on; an explicit OFF (`--no-auto-update-idle` /
  // `SUPERIU_AUTO_UPDATE_IDLE=0`) turns it off AND forgets the persisted
  // settings, so the next flagless start cannot resurrect them.
  const autoUpdate = resolveAutoUpdateSettings(parsed, existingState, process.env.SUPERIU_AUTO_UPDATE_IDLE);
  const autoUpdateEnabled = autoUpdate.enabled;
  const autoUpdateIntervalHours = autoUpdate.intervalHours;
  const releaseBase = autoUpdate.releaseBase;

  // An explicit OFF must DELETE the keys, not write `false`: `readState` treats
  // a non-`true` value as absent, but a `false` on disk would be a shape change
  // and a leftover `true` would re-enable the feature on the next boot.
  if (autoUpdate.clearPersisted) {
    delete state.autoUpdateIdle;
    delete state.autoUpdateIntervalHours;
  } else if (autoUpdateEnabled) {
    // Recorded so the self-update respawn — a fresh process that cannot inherit
    // these flags — can replay them. Written only when the feature is on, so a
    // default boot still produces a state file identical to the old shape.
    state.autoUpdateIdle = true;
    state.autoUpdateIntervalHours = autoUpdateIntervalHours;
  }
  // Same rationale as the auto-update settings above: only written when there
  // is a base to remember, so a default boot keeps the old state file shape.
  if (releaseBase) {
    state.releaseBase = releaseBase;
  }

  handle.setUpdateHooks({
    onCheckUpdate: async () => {
      const assetName = ARCH_ASSETS[process.arch];
      if (!assetName) {
        return {
          current: version,
          hasUpdate: false,
          canUpdate: false,
          error: `unsupported architecture '${process.arch}'`
        };
      }
      const base = (state.releaseBase ?? process.env.SUPERIU_RELEASE_BASE ?? DEFAULT_RELEASE_BASE).replace(/\/+$/, '');
      let latest: string | undefined;
      try {
        latest = await fetchLatestVersion(assetName);
      } catch (err) {
        return {
          current: version,
          hasUpdate: false,
          canUpdate: true,
          error: describeError(err)
        };
      }
      return {
        current: version,
        latest,
        hasUpdate: Boolean(latest && semverGt(latest, version)),
        canUpdate: true
      };
    },
    onApplyUpdate: async () => {
      await runUpdateTick(handle, state, workspace, process.execPath, { ignoreBackoff: true });
      return { updated: true, current: version };
    }
  });

  let stateFile: string | null = null;
  try {
    stateFile = writeState(workspace, state);
  } catch (err) {
    // The server is up even if the state file could not be written; warn and
    // continue so the ready line (which the desktop parses) is still emitted.
    process.stderr.write(`superiu-server: could not write state file: ${(err as Error).message}\n`);
  }

  let updateTimer: NodeJS.Timeout | undefined;
  if (autoUpdateEnabled) {
    const execName = path.basename(process.execPath);
    if (execName !== 'superiu-server') {
      process.stderr.write(
        `superiu-server: auto-update disabled: running binary is '${execName}', not 'superiu-server'\n`
      );
    } else {
      const intervalMs = autoUpdateIntervalHours * 60 * 60 * 1000;
      updateTimer = startIdleUpdateLoop(handle, state, workspace, intervalMs);
    }
  }

  // Idempotent shutdown: a second signal during teardown is ignored rather than
  // racing a second `close()` or a second exit.
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = undefined;
    }
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
    socketPath: handle.socketPath,
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
      socketPath: handle.socketPath,
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
    socketPath: state.socketPath,
    gatewayUrl: state.gatewayUrl,
    workspace: state.workspace,
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

/**
 * Resolve the origin to embed in a connect URL.
 *
 * `--url` wins. Otherwise the running daemon's own URL is used, but a wildcard
 * bind (`0.0.0.0` / `::`) is not a browsable address, so it is replaced with
 * `127.0.0.1`. A Unix-socket daemon has no TCP URL, so the operator should pass
 * `--url`; the fallback keeps the command useful for the common TCP case.
 */
function advertiseBase(parsed: ParsedArgs, state: DaemonState | null): string {
  if (parsed.advertiseUrl) return parsed.advertiseUrl.replace(/\/+$/, '');
  const envHost =
    process.env.HOST && !['0.0.0.0', '::'].includes(process.env.HOST) ? process.env.HOST : '127.0.0.1';
  if (state && !state.socketPath && state.host && !['0.0.0.0', '::'].includes(state.host)) {
    return `http://${state.host}:${state.port}`;
  }
  const port = state?.port || Number.parseInt(process.env.PORT ?? '3000', 10);
  return `http://${envHost}:${port}`;
}

/**
 * `pair`: mint a one-time pairing link, or manage existing keys.
 *
 * The code is written straight into the workspace store. The running daemon
 * re-reads that file when its mtime changes, so an offline mint is picked up
 * without a restart or a control channel.
 */
function commandPair(parsed: ParsedArgs): number {
  const workspace = resolveWorkspace(parsed.workspace);
  const store = new PairingStore(pairingPath(workspace));
  const state = readState(workspace);
  const running = Boolean(state && isAlive(state.pid));

  if (parsed.list) {
    const keys = store.list();
    if (keys.length === 0) {
      process.stdout.write('No pairing keys.\n');
    } else {
      for (const key of keys) {
        process.stdout.write(
          `${key.id}  ${key.label}  created ${key.createdAt}  last used ${key.lastUsedAt}  expires ${key.expiresAt}\n`
        );
      }
    }
    printJson({ keys, running });
    return 0;
  }

  if (parsed.revoke) {
    const revoked = store.revoke(parsed.revoke);
    printJson({ revoked, id: parsed.revoke });
    return revoked ? 0 : 1;
  }

  if (parsed.rename) {
    if (!parsed.label) {
      throw new UsageError('--rename requires --name <new-name> or --label <new-name>');
    }
    const updated = store.updateLabel(parsed.rename, parsed.label);
    if (updated) {
      process.stdout.write(`Renamed pairing key ${parsed.rename} to "${parsed.label}".\n`);
    } else {
      process.stderr.write(`Pairing key not found: ${parsed.rename}\n`);
    }
    printJson({ renamed: updated, id: parsed.rename, label: parsed.label });
    return updated ? 0 : 1;
  }

  const base = advertiseBase(parsed, state);
  const minted = store.mintCode(parsed.label);
  const url = `${base}/auth/connect/${minted.raw}`;
  const labelSuffix = minted.label ? ` (device: "${minted.label}")` : '';
  process.stdout.write(`Pairing link${labelSuffix}: ${url}\n`);
  process.stdout.write('This link works once and expires in 5 minutes.\n');
  if (running) {
    process.stdout.write('The running daemon serves this link immediately.\n');
  } else {
    process.stdout.write(
      'Start the daemon (superiu-server start), then open the link; it picks the code up automatically.\n'
    );
  }
  printJson({ code: minted.raw, url, expiresAt: minted.expiresAt, label: minted.label });
  return 0;
}

function commandVersion(): number {
  printJson({ version: resolveVersion() });
  return 0;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/** GitHub repository owning the released server binaries. Mirrors REPO_SLUG. */
const REPO_SLUG = 'Kayphoon/SuperIU';

/** Default release download base; mirrors `scripts/install.sh`. */
const DEFAULT_RELEASE_BASE = `https://github.com/${REPO_SLUG}/releases/latest/download`;

/** Asset name suffix per `process.arch`; mirrors `scripts/install.sh`. */
const ARCH_ASSETS: Record<string, string> = {
  x64: 'superiu-server-linux-x64',
  arm64: 'superiu-server-linux-arm64'
};

/**
 * Suffix of the delta patch published beside each release binary, so the asset
 * for `superiu-server-linux-x64` is `superiu-server-linux-x64.patch`. Appending
 * it to the *full* download URL keeps the same layout for both the rolling
 * `.../releases/latest/download/<asset>` base and the pinned
 * `.../releases/download/v<version>/<asset>` base.
 */
const PATCH_SUFFIX = '.patch';

/** How long a single GitHub API request may take before it is aborted. */
const FETCH_TIMEOUT_MS = 30_000;

/** How long a release asset download may take before it is aborted. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Shape of the GitHub release fields this file consumes. */
interface GithubRelease {
  tag_name?: string;
  assets?: { name?: string }[];
}

/** A `fetch` that always carries a User-Agent and never hangs forever. */
async function fetchWithTimeout(url: string, accept?: string): Promise<Response> {
  const headers: Record<string, string> = { 'User-Agent': 'superiu-server-updater' };
  if (accept) headers.Accept = accept;
  return await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * Strip a leading `v` from a release tag and return it only when the remainder
 * is a real version; `undefined` otherwise. The rolling channel's tag is the
 * literal `latest`, which is not a version and must not be treated as one.
 */
export function normalizeTag(tag: string | undefined): string | undefined {
  if (typeof tag !== 'string') return undefined;
  const stripped = tag.trim().replace(/^v/i, '');
  return parseVersion(stripped) ? stripped : undefined;
}

/**
 * Resolve the latest released version from the GitHub Releases API.
 *
 * `/releases/latest` answers with the newest NON-prerelease release, so it does
 * not 404 forever once any stable tag exists. The rolling channel is published
 * as a prerelease whose tag is the literal `latest`, which `/releases/latest`
 * never returns and which is not a version at all. The daemon therefore resolves
 * upgrades from STABLE releases only: a long-lived server must not chase a
 * prerelease channel.
 *
 * `/releases/latest` is tried first; on a 404 fall back to the release list
 * (ordered newest-first by GitHub) and take the first release that actually
 * ships the asset for this architecture.
 */
async function fetchLatestVersion(assetName: string): Promise<string | undefined> {
  const direct = await fetchWithTimeout(
    `https://api.github.com/repos/${REPO_SLUG}/releases/latest`,
    'application/vnd.github+json'
  );
  if (direct.ok) {
    const release = (await direct.json()) as GithubRelease;
    return normalizeTag(release.tag_name);
  }
  if (direct.status !== 404) throw new Error(`GitHub API responded ${direct.status}`);

  const list = await fetchWithTimeout(
    `https://api.github.com/repos/${REPO_SLUG}/releases?per_page=20`,
    'application/vnd.github+json'
  );
  if (!list.ok) throw new Error(`GitHub API responded ${list.status}`);
  const releases = (await list.json()) as GithubRelease[];
  const match = releases.find((release) => release.assets?.some((asset) => asset.name === assetName));
  return normalizeTag(match?.tag_name);
}

/** Download `url` to `destination`, refusing to leave a partial file behind. */
async function downloadTo(url: string, destination: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'superiu-server-updater' },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
  } catch (err) {
    throw new Error(`download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} from ${url}`);
  if (!response.body) throw new Error(`download failed: empty response body from ${url}`);

  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
  } catch (err) {
    try {
      fs.rmSync(destination, { force: true });
    } catch {
      // Best effort: the caller reports the download failure either way.
    }
    throw err;
  }
}

/**
 * Read the delta patch's header for `url`, or `null` when there is no usable
 * patch there.
 *
 * The header is a fixed-size, *un-gzipped* 78-byte prefix (see `delta.ts`), so a
 * single ranged request answers the only question that matters before paying for
 * a patch: does its recorded source binary match the one on disk? A patch built
 * against a different build can never be applied, and discovering that after
 * downloading megabytes would waste far more traffic than this preflight costs.
 * Every failure — a release that ships no patch (404), a truncated response, a
 * network error — is `null`, and the caller simply downloads the full binary.
 */
async function fetchPatchHeader(url: string): Promise<DeltaHeader | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'superiu-server-updater',
        Range: `bytes=0-${DELTA_HEADER_SIZE - 1}`
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok || !response.body) return null;

    const reader = response.body.getReader();
    const head = new Uint8Array(DELTA_HEADER_SIZE);
    let filled = 0;
    while (filled < DELTA_HEADER_SIZE) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, DELTA_HEADER_SIZE - filled);
      head.set(value.subarray(0, take), filled);
      filled += take;
    }
    // Stop the transfer as soon as the header is complete: a server that
    // ignored the range and is streaming the whole patch must not be read to
    // the end. A failed cancel is irrelevant — the bytes are already in hand.
    try {
      await reader.cancel();
    } catch {
      // Ignored: only the header was needed, and it is complete.
    }
    if (filled < DELTA_HEADER_SIZE) return null;

    try {
      return parseDeltaHeader(head);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Put the release binary at `destination`, preferring the published delta patch
 * over the full download.
 *
 * This is a pure traffic optimization, and it is safe because `applyDelta` is
 * the only thing that decides success: it re-verifies the source file against
 * the sha256 recorded in the patch header and re-verifies the file it produced,
 * so a return means `destination` is byte-identical to the published release
 * binary — and the caller's `probeBinaryVersion` + `semverGt` checks then run on
 * it exactly as they do for a full download. Anything else (no patch published,
 * a patch built against a different binary, a corrupt or half-applied patch, a
 * network error) falls back to the plain download, which is what keeps this
 * optimization from ever being able to break an update.
 */
async function acquireBinary(url: string, destination: string, source: string): Promise<'patch' | 'full'> {
  const patchFile = `${destination}${PATCH_SUFFIX}`;
  try {
    const localSha = await sha256File(source);
    const header = await fetchPatchHeader(`${url}${PATCH_SUFFIX}`);
    if (header && header.sourceSha256 === localSha) {
      await downloadTo(`${url}${PATCH_SUFFIX}`, patchFile);
      await applyDelta(source, patchFile, destination);
      return 'patch';
    }
  } catch (err) {
    process.stderr.write(
      `superiu-server: delta patch unusable, downloading the full binary: ${describeError(err)}\n`
    );
    // `applyDelta` removes its own output when it fails, but a throw after a
    // partial write cannot be ruled out: a half-applied file must never be
    // mistaken for a completed download.
    try {
      fs.rmSync(destination, { force: true });
    } catch {
      // Best effort: the full download below overwrites it anyway.
    }
  } finally {
    try {
      fs.rmSync(patchFile, { force: true });
    } catch {
      // Best effort: the patch is scratch, and the caller reports its own errors.
    }
  }

  await downloadTo(url, destination);
  return 'full';
}

/**
 * Bring a replaced daemon back up, restoring the identity it had before the
 * swap.
 *
 * A detached `spawn` with only `--workspace` would mint a fresh gateway token —
 * invalidating every already-paired client and any `~/.superiu/env` value — and
 * fall back to the default port, which may be taken. The port, host, and token
 * are therefore replayed from the state file.
 *
 * When a user systemd unit owns the daemon the unit is restarted instead:
 * respawning detached would leave the unit's own main process dead, so the
 * service manager would consider the unit broken. Only the unit's *existence*
 * selects that path — `is-active` would be wrong, since it is false for a
 * daemon started by hand that a unit merely describes.
 */
function restartDaemon(target: string, state: DaemonState): void {
  let unitOwnsDaemon = false;
  try {
    execFileSync('systemctl', ['--user', 'cat', 'superiu-server'], { stdio: 'ignore' });
    unitOwnsDaemon = true;
  } catch {
    // No unit: fall through to the detached respawn below.
  }

  if (unitOwnsDaemon) {
    execFileSync('systemctl', ['--user', 'restart', 'superiu-server'], {
      stdio: 'ignore',
      timeout: STOP_TIMEOUT_MS
    });
    return;
  }

  // `readState` defaults a missing port to 0 and a missing token to '', so a
  // state file written by an older build may lack them. An empty `--token` is
  // rejected by `parseArgs`, so only a non-empty one is replayed. `--port 0` is
  // a valid, meaningful value here: on a socket daemon it marks socket-only, and
  // replaying it is what stops the flagless default from adding a TCP listener.
  const args = ['start'];
  if (state.socketPath) args.push('--socket', state.socketPath);
  // Replay the TCP listener whenever one existed. In dual-listen mode the port
  // accompanies the socket, and a recorded `0` keeps a socket-only daemon from
  // silently re-adding the default TCP port on restart.
  if (state.socketPath) {
    args.push('--port', String(state.port));
    if (state.port > 0 && state.host) args.push('--host', state.host);
  } else {
    if (state.port > 0) args.push('--port', String(state.port));
    if (state.host) args.push('--host', state.host);
  }
  if (state.token) args.push('--token', state.token);
  args.push('--workspace', state.workspace);
  // Same replay rule as the detached respawn: losing the base here would make
  // the restarted daemon fall back to the default GitHub channel on its next
  // idle tick, defeating the mirror the operator configured.
  if (state.releaseBase) {
    args.push('--release-base', state.releaseBase);
  }

  spawn(target, args, { detached: true, stdio: 'ignore' }).unref();
}

export interface RestartSeams {
  /**
   * Whether a user systemd unit owns the daemon. Defaults to asking
   * `systemctl --user cat superiu-server`; overridable so a test can pin either
   * branch without depending on the host's unit directory.
   */
  hasUnit?: () => boolean;
  /** Spawns the replacement. Defaults to `node:child_process.spawn`. */
  spawn?: typeof spawn;
}

/**
 * The in-process half of a self-update: bring the daemon back up without ever
 * blocking on its own exit.
 *
 * {@link restartDaemon} cannot be used here. It calls `systemctl --user restart`
 * through `execFileSync`, and the tick runs INSIDE the unit's main process:
 * systemd must SIGTERM that very process before the replacement can bind, so the
 * synchronous call waits on systemd while systemd waits on us. The 10s
 * `timeout` then fires and the tick reports a misleading failure after a
 * perfectly good binary swap. The standalone `update` command keeps the sync
 * version — it is a separate process, so nothing deadlocks, and it wants the
 * restart to be observable.
 *
 * Both branches therefore spawn DETACHED and return immediately; the caller
 * exits right after, which is what lets systemd (or the respawned binary)
 * proceed.
 */
export function restartDaemonDetached(target: string, state: DaemonState, seams: RestartSeams = {}): void {
  const doSpawn = seams.spawn ?? spawn;
  const unitOwnsDaemon = seams.hasUnit
    ? seams.hasUnit()
    : ((): boolean => {
        try {
          execFileSync('systemctl', ['--user', 'cat', 'superiu-server'], { stdio: 'ignore' });
          return true;
        } catch {
          // No unit: fall through to the detached respawn below.
          return false;
        }
      })();

  if (unitOwnsDaemon) {
    if (state.autoUpdateIdle) {
      process.stderr.write(
        'superiu-server: auto-update: restarting via the systemd unit, which cannot receive CLI flags; ' +
          'put SUPERIU_AUTO_UPDATE_IDLE=1 in the unit EnvironmentFile for auto-update to survive restarts\n'
      );
    }
    // Detached and unreferenced: the restart completes after this process exits,
    // which is exactly when systemd can stop us and start the new instance.
    doSpawn('systemctl', ['--user', 'restart', 'superiu-server'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  // Same replay rules as `restartDaemon`: only flags that actually carry a value
  // are passed, so a state file from an older build cannot fail the restart.
  const args = ['start'];
  if (state.socketPath) args.push('--socket', state.socketPath);
  // Replay the TCP listener whenever one existed. In dual-listen mode the port
  // accompanies the socket, and a recorded `0` keeps a socket-only daemon from
  // silently re-adding the default TCP port on restart.
  if (state.socketPath) {
    args.push('--port', String(state.port));
    if (state.port > 0 && state.host) args.push('--host', state.host);
  } else {
    if (state.port > 0) args.push('--port', String(state.port));
    if (state.host) args.push('--host', state.host);
  }
  if (state.token) args.push('--token', state.token);
  args.push('--workspace', state.workspace);
  // The respawned process starts with a clean argv, so the auto-update settings
  // are replayed explicitly — otherwise enabling the feature once via the CLI
  // would silently make it one-shot.
  if (state.autoUpdateIdle) {
    args.push('--auto-update-idle');
    if (state.autoUpdateIntervalHours) {
      args.push('--auto-update-interval-hours', String(state.autoUpdateIntervalHours));
    }
  }
  // Replayed for the same reason, and more urgently: a respawn that lost the
  // base would silently upgrade from the default GitHub channel instead of the
  // private mirror the operator configured.
  if (state.releaseBase) {
    args.push('--release-base', state.releaseBase);
  }

  doSpawn(target, args, { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Ask a freshly downloaded binary what version it reports.
 *
 * The released asset's name and its `tag_name` are both claims made by the
 * release pipeline; the binary's own `version` output is the only value that
 * survives to the next upgrade's comparison. A release whose baked version is
 * stale (a root `package.json` that was never bumped) would otherwise install a
 * binary that keeps reporting the old version — an upgrade loop. Returns
 * `undefined` when the probe cannot be parsed.
 */
function probeBinaryVersion(binary: string): string | undefined {
  let stdout: string;
  try {
    stdout = execFileSync(binary, ['version'], { encoding: 'utf-8', timeout: STOP_TIMEOUT_MS });
  } catch (err) {
    process.stderr.write(`superiu-server: could not run the downloaded binary: ${describeError(err)}\n`);
    return undefined;
  }

  const line = stdout.trim().split('\n').filter((part) => part.trim() !== '').pop();
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export interface UpdateTickSeams {
  fetchLatest?: (assetName: string) => Promise<string | undefined>;
  /**
   * Acquire the release binary at `url` into `destination`. The default prefers
   * the delta patch published beside the binary and falls back to the full
   * download; a caller-supplied implementation replaces that whole acquisition
   * step (tests pin it to the plain download).
   */
  download?: (url: string, destination: string) => Promise<void>;
  probeVersion?: (binary: string) => string | undefined;
  /**
   * Unused by the tick since the drain window was cut down to the swap itself —
   * there is no settling delay left to make configurable. Retained because it is
   * part of this exported interface's shape.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Non-fatal persistence of the update state file. Overridable so a caller (or
   * a test) can observe — or make fail — a write without touching the real
   * filesystem; a failure must never abort the tick.
   */
  writeState?: (workspace: string, state: UpdateBackoffState) => string;
  /** How the daemon is brought back up after a swap. Defaults to the detached respawn. */
  restart?: (target: string, state: DaemonState) => void;
  /** Process exit after a successful swap. Overridable so tests do not kill the runner. */
  exit?: (code: number) => void;
  /** Force-run the tick, bypassing the 24h backoff window (used by manual update requests). */
  ignoreBackoff?: boolean;
}

export async function runUpdateTick(
  handle: Pick<ServerHandle, 'isIdle' | 'setDraining' | 'close'>,
  state: DaemonState,
  workspace: string,
  target: string = process.execPath,
  seams: UpdateTickSeams = {}
): Promise<void> {
  const doFetchLatest = seams.fetchLatest ?? fetchLatestVersion;
  // The default acquires the release binary through `acquireBinary`, which
  // prefers the published delta patch and falls back to the full download. A
  // caller-supplied `download` replaces that whole acquisition step — tests pin
  // it to the plain download.
  const doDownload =
    seams.download ??
    (async (url: string, destination: string): Promise<void> => {
      await acquireBinary(url, destination, target);
    });
  const doProbeVersion = seams.probeVersion ?? probeBinaryVersion;
  const doWriteState = seams.writeState ?? writeUpdateState;
  const doRestart = seams.restart ?? restartDaemonDetached;
  const doExit = seams.exit ?? ((code: number) => process.exit(code));

  /**
   * Persist the update state without letting the filesystem decide whether the
   * daemon keeps serving. A failed write (ENOSPC, EACCES) must never abort the
   * tick, and — because `draining` is only ever reset in the `finally` below —
   * must never leave the gateway refusing every new prompt.
   */
  const persist = (next: UpdateBackoffState): void => {
    try {
      doWriteState(workspace, next);
    } catch (err) {
      process.stderr.write(`superiu-server: auto-update: could not write update state: ${describeError(err)}\n`);
    }
  };

  /** Record the check for the bookkeeping-only exits, still non-fatally. */
  const markChecked = (base: UpdateBackoffState): void => {
    persist({ ...base, lastCheckAt: new Date().toISOString() });
  };

  try {
    const assetName = ARCH_ASSETS[process.arch];
    if (!assetName) {
      process.stderr.write(`superiu-server: auto-update: unsupported architecture '${process.arch}'\n`);
      return;
    }

    let candidate: string | undefined;
    try {
      candidate = await doFetchLatest(assetName);
    } catch (err) {
      process.stderr.write(`superiu-server: auto-update: check failed: ${describeError(err)}\n`);
      return;
    }
    if (!candidate) return;

    const current = resolveVersion();
    const backoffState = readUpdateState(workspace);

    if (!semverGt(candidate, current)) {
      markChecked(backoffState);
      return;
    }

    if (!seams.ignoreBackoff && isBackoffBlocked(backoffState, candidate)) {
      markChecked(backoffState);
      return;
    }

    if (!handle.isIdle()) {
      process.stderr.write('superiu-server: deferring update: daemon busy\n');
      markChecked(backoffState);
      return;
    }

    // The download (~80MB) and the probe run while the daemon is still fully
    // SERVING. Draining here would 503 every `/api/chat` for the whole transfer,
    // which on a slow VPS is tens of seconds to minutes.
    //
    // Same precedence as `commandUpdate`: the base persisted by `start` wins, so
    // a daemon launched against a private mirror never silently upgrades from
    // the default GitHub channel.
    const base = (state.releaseBase ?? process.env.SUPERIU_RELEASE_BASE ?? DEFAULT_RELEASE_BASE).replace(
      /\/+$/,
      ''
    );
    const url = `${base}/${assetName}`;
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.update.${process.pid}`);

    let binaryVersion: string | undefined;
    try {
      await doDownload(url, tmp);
      fs.chmodSync(tmp, 0o755);
      binaryVersion = doProbeVersion(tmp);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      process.stderr.write(`superiu-server: auto-update: download failed: ${describeError(err)}\n`);
      return;
    }

    if (!binaryVersion || !semverGt(binaryVersion, current)) {
      const now = new Date().toISOString();
      persist({
        ...backoffState,
        lastCheckAt: now,
        lastFailedAt: now,
        lastFailedVersion: candidate
      });
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      process.stderr.write(
        `superiu-server: auto-update: downloaded binary invalid or not newer (${binaryVersion ?? 'unparseable'}); backing off\n`
      );
      return;
    }

    // Only the swap needs exclusivity: rename + close + restart is milliseconds,
    // and the re-check below narrows even that to the moment the turn count was
    // read. Draining is reset strictly in the `finally`, so every early return —
    // and any throw — restores the gateway.
    let swapped = false;
    handle.setDraining(true);
    try {
      if (!handle.isIdle()) {
        process.stderr.write('superiu-server: deferring update: daemon busy\n');
        try {
          fs.rmSync(tmp, { force: true });
        } catch {}
        return;
      }
      fs.renameSync(tmp, target);
      swapped = true;
    } finally {
      if (!swapped) handle.setDraining(false);
    }

    markChecked(backoffState);
    await handle.close();
    doRestart(target, state);
    doExit(0);
  } catch (err) {
    process.stderr.write(`superiu-server: auto-update error: ${describeError(err)}\n`);
  }
}

export function startIdleUpdateLoop(
  handle: ServerHandle,
  state: DaemonState,
  workspace: string,
  intervalMs: number
): NodeJS.Timeout {
  const target = process.execPath;
  return setInterval(() => {
    void runUpdateTick(handle, state, workspace, target).catch((err) => {
      process.stderr.write(`superiu-server: auto-update: unhandled tick error: ${describeError(err)}\n`);
    });
  }, intervalMs);
}

async function commandUpdate(parsed: ParsedArgs): Promise<number> {
  const assetName = ARCH_ASSETS[process.arch];
  if (!assetName) {
    process.stderr.write(`superiu-server: unsupported architecture '${process.arch}' (supported: x64, arm64)\n`);
    return 1;
  }

  const current = resolveVersion();
  const base = (parsed.releaseBase ?? process.env.SUPERIU_RELEASE_BASE ?? DEFAULT_RELEASE_BASE).replace(/\/+$/, '');
  const pinned = parsed.version?.replace(/^v/i, '') || undefined;

  // Resolve the version to compare against. A pinned `--version` is taken at
  // face value (it names the tag to fetch); otherwise the API decides.
  let latest: string;
  try {
    latest = pinned ?? (await fetchLatestVersion(assetName)) ?? '';
  } catch (err) {
    process.stderr.write(`superiu-server: could not determine the latest version: ${describeError(err)}\n`);
    return 1;
  }

  // An unparseable tag (the rolling `latest`, a nightly) must never look like an
  // update — `semverGt` already refuses to compare it, but `--force` may still
  // deliberately fetch it.
  const hasUpdate = parsed.force || semverGt(latest, current);

  if (parsed.check) {
    printJson({ current, latest, hasUpdate });
    return 0;
  }

  if (!hasUpdate) {
    printJson({ updated: false, current, latest, restarted: false });
    return 0;
  }

  // Where the new binary goes. Defaulting to `process.execPath` is only safe
  // when that IS the daemon binary; under `node dist/daemon.js` it would
  // overwrite the node executable.
  const execName = path.basename(process.execPath);
  const target = parsed.target ?? (execName === 'superiu-server' ? process.execPath : undefined);
  if (!target) {
    process.stderr.write(
      `superiu-server: refusing to update: the running binary is '${execName}', not 'superiu-server'.\n` +
        'Run the installed binary, pass --target <path>, or use scripts/install.sh.\n'
    );
    printJson({ updated: false, current, latest, restarted: false });
    return 1;
  }

  // Pin switches the base from `.../releases/latest/download` to the tag's
  // `.../releases/download/v<version>`, matching the GitHub Releases layout.
  const effectiveBase = pinned ? `${base.replace(/\/latest\/download$/, '/download')}/v${pinned}` : base;
  const url = `${effectiveBase}/${assetName}`;

  // Same directory as the target so the final rename is atomic on one
  // filesystem; a partial download can then never clobber a working binary.
  // `installed` is set only after the swap, to the version the new binary
  // itself reports — the printed `latest` is always the truth on disk.
  let installed: string | undefined;
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.update.${process.pid}`);
  try {
    process.stderr.write(`superiu-server: downloading ${url}\n`);
    const mode = await acquireBinary(url, tmp, target);
    process.stderr.write(
      `superiu-server: acquired the new binary via ${mode === 'patch' ? 'delta patch' : 'full download'}\n`
    );
    fs.chmodSync(tmp, 0o755);

    // The release pipeline's own version claims (tag name, asset name) are not
    // evidence: a stale bake ships a binary that keeps self-reporting the old
    // version and would upgrade forever. The downloaded binary's `version`
    // output is the only durable value, so it decides whether to swap.
    const binaryVersion = probeBinaryVersion(tmp);
    if (!binaryVersion) {
      throw new Error('the downloaded binary did not report a parseable version; refusing to install');
    }
    if (!parsed.force && !semverGt(binaryVersion, current)) {
      throw new Error(
        `the release advertises ${latest} but the downloaded binary reports ${binaryVersion}; refusing to install`
      );
    }

    fs.renameSync(tmp, target);
    installed = binaryVersion;
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort cleanup; the download failure below is what matters.
    }
    process.stderr.write(`superiu-server: update failed: ${describeError(err)}\n`);
    printJson({ updated: false, current, latest, restarted: false });
    return 1;
  }

  // Restart whatever was running, so the upgrade actually takes effect. The
  // workspace is probed rather than assumed: the desktop app starts its daemon
  // in `$HOME/.superiu/workspace`, so an update run from anywhere else must find
  // that daemon instead of silently swapping the binary of a process that keeps
  // running from the deleted inode. The reported `workspace` reflects the same
  // resolution, so the caller sees which daemon was touched.
  let restarted = false;
  const workspace = resolveLiveWorkspace(parsed.workspace);
  const state = readState(workspace);
  if (state && isAlive(state.pid)) {
    await terminateAndWait(state.pid);
    removeState(workspace);
    try {
      restartDaemon(target, state);
      restarted = true;
    } catch (err) {
      process.stderr.write(`superiu-server: updated, but restart failed: ${describeError(err)}\n`);
    }
  }

  printJson({ updated: true, current, latest: installed ?? latest, restarted });
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
      case 'update':
        process.exitCode = await commandUpdate(parsed);
        return;
      case 'token':
        process.exitCode = commandToken();
        return;
      case 'pair':
        process.exitCode = commandPair(parsed);
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

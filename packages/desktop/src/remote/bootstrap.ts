/**
 * Remote probe / install / start for the SuperIU daemon on a VPS.
 *
 * Everything that runs on the remote machine goes through the injected
 * {@link RemoteRunner} seam (`ssh <alias> <command>` by default), which makes
 * the whole module unit-testable without a live server.
 *
 * Every interpolated value (workspace paths, tokens, URLs) is passed through
 * {@link shellQuote} before it reaches the remote shell: these values come from
 * user/desktop input and must not be able to break out of the command.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { REPO_SLUG } from '../constants.js';
import { sshControlArgs } from './ssh_control.js';

/** Result of running a command on the remote host. */
export interface RemoteRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs a single shell command on the remote host. Injected for testability;
 * the default implementation shells out to `ssh`.
 */
export type RemoteRunner = (
  alias: string,
  remoteCommand: string,
) => Promise<RemoteRunResult>;

/** Platform information returned by {@link RemoteBootstrapper.probe}. */
export interface RemoteProbeResult {
  /** `uname -s` output, or `unsupported` when not Linux. */
  os: string;
  /** Normalised CPU architecture. */
  arch: 'x64' | 'arm64' | 'unsupported';
  /** Remote `$HOME`. */
  home: string;
  /** Whether `~/.superiu/bin/superiu-server` exists and is executable. */
  installed: boolean;
  /** Version reported by the binary, when installed and runnable. */
  version?: string;
  /** Whether the daemon is currently running (per `status`). */
  running: boolean;
  /** Whether the remote binary advertises `--socket` (Unix domain socket listen mode). */
  supportsSocket: boolean;
}

/** Options for {@link RemoteBootstrapper.install}. */
export interface RemoteInstallOptions {
  /** Overrides the release download base URL. */
  releaseBase?: string;
  /** Pins a specific released version (switches to `/download/v<version>/`). */
  version?: string;
  /** Workspace whose running daemon must be stopped before the swap, so the new binary is the one that starts. */
  workspace?: string;
}

/** Result of {@link RemoteBootstrapper.install}. */
export interface RemoteInstallResult {
  installed: true;
  version?: string;
}

/** Options for {@link RemoteBootstrapper.start}. */
export interface RemoteStartOptions {
  /** Local-only port the daemon binds on the VPS. */
  port: number;
  /** Pairing token. */
  token: string;
  /** Remote workspace directory. */
  workspace: string;
  /**
   * Absolute remote Unix socket path. When set the daemon listens on a socket
   * instead of a TCP port, and `--port`/`--host` are not emitted.
   */
  socketPath?: string;
  /**
   * Idle auto-update, tri-state: `true` emits `--auto-update-idle`, `false`
   * emits `--no-auto-update-idle`, and `undefined` emits neither so the
   * daemon's persisted value stands.
   */
  autoUpdateIdle?: boolean;
  /** Hours between idle auto-update checks; only emitted when the feature is on and the value is `> 0`. */
  autoUpdateIntervalHours?: number;
}

/** Parsed daemon state returned by {@link RemoteBootstrapper.start}. */
export interface RemoteDaemonState {
  running: boolean;
  pid?: number;
  port?: number;
  host?: string;
  url?: string;
  /** Local (`127.0.0.1`) gateway URL the tunnel exposes. */
  gatewayUrl?: string;
  /** Absolute remote Unix socket path the daemon is listening on, when in socket mode. */
  socketPath?: string;
  token?: string;
  version?: string;
  /** Whether the running daemon was started with idle auto-update enabled. */
  autoUpdateIdle?: boolean;
}

/** Default install location for the daemon binary. */
export const REMOTE_BIN_DIR = '$HOME/.superiu/bin';
export const REMOTE_BIN_NAME = 'superiu-server';
export const REMOTE_BIN_PATH = `${REMOTE_BIN_DIR}/${REMOTE_BIN_NAME}`;

const DEFAULT_RELEASE_BASE = `https://github.com/${REPO_SLUG}/releases/latest/download`;

/**
 * Quote a value for safe single-argument interpolation into a POSIX shell
 * command. Wraps in single quotes and escapes embedded single quotes with the
 * standard `'\''` idiom, so shell metacharacters (`;`, `` ` ``, `$()`, `&`, …)
 * are literal.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote a value that will be used as a `$HOME`-relative path fragment. */
function shellQuotePath(value: string): string {
  return shellQuote(value);
}

/** Default runner: `ssh <alias> <command>`, reusing a ControlMaster connection. */
export const defaultRemoteRunner: RemoteRunner = (alias, remoteCommand) =>
  new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshControlArgs(), alias, remoteCommand], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });

/** Parse the JSON object from `text` (supporting multiline JSON or single-line JSON), or null. */
function parseJsonLine<T>(text: string): T | null {
  const trimmedFull = text.trim();
  if (trimmedFull.startsWith('{') && trimmedFull.endsWith('}')) {
    try {
      return JSON.parse(trimmedFull) as T;
    } catch {
      /* fall back to line scanning */
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Normalise `uname -m` output to the release artifact architecture names. */
export function normalizeArch(machine: string): 'x64' | 'arm64' | 'unsupported' {
  const m = machine.trim().toLowerCase();
  if (m === 'x86_64' || m === 'amd64') return 'x64';
  if (m === 'aarch64' || m === 'arm64') return 'arm64';
  return 'unsupported';
}

/**
 * Provisions and controls the SuperIU daemon on a remote VPS.
 */
export class RemoteBootstrapper {
  private readonly runRemote: RemoteRunner;

  constructor(runRemote: RemoteRunner = defaultRemoteRunner) {
    this.runRemote = runRemote;
  }

  /** Run a command and throw when it exits non-zero. */
  private async runOrThrow(alias: string, command: string): Promise<RemoteRunResult> {
    const result = await this.runRemote(alias, command);
    if (result.exitCode !== 0) {
      throw new Error(
        `remote command failed (exit ${result.exitCode}): ${command}\n${result.stderr.trim()}`,
      );
    }
    return result;
  }

  /**
   * Gather platform + install + run state with a single remote round trip.
   */
  async probe(alias: string): Promise<RemoteProbeResult> {
    const command = [
      'sh -c ' +
        shellQuote(
          [
            'printf "OS=%s\\n" "$(uname -s)"',
            'printf "ARCH=%s\\n" "$(uname -m)"',
            'printf "HOME=%s\\n" "$HOME"',
            `if [ -x ${REMOTE_BIN_PATH} ]; then`,
            '  printf "INSTALLED=1\\n"',
            `  printf "VERSION=%s\\n" "$(${REMOTE_BIN_PATH} version 2>/dev/null)"`,
            `  if ${REMOTE_BIN_PATH} --help 2>&1 | grep -q -- "--socket"; then`,
            '    printf "SOCKET_SUPPORT=1\\n"',
            '  else',
            '    printf "SOCKET_SUPPORT=0\\n"',
            '  fi',
            'else',
            '  printf "INSTALLED=0\\n"',
            '  printf "SOCKET_SUPPORT=0\\n"',
            'fi',
            `if ${REMOTE_BIN_PATH} status --workspace "\${HOME}/.superiu/workspace" >/dev/null 2>&1; then`,
            '  printf "RUNNING=1\\n"',
            'else',
            '  printf "RUNNING=0\\n"',
            'fi',
          ].join('\n'),
        ),
    ].join('');

    const { stdout } = await this.runOrThrow(alias, command);
    const fields = parseKeyValues(stdout);

    const os = fields.OS ?? 'unknown';
    const home = fields.HOME ?? '';

    if (os.trim() !== 'Linux') {
      return {
        os,
        arch: 'unsupported',
        home,
        installed: false,
        running: false,
        supportsSocket: false,
      };
    }

    const arch = normalizeArch(fields.ARCH ?? '');
    const installed = fields.INSTALLED === '1';

    let version: string | undefined;
    if (installed && fields.VERSION) {
      version = parseJsonLine<{ version?: string }>(fields.VERSION)?.version ?? undefined;
    }

    return {
      os,
      arch,
      home,
      installed,
      version,
      running: fields.RUNNING === '1',
      supportsSocket: fields.SOCKET_SUPPORT === '1',
    };
  }

  /** Download URL for the daemon binary on a given release base/version. */
  private buildDownloadUrl(arch: 'x64' | 'arm64', options: RemoteInstallOptions): string {
    const base = (options.releaseBase ?? DEFAULT_RELEASE_BASE).replace(/\/+$/, '');
    // Pin switches from `.../releases/latest/download` to
    // `.../releases/download/v<version>`.
    const effectiveBase = options.version
      ? base.replace(/\/latest\/download$/, `/download/v${options.version}`)
      : base;
    return `${effectiveBase}/${REMOTE_BIN_NAME}-linux-${arch}`;
  }

  /**
   * Install (or upgrade) the daemon. Idempotent: downloads to a temp path,
   * chmods, and atomically moves into place so a failed download can never
   * clobber a working binary.
   */
  async install(
    alias: string,
    arch: 'x64' | 'arm64',
    options: RemoteInstallOptions = {},
  ): Promise<RemoteInstallResult> {
    const url = this.buildDownloadUrl(arch, options);
    const tmp = `${REMOTE_BIN_PATH}.tmp.$$`;

    // Best-effort stop of the currently installed daemon before the swap, so
    // the subsequent start executes the freshly installed binary instead of
    // adopting the old process (which would keep running from a deleted inode).
    const stopLine = options.workspace
      ? [
          `if [ -x ${REMOTE_BIN_PATH} ]; then ${REMOTE_BIN_PATH} stop --workspace ${shellQuotePath(options.workspace)} >/dev/null 2>&1 || true; fi`,
        ]
      : [];

    const downloadScript = [
      ...stopLine,
      `mkdir -p ${REMOTE_BIN_DIR}`,
      'if command -v curl >/dev/null 2>&1; then',
      `  curl -fsSL ${shellQuote(url)} -o ${tmp}`,
      'elif command -v wget >/dev/null 2>&1; then',
      `  wget -qO- ${shellQuote(url)} > ${tmp}`,
      'else',
      '  echo "neither curl nor wget is available on the remote host" >&2',
      '  exit 3',
      'fi',
      `chmod +x ${tmp}`,
      `mv -f ${tmp} ${REMOTE_BIN_PATH}`,
    ].join('\n');

    await this.runOrThrow(alias, `sh -c ${shellQuote(downloadScript)}`);

    // Verify the freshly installed binary actually runs.
    const versionResult = await this.runOrThrow(alias, `${REMOTE_BIN_PATH} version`);
    const version = parseJsonLine<{ version?: string }>(versionResult.stdout)?.version;

    return { installed: true, version };
  }

  /** Create the workspace directory (and its `.superiu` metadata dir). */
  async ensureWorkspace(alias: string, workspace: string): Promise<void> {
    await this.runOrThrow(
      alias,
      `mkdir -p ${shellQuotePath(workspace)}/.superiu`,
    );
  }

  /**
   * Read the daemon's `server.json` from the workspace, if present. Used to
   * reuse an already-running daemon instead of starting a second instance.
   */
  async readServerState(alias: string, workspace: string): Promise<RemoteDaemonState | null> {
    const path = `${workspace}/.superiu/server.json`;
    const result = await this.runRemote(alias, `cat ${shellQuotePath(path)} 2>/dev/null || true`);
    if (result.exitCode !== 0) return null;
    const parsed = parseJsonLine<RemoteDaemonState>(result.stdout);
    if (!parsed) return null;
    // Normalise the tri-state on disk (`true` | `false` | absent) to a boolean,
    // so "the daemon was started without the flag" is unambiguously `false`.
    return { ...parsed, autoUpdateIdle: parsed.autoUpdateIdle === true };
  }

  /**
   * Ask the daemon whether it is running, returning its parsed state.
   */
  async status(alias: string, workspace: string): Promise<RemoteDaemonState> {
    const result = await this.runRemote(
      alias,
      `${REMOTE_BIN_PATH} status --workspace ${shellQuotePath(workspace)}`,
    );
    const parsed = parseJsonLine<RemoteDaemonState>(result.stdout);
    const running = parsed?.running === true && result.exitCode === 0;
    return { ...(parsed ?? {}), running };
  }

  /**
   * Start the daemon detached from the ssh session, then poll `status` until it
   * reports running (or a ~20s timeout elapses).
   *
   * A `systemctl --user` unit is preferred when one exists; otherwise the
   * daemon is launched with `setsid nohup … &` so it survives the ssh session
   * ending.
   */
  async start(alias: string, options: RemoteStartOptions): Promise<RemoteDaemonState> {
    const { port, token, workspace } = options;

    // Socket mode binds a Unix domain socket instead of a loopback TCP port;
    // the two are mutually exclusive on the daemon CLI.
    const listenArgs = options.socketPath
      ? ['--socket', shellQuotePath(options.socketPath)]
      : ['--port', String(port), '--host', '127.0.0.1'];

    const args = [
      'start',
      ...listenArgs,
      '--token',
      shellQuote(token),
      '--workspace',
      shellQuotePath(workspace),
    ];

    // Idle auto-update is tri-state: an explicit `true`/`false` turns the
    // feature on/off (the daemon resolves CLI > env > persisted), while
    // `undefined` expresses no preference and emits neither flag so the
    // daemon's persisted value is left untouched. The interval is only
    // emitted for a positive finite number and only when the feature is
    // explicitly on — it is meaningless with the feature off, and the daemon
    // rejects anything but a positive number, so an invalid value must never
    // reach argv.
    if (options.autoUpdateIdle === true) {
      args.push('--auto-update-idle');
      if (
        typeof options.autoUpdateIntervalHours === 'number' &&
        Number.isFinite(options.autoUpdateIntervalHours) &&
        options.autoUpdateIntervalHours > 0
      ) {
        args.push('--auto-update-interval-hours', String(options.autoUpdateIntervalHours));
      }
    } else if (options.autoUpdateIdle === false) {
      args.push('--no-auto-update-idle');
    }

    const argsLine = args.join(' ');

    const unitCheck = 'systemctl --user cat superiu-server >/dev/null 2>&1';
    const systemctlStart = `systemctl --user restart superiu-server`;
    const nohupStart =
      `setsid nohup ${REMOTE_BIN_PATH} ${argsLine} ` +
      `</dev/null >"$HOME/.superiu/server.log" 2>&1 &`;

    const launchScript = [
      `mkdir -p ${REMOTE_BIN_DIR} ` + shellQuotePath(`${workspace}/.superiu`),
      `if ${unitCheck}; then`,
      `  ${systemctlStart}`,
      'else',
      '  if ' + `${REMOTE_BIN_PATH} status --workspace ${shellQuotePath(workspace)} >/dev/null 2>&1; then`,
      '    :', // already running: leave it alone
      '  else',
      `    ${nohupStart}`,
      '    disown 2>/dev/null || true',
      '  fi',
      'fi',
    ].join('\n');

    await this.runOrThrow(alias, `sh -c ${shellQuote(launchScript)}`);

    const state = await this.waitForRunning(alias, workspace);
    const remotePort = state.port ?? port;
    return {
      ...state,
      port: remotePort,
      host: state.host ?? '127.0.0.1',
      // The daemon persists the flag, but `status` may not echo it back; the
      // requested value is authoritative for the process this call launched.
      autoUpdateIdle: state.autoUpdateIdle ?? options.autoUpdateIdle === true,
      gatewayUrl: `ws://127.0.0.1:${remotePort}/ws`,
    };
  }

  /** Poll `status` until the daemon reports running, or the timeout elapses. */
  private async waitForRunning(
    alias: string,
    workspace: string,
    timeoutMs = 20_000,
  ): Promise<RemoteDaemonState> {
    const deadline = Date.now() + timeoutMs;
    let last: RemoteDaemonState = { running: false };
    while (Date.now() < deadline) {
      last = await this.status(alias, workspace);
      if (last.running) return last;
      await delay(500);
    }
    return last;
  }

  /** Stop the daemon (used only by explicit teardown UI, not by disconnect). */
  async stop(alias: string, workspace: string): Promise<boolean> {
    const result = await this.runRemote(
      alias,
      `${REMOTE_BIN_PATH} stop --workspace ${shellQuotePath(workspace)}`,
    );
    return parseJsonLine<{ stopped?: boolean }>(result.stdout)?.stopped === true;
  }

  /** Generate a fresh 32-byte hex pairing token. */
  static generateToken(): string {
    return randomBytes(32).toString('hex');
  }
}

/** Parse `KEY=value` lines into a lookup map. */
function parseKeyValues(stdout: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    fields[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return fields;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

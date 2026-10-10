/**
 * One-click remote connection orchestrator.
 *
 * Composes {@link RemoteBootstrapper} (probe/install/start over ssh),
 * {@link SshTunnelManager} (local port-forward) and {@link GatewayClient} into
 * the single flow the UI drives:
 *
 *   probe → install → workspace → token → start → tunnel → gateway client
 *
 * Progress is reported step-by-step so the UI can render what is happening.
 * Failures are wrapped in a {@link RemoteConnectionError} carrying the failing
 * step id.
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

import { GatewayClient, type GatewayClientOptions } from '../gateway_client.js';
import { parseVersion, semverGt } from '../semver.js';
import {
  RemoteBootstrapper,
  REMOTE_BIN_PATH,
  type RemoteDaemonState,
  type RemoteRunner,
} from './bootstrap.js';
import { SshTunnelManager } from './tunnel.js';
import type { SshHostEntry } from './ssh_config.js';

/** Stable identifiers for each step of the connection flow. */
export type RemoteStepId =
  | 'probe'
  | 'install'
  | 'workspace'
  | 'token'
  | 'start'
  | 'tunnel'
  | 'client';

/** Status of a single step. */
export type RemoteStepStatus = 'pending' | 'active' | 'done' | 'failed';

/** A progress update emitted for one step. */
export interface RemoteStep {
  id: RemoteStepId;
  status: RemoteStepStatus;
  detail?: string;
}

/** Options for {@link RemoteConnectionManager.connect}. */
export interface RemoteConnectOptions {
  /** ssh host alias from the user's ssh config. */
  alias: string;
  /** Remote workspace directory on the VPS. */
  workspace: string;
  /** Stable device id for the gateway handshake. */
  deviceId?: string;
  /** Overrides the release download base URL. */
  releaseBase?: string;
  /** Pins a specific daemon version. */
  version?: string;
  /**
   * Version the daemon is expected to run (normally the desktop app's own).
   * An already-installed daemon older than this is upgraded on connect; without
   * it an installed daemon is left untouched, so one predating a feature (or the
   * SPA it serves) would run forever.
   */
  daemonTargetVersion?: string;
  /** Pre-generated pairing token; a fresh one is created when omitted. */
  token?: string;
  /** Local port to forward from; an ephemeral port is chosen when omitted. */
  localPort?: number;
  /**
   * Idle auto-update, tri-state: `true`/`false` is an explicit choice that
   * restarts a running daemon when it disagrees, `undefined` expresses no
   * preference and adopts whatever the daemon already persisted.
   */
  autoUpdateIdle?: boolean;
  /** Hours between idle auto-update checks; only emitted when the feature is on and the value is `> 0`. */
  autoUpdateIntervalHours?: number;
  /** Progress callback for the UI. */
  onProgress?: (step: RemoteStep) => void;
  /** Shows a native approval prompt for dangerous commands. */
  onApprovalRequired?: GatewayClientOptions['onApprovalRequired'];
  /** Receives stream events from the gateway. */
  onEvent?: GatewayClientOptions['onEvent'];
  /** Observes gateway connection state and RTT changes. */
  onStateChange?: GatewayClientOptions['onStateChange'];
}

/** Result of a successful {@link RemoteConnectionManager.connect}. */
export interface RemoteConnectResult {
  /** Local gateway URL the tunnel exposes. */
  localUrl: string;
  /** Actual local tunnel port. */
  tunnelPort: number;
  /** The connected gateway client. */
  gatewayClient: GatewayClient;
}

/** Which step of the flow failed. */
export class RemoteConnectionError extends Error {
  readonly step: RemoteStepId;
  readonly cause?: unknown;

  constructor(step: RemoteStepId, message: string, cause?: unknown) {
    super(message);
    this.name = 'RemoteConnectionError';
    this.step = step;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Constructor dependencies, injectable for tests. */
export interface RemoteConnectionManagerOptions {
  bootstrapper?: RemoteBootstrapper;
  tunnel?: SshTunnelManager;
  /** Factory for the GatewayClient (injected for tests). */
  gatewayClientFactory?: (options: GatewayClientOptions) => GatewayClient;
  /** Injectable remote runner, forwarded to a default bootstrapper. */
  runRemote?: RemoteRunner;
  /** Resolves an ssh alias to concrete connection settings. */
  resolveHost?: (alias: string) => Promise<SshHostEntry | undefined>;
  /** Probes the tunnel's local `/readyz` endpoint (injected for tests). */
  probeReadyz?: (tunnelPort: number) => Promise<void>;
}

const DEFAULT_LOCAL_PORT = 0; // 0 => let the OS choose

/**
 * Orchestrates provisioning and connecting to a remote VPS.
 */
export class RemoteConnectionManager {
  private readonly bootstrapper: RemoteBootstrapper;
  private readonly tunnel: SshTunnelManager;
  private readonly gatewayClientFactory: (options: GatewayClientOptions) => GatewayClient;
  private readonly resolveHost?: (alias: string) => Promise<SshHostEntry | undefined>;
  private readonly probeReadyz: (tunnelPort: number) => Promise<void>;

  private client: GatewayClient | null = null;
  private lastOptions: RemoteConnectOptions | null = null;
  private lastTunnelPort: number | null = null;

  constructor(options: RemoteConnectionManagerOptions = {}) {
    this.bootstrapper =
      options.bootstrapper ?? new RemoteBootstrapper(options.runRemote);
    this.tunnel = options.tunnel ?? new SshTunnelManager();
    this.gatewayClientFactory =
      options.gatewayClientFactory ?? ((opts) => new GatewayClient(opts));
    this.resolveHost = options.resolveHost;
    this.probeReadyz = options.probeReadyz ?? ((port) => waitForReadyz(port));
  }

  /** The active gateway client, or null when disconnected. */
  get gatewayClient(): GatewayClient | null {
    return this.client;
  }

  private progress(
    onProgress: RemoteConnectOptions['onProgress'],
    step: RemoteStep,
  ): void {
    onProgress?.(step);
  }

  /**
   * Run the full provisioning + connection flow.
   */
  async connect(options: RemoteConnectOptions): Promise<RemoteConnectResult> {
    this.lastOptions = options;
    const { alias, workspace, onProgress } = options;

    // 1. Probe -----------------------------------------------------------------
    this.progress(onProgress, { id: 'probe', status: 'active' });
    let probe: Awaited<ReturnType<RemoteBootstrapper['probe']>>;
    try {
      probe = await this.bootstrapper.probe(alias);
    } catch (err) {
      this.progress(onProgress, {
        id: 'probe',
        status: 'failed',
        detail: messageOf(err),
      });
      throw new RemoteConnectionError('probe', `Failed to reach ${alias}: ${messageOf(err)}`, err);
    }

    if (probe.os !== 'Linux') {
      const detail = `The remote host runs ${probe.os}, but SuperIU requires Linux.`;
      this.progress(onProgress, { id: 'probe', status: 'failed', detail });
      throw new RemoteConnectionError('probe', detail);
    }
    if (probe.arch === 'unsupported') {
      const detail = 'The remote CPU architecture is not supported (need x86_64 or arm64).';
      this.progress(onProgress, { id: 'probe', status: 'failed', detail });
      throw new RemoteConnectionError('probe', detail);
    }
    this.progress(onProgress, {
      id: 'probe',
      status: 'done',
      detail: `${probe.os} ${probe.arch}`,
    });

    // 2. Install / upgrade -----------------------------------------------------
    // An absent daemon is always installed. An installed one is left alone
    // unless the caller pins a version (exact match) or names the version it
    // should be running (`daemonTargetVersion`, normally the desktop app's own)
    // and the installed one is older. Without that second rule an installed
    // daemon is never upgraded, so one predating a feature — or the SPA it
    // serves, which remote mode loads instead of the local bundle — keeps
    // running indefinitely.
    const installedVersion = probe.version;
    const staleByTarget =
      options.daemonTargetVersion !== undefined &&
      probe.installed &&
      semverGt(options.daemonTargetVersion, installedVersion) &&
      // Only a parseable installed version is comparable; an unparseable one is
      // treated as unknown and left alone rather than triggering a blind
      // re-download on every connect.
      parseVersion(installedVersion) !== null;
    const needsInstall =
      !probe.installed ||
      (options.version !== undefined && probe.version !== options.version) ||
      staleByTarget;
    if (needsInstall) {
      this.progress(onProgress, { id: 'install', status: 'active' });
      try {
        await this.bootstrapper.install(alias, probe.arch, {
          releaseBase: options.releaseBase,
          // A staleness upgrade pins the download to the exact version it was
          // triggered by, so the result is deterministic and the next connect
          // compares equal. Leaving it unpinned would re-download the same older
          // stable on every connect whenever stable lags the desktop — an
          // upgrade loop.
          version: staleByTarget && options.version === undefined ? options.daemonTargetVersion : options.version,
          workspace,
        });
        this.progress(onProgress, { id: 'install', status: 'done' });
      } catch (err) {
        // A staleness upgrade is opportunistic: it can 404 (a dev build's
        // version has no release) or fail transiently. An absent daemon and an
        // explicit pin have no fallback, so those still fail the connect; a
        // stale-but-working daemon is kept and the flow continues. The old
        // daemon is never stopped when the download fails (the installer stops
        // it only after the binary lands), so continuing is safe.
        const hardFailure =
          !probe.installed || (options.version !== undefined && options.version !== probe.version);
        if (hardFailure) {
          this.progress(onProgress, {
            id: 'install',
            status: 'failed',
            detail: messageOf(err),
          });
          throw new RemoteConnectionError('install', `Install failed: ${messageOf(err)}`, err);
        }
        this.progress(onProgress, {
          id: 'install',
          status: 'done',
          detail: `kept ${installedVersion ?? 'installed'}; upgrade to ${options.daemonTargetVersion} failed`,
        });
      }
    } else {
      this.progress(onProgress, {
        id: 'install',
        status: 'done',
        detail: 'already installed',
      });
    }

    // The probe above described the binary present BEFORE this step. When we
    // installed or upgraded, re-probe so the transport decision below reflects
    // what is actually on the remote now: a build that predates `--socket`
    // reports no socket support, so without this refresh an upgraded daemon
    // would be started in port mode and then adopted there forever.
    if (needsInstall) {
      try {
        probe = await this.bootstrapper.probe(alias);
      } catch {
        // A failed refresh must not fail the connect: keep the pre-install probe
        // and fall back to the transport it described.
      }
    }

    // 3. Workspace -------------------------------------------------------------
    this.progress(onProgress, { id: 'workspace', status: 'active' });
    try {
      await this.bootstrapper.ensureWorkspace(alias, workspace);
    } catch (err) {
      this.progress(onProgress, {
        id: 'workspace',
        status: 'failed',
        detail: messageOf(err),
      });
      throw new RemoteConnectionError(
        'workspace',
        `Failed to prepare ${workspace}: ${messageOf(err)}`,
        err,
      );
    }
    this.progress(onProgress, { id: 'workspace', status: 'done' });

    // 4. Token -----------------------------------------------------------------
    this.progress(onProgress, { id: 'token', status: 'active' });
    const suppliedToken = options.token;
    const token = suppliedToken ?? randomBytes(32).toString('hex');
    this.progress(onProgress, {
      id: 'token',
      status: 'done',
      detail: suppliedToken ? 'using supplied token' : 'generated',
    });

    // 5. Start (or reuse) ------------------------------------------------------
    this.progress(onProgress, { id: 'start', status: 'active' });
    // The remote binary advertises `--socket` support; when it does, prefer the
    // Unix-socket transport for this workspace.
    const supportsSocket = probe.supportsSocket === true;
    const socketPath = supportsSocket ? remoteSocketPathFor(workspace) : undefined;
    let daemon: RemoteDaemonState;
    try {
      daemon = await this.ensureDaemon(alias, workspace, token, options, socketPath);
    } catch (err) {
      this.progress(onProgress, { id: 'start', status: 'failed', detail: messageOf(err) });
      throw new RemoteConnectionError('start', `Failed to start daemon: ${messageOf(err)}`, err);
    }
    // The daemon reports the socket it actually bound (fresh start or adopted
    // running daemon); when present the tunnel forwards to it instead of a port.
    const effectiveSocket = daemon.socketPath;
    let remotePort = 0;
    if (effectiveSocket) {
      // A dual-listen daemon also exposes a TCP web port; surface it when known
      // so the operator sees both endpoints.
      const webPort =
        typeof daemon.port === 'number' && daemon.port > 0 ? daemon.port : undefined;
      this.progress(onProgress, {
        id: 'start',
        status: 'done',
        detail: webPort
          ? `listening on unix socket ${effectiveSocket} (web port ${webPort})`
          : `listening on unix socket ${effectiveSocket}`,
      });
    } else {
      remotePort = daemon.port ?? (await this.failMissingPort());
      this.progress(onProgress, {
        id: 'start',
        status: 'done',
        detail: `listening on 127.0.0.1:${remotePort}`,
      });
    }

    // 6. Tunnel ----------------------------------------------------------------
    this.progress(onProgress, { id: 'tunnel', status: 'active' });
    let tunnelPort: number;
    try {
      const host = this.resolveHost ? await this.resolveHost(alias) : undefined;
      const result = await this.tunnel.open({
        alias,
        hostName: host?.hostName,
        user: host?.user,
        port: host?.port,
        identityFile: host?.identityFile,
        localPort: options.localPort ?? DEFAULT_LOCAL_PORT,
        remotePort,
        ...(effectiveSocket ? { remoteSocketPath: effectiveSocket } : {}),
      });
      tunnelPort = result.localPort;
      // The forward being bound does not mean the daemon is accepting
      // connections yet; confirm readiness through the tunnel before handing
      // the URL to the gateway client.
      await this.probeReadyz(tunnelPort);
    } catch (err) {
      this.progress(onProgress, { id: 'tunnel', status: 'failed', detail: messageOf(err) });
      throw new RemoteConnectionError('tunnel', `Tunnel failed: ${messageOf(err)}`, err);
    }
    this.lastTunnelPort = tunnelPort;
    this.progress(onProgress, { id: 'tunnel', status: 'done', detail: `local port ${tunnelPort}` });

    // 7. Gateway client --------------------------------------------------------
    this.progress(onProgress, { id: 'client', status: 'active' });
    const localUrl = `ws://127.0.0.1:${tunnelPort}/ws`;
    // The gateway client's `workspaceRoot` is the LOCAL anchor for the reverse
    // RPC sandbox; the remote workspace is used only for the daemon's own state.
    const client = this.gatewayClientFactory({
      url: localUrl,
      workspaceRoot: workspace,
      deviceId: options.deviceId,
      token: daemon.token ?? token,
      onApprovalRequired: options.onApprovalRequired,
      onEvent: options.onEvent,
      onStateChange: options.onStateChange,
    });
    try {
      client.connect();
    } catch (err) {
      this.progress(onProgress, { id: 'client', status: 'failed', detail: messageOf(err) });
      throw new RemoteConnectionError('client', `Gateway client failed: ${messageOf(err)}`, err);
    }
    this.client = client;
    this.progress(onProgress, { id: 'client', status: 'done' });

    return { localUrl, tunnelPort, gatewayClient: client };
  }

  /**
   * Start the daemon, or reuse one that is already running.
   *
   * When the remote `server.json` reports a live daemon we adopt its port and
   * token instead of starting a second instance (which would fight over the
   * port and invalidate the running token). The one exception is a change to
   * `autoUpdateIdle`: the flag is only read at boot, so adopting would silently
   * ignore the user's choice — the daemon is stopped and restarted with the new
   * flags instead. Identical values never restart, and a caller that expresses
   * no preference (`undefined`) always adopts.
   *
   * A graceful `stop` deletes `server.json`, so the restart captures the running
   * daemon's port and token BEFORE stopping and replays them: the tunnel's fixed
   * remote port stays valid and already-paired clients keep working.
   */
  private async ensureDaemon(
    alias: string,
    workspace: string,
    token: string,
    options: RemoteConnectOptions,
    socketPath?: string,
  ): Promise<RemoteDaemonState> {
    let startPort = pickDaemonPort();
    let startToken = token;

    const status = await this.bootstrapper.status(alias, workspace);
    // A socket-mode daemon reports `port: 0`, so a port check alone would miss
    // it and fall through to a start — which, because the daemon is already
    // running, is a no-op that then loses the persisted token. Accept either
    // transport as evidence of a live daemon.
    if (status.running && (status.port || status.socketPath)) {
      const existing = await this.bootstrapper.readServerState(alias, workspace);
      const adoptedPort = existing?.port ?? status.port ?? 0;
      const running: RemoteDaemonState = existing
        ? {
            ...existing,
            running: true,
            port: adoptedPort,
            gatewayUrl: `ws://127.0.0.1:${adoptedPort}/ws`,
          }
        : {
            ...status,
            gatewayUrl: `ws://127.0.0.1:${adoptedPort}/ws`,
          };

      const requested = options.autoUpdateIdle;
      // `undefined` means the caller expressed no preference (the field was
      // never supplied), so the running daemon is adopted untouched. Only an
      // explicit value that disagrees triggers a restart.
      if (requested === undefined || (running.autoUpdateIdle === true) === requested) {
        return running;
      }

      // The setting changed: stop the running daemon, then start a fresh one
      // with the requested flags. The daemon's own persisted token is preferred
      // over the supplied one — the same precedence the adopt path and the
      // gateway client use, and the same reason `restartDaemonDetached` replays
      // `state.token` on a self-update respawn: minting a fresh gateway token
      // would invalidate every already-paired client. `status.port` is narrowed
      // to a number here, and when no state file exists there is no token to
      // preserve, so the supplied one stands.
      startPort = existing?.port ?? status.port ?? startPort;
      startToken = existing?.token ?? token;
      await this.bootstrapper.stop(alias, workspace);
    }

    return this.bootstrapper.start(alias, {
      port: startPort,
      token: startToken,
      workspace,
      autoUpdateIdle: options.autoUpdateIdle,
      autoUpdateIntervalHours: options.autoUpdateIntervalHours,
      ...(socketPath ? { socketPath } : {}),
    });
  }

  private async failMissingPort(): Promise<never> {
    throw new Error('daemon did not report a port');
  }

  /**
   * Close the gateway client and the tunnel.
   *
   * Deliberately does NOT stop the remote daemon: the whole point of a remote
   * VPS is that it keeps working when the laptop disappears. The daemon stays
   * up so a later reconnect (or another device) can reuse it.
   */
  async disconnect(): Promise<void> {
    this.client?.close();
    this.client = null;
    await this.tunnel.close();
  }

  /**
   * Run `superiu-server update` on the remote host over SSH.
   */
  async upgradeRemoteServer(): Promise<{ ok: boolean; stdout?: string; error?: string }> {
    const alias = this.lastOptions?.alias;
    if (!alias) {
      return { ok: false, error: 'No active remote connection' };
    }
    const res = await this.bootstrapper.runCommand(alias, `${REMOTE_BIN_PATH} update`);
    if (res.exitCode !== 0) {
      return { ok: false, error: res.stderr || res.stdout };
    }
    return { ok: true, stdout: res.stdout };
  }

  /**
   * Re-open the tunnel and gateway client for an already-provisioned host.
   * Skips probe/install/start when a previous connect populated them.
   */
  async reconnect(): Promise<RemoteConnectResult> {
    const options = this.lastOptions;
    if (!options) {
      throw new RemoteConnectionError(
        'probe',
        'reconnect() requires a prior successful connect() or explicit options',
      );
    }

    const workspace = options.workspace;
    const alias = options.alias;

    // Adopt the running daemon's current state (port/socket/token may have changed).
    const existing = await this.bootstrapper.readServerState(alias, workspace);
    const status = existing ?? (await this.bootstrapper.status(alias, workspace));
    const socketPath = status?.socketPath;
    const remotePort = status?.port ?? this.lastTunnelPort ?? 0;
    const token = status?.token ?? options.token ?? '';
    if (!socketPath && !remotePort) {
      throw new RemoteConnectionError(
        'start',
        'reconnect() found no running daemon; call connect() first',
      );
    }

    const tunnelPort =
      this.lastTunnelPort ??
      (
        await this.tunnel.open({
          alias,
          localPort: options.localPort ?? DEFAULT_LOCAL_PORT,
          remotePort,
          ...(socketPath ? { remoteSocketPath: socketPath } : {}),
        })
      ).localPort;

    const localUrl = `ws://127.0.0.1:${tunnelPort}/ws`;
    const client = this.gatewayClientFactory({
      url: localUrl,
      workspaceRoot: workspace,
      deviceId: options.deviceId,
      token,
      onApprovalRequired: options.onApprovalRequired,
      onEvent: options.onEvent,
    });
    client.connect();
    this.client = client;
    return { localUrl, tunnelPort, gatewayClient: client };
  }
}

/** Pick a stable-ish default remote port for a fresh daemon. */
function pickDaemonPort(): number {
  return 7345;
}

/**
 * Absolute path of the daemon's Unix domain socket inside a remote workspace.
 * `workspace` is a remote POSIX absolute path, so the join is done with the
 * POSIX implementation regardless of the local platform.
 */
function remoteSocketPathFor(workspace: string): string {
  return path.posix.join(workspace, '.superiu', 'server.sock');
}

/** Interval between `/readyz` retry attempts. */
const READYZ_RETRY_MS = 250;
/** Per-request timeout; short so a dead endpoint fails fast into a retry. */
const READYZ_REQUEST_TIMEOUT_MS = 1_000;

/**
 * Wait until the daemon behind the tunnel answers `GET /readyz` with 200.
 *
 * A non-200 status (for example 404 from an older daemon that predates the
 * endpoint) is treated as "assume ready": we cannot prove readiness but the
 * daemon is clearly answering HTTP, so refusing to connect would be worse than
 * proceeding. Connection errors are retried with a short backoff until the
 * timeout, then surfaced as a rejection.
 */
export async function waitForReadyz(tunnelPort: number, timeoutMs = 10_000): Promise<void> {
  const url = `http://127.0.0.1:${tunnelPort}/readyz`;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    const outcome = await probeReadyzOnce(url);
    if (outcome === 'ready' || outcome === 'assume-ready') return;
    lastError = outcome;
    if (Date.now() >= deadline) break;
    await delay(READYZ_RETRY_MS);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(
    `Daemon readiness check failed: no HTTP response from ${url} within ${timeoutMs}ms${detail}`,
  );
}

/** Single `/readyz` attempt: `ready`, `assume-ready`, or the connection error. */
function probeReadyzOnce(url: string): Promise<'ready' | 'assume-ready' | Error> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: 'ready' | 'assume-ready' | Error): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let req: http.ClientRequest;
    try {
      req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) finish('ready');
        else finish('assume-ready');
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    req.once('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
    req.setTimeout(READYZ_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`no response within ${READYZ_REQUEST_TIMEOUT_MS}ms`));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

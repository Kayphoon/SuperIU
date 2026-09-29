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

import { GatewayClient, type GatewayClientOptions } from '../gateway_client.js';
import {
  RemoteBootstrapper,
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
  /** Pre-generated pairing token; a fresh one is created when omitted. */
  token?: string;
  /** Local port to forward from; an ephemeral port is chosen when omitted. */
  localPort?: number;
  /** Progress callback for the UI. */
  onProgress?: (step: RemoteStep) => void;
  /** Shows a native approval prompt for dangerous commands. */
  onApprovalRequired?: GatewayClientOptions['onApprovalRequired'];
  /** Receives stream events from the gateway. */
  onEvent?: GatewayClientOptions['onEvent'];
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
    const needsInstall =
      !probe.installed || (options.version !== undefined && probe.version !== options.version);
    if (needsInstall) {
      this.progress(onProgress, { id: 'install', status: 'active' });
      try {
        await this.bootstrapper.install(alias, probe.arch, {
          releaseBase: options.releaseBase,
          version: options.version,
        });
      } catch (err) {
        this.progress(onProgress, {
          id: 'install',
          status: 'failed',
          detail: messageOf(err),
        });
        throw new RemoteConnectionError('install', `Install failed: ${messageOf(err)}`, err);
      }
      this.progress(onProgress, { id: 'install', status: 'done' });
    } else {
      this.progress(onProgress, {
        id: 'install',
        status: 'done',
        detail: 'already installed',
      });
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
    let daemon: RemoteDaemonState;
    try {
      daemon = await this.ensureDaemon(alias, workspace, token, options.version);
    } catch (err) {
      this.progress(onProgress, { id: 'start', status: 'failed', detail: messageOf(err) });
      throw new RemoteConnectionError('start', `Failed to start daemon: ${messageOf(err)}`, err);
    }
    const remotePort = daemon.port ?? (await this.failMissingPort());
    this.progress(onProgress, {
      id: 'start',
      status: 'done',
      detail: `listening on 127.0.0.1:${remotePort}`,
    });

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
      });
      tunnelPort = result.localPort;
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
   * port and invalidate the running token).
   */
  private async ensureDaemon(
    alias: string,
    workspace: string,
    token: string,
    _version: string | undefined,
  ): Promise<RemoteDaemonState> {
    const status = await this.bootstrapper.status(alias, workspace);
    if (status.running && status.port) {
      const existing = await this.bootstrapper.readServerState(alias, workspace);
      if (existing) {
        return {
          ...existing,
          running: true,
          port: existing.port ?? status.port,
          gatewayUrl: `ws://127.0.0.1:${existing.port ?? status.port}/ws`,
        };
      }
      return {
        ...status,
        gatewayUrl: `ws://127.0.0.1:${status.port}/ws`,
      };
    }

    return this.bootstrapper.start(alias, {
      port: pickDaemonPort(),
      token,
      workspace,
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

    // Adopt the running daemon's current state (port/token may have changed).
    const existing = await this.bootstrapper.readServerState(alias, workspace);
    const status = existing ?? (await this.bootstrapper.status(alias, workspace));
    const remotePort = status?.port ?? this.lastTunnelPort ?? 0;
    const token = status?.token ?? options.token ?? '';
    if (!remotePort) {
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

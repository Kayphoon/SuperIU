/**
 * SSH local port-forward manager.
 *
 * Opens `ssh -N -L <local>:127.0.0.1:<remote>` tunnels that expose a daemon
 * running on a remote VPS to the local machine, then keeps them alive.
 *
 * Readiness is established by polling a real TCP connect to the local port:
 * `ssh -N` prints nothing on success, so waiting for stdout would hang forever.
 *
 * `BatchMode=yes` is deliberate. A GUI-launched client has no TTY for ssh to
 * prompt on, so anything that would prompt (passphrase, host-key confirmation,
 * password) must fail fast with an actionable message instead of hanging.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';

/** Lifecycle state of a tunnel. */
export type SshTunnelState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

/** Options for {@link SshTunnelManager.open}. */
export interface SshTunnelOpenOptions {
  /** Host alias understood by the user's ssh config (used as the ssh target). */
  alias: string;
  /** Remote sshd port (`-p`). Omit to use ssh's own default. */
  port?: number;
  /** Private key (`-i`). */
  identityFile?: string;
  /** Remote user (`user@host`). */
  user?: string;
  /** Explicit hostname; when omitted the `alias` is used verbatim. */
  hostName?: string;
  /** Desired local port. If taken, a free ephemeral port replaces it. */
  localPort: number;
  /** Port on the remote host to forward to (bound to 127.0.0.1 remotely). */
  remotePort: number;
}

/** Result of {@link SshTunnelManager.open}. */
export interface SshTunnelOpenResult {
  /** The local port actually chosen (may differ from the requested one). */
  localPort: number;
}

/** Constructor callbacks for {@link SshTunnelManager}. */
export interface SshTunnelManagerOptions {
  onStateChange?: (state: SshTunnelState) => void;
  onError?: (error: Error) => void;
  /** Injectable spawn (tests); defaults to `node:child_process.spawn`. */
  spawnFn?: typeof spawn;
  /** Injectable readiness poll interval for fast tests. */
  readinessPollIntervalMs?: number;
  /** Injectable readiness timeout for fast tests. */
  readinessTimeoutMs?: number;
}

/** Backoff knobs for automatic restarts. */
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_FACTOR = 2;

const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
/** How long to wait for SIGTERM to take effect before escalating to SIGKILL. */
const SIGKILL_ESCALATION_MS = 3_000;

/** Returns true when the local port can be bound. Port 0 is not a bindable fixed port. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/** Ask the OS for an unused local port. */
export function pickFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.listen(0, host);
  });
}

/** Single attempt to open a TCP connection; resolves true when reachable. */
function probeTcp(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

/**
 * Manages a single ssh local-forward tunnel for one remote host.
 */
export class SshTunnelManager extends EventEmitter {
  private readonly opts: SshTunnelManagerOptions;
  private readonly spawnFn: typeof spawn;
  private readonly pollIntervalMs: number;
  private readonly readinessTimeoutMs: number;

  private child: ChildProcess | null = null;
  private openOptions: SshTunnelOpenOptions | null = null;
  private activeLocalPort: number | null = null;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the manager intends the tunnel to be up. */
  private shouldBeOpen = false;
  private state: SshTunnelState = 'idle';
  /** Captured ssh stderr, used to classify auth failures. */
  private stderrTail = '';

  constructor(options: SshTunnelManagerOptions = {}) {
    super();
    this.opts = options;
    this.spawnFn = options.spawnFn ?? spawn;
    this.pollIntervalMs = options.readinessPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  }

  /** Current tunnel state. */
  get tunnelState(): SshTunnelState {
    return this.state;
  }

  /** Port the tunnel is listening on, or null when not connected. */
  get localPort(): number | null {
    return this.activeLocalPort;
  }

  private setState(state: SshTunnelState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state);
    this.emit('state', state);
  }

  private reportError(error: Error): void {
    this.opts.onError?.(error);
    this.emit('error', error);
  }

  /**
   * Open the tunnel, resolving once the local port accepts connections.
   *
   * If the requested local port is in use, a free ephemeral port is chosen and
   * returned to the caller.
   */
  async open(options: SshTunnelOpenOptions): Promise<SshTunnelOpenResult> {
    this.openOptions = options;
    this.shouldBeOpen = true;
    this.restartAttempts = 0;

    const requested = options.localPort;
    let localPort = requested;
    if (!(await isPortFree(requested))) {
      localPort = await pickFreePort();
    }
    this.activeLocalPort = localPort;

    this.setState('connecting');
    try {
      await this.launch(localPort);
      this.setState('connected');
      this.restartAttempts = 0;
    } catch (err) {
      this.shouldBeOpen = false;
      this.killChild();
      this.setState('closed');
      throw err;
    }

    return { localPort };
  }

  /**
   * Spawn ssh and wait until the forward is actually reachable.
   */
  private async launch(localPort: number): Promise<void> {
    const options = this.openOptions;
    if (!options) throw new Error('SshTunnelManager.open must be called first');

    const args = this.buildArgs(options, localPort);
    const target = this.buildTarget(options);

    const child = this.spawnFn('ssh', [...args, target], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcess;

    this.child = child;
    this.stderrTail = '';

    let exited = false;
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4_096);
    });

    const onExit = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        exited = true;
        exitInfo = { code, signal };
        resolve();
      });
    });

    child.once('error', (err) => {
      this.reportError(err instanceof Error ? err : new Error(String(err)));
    });

    const connected = await this.waitForReady(localPort, () => exited, onExit);

    if (connected) {
      // Watch for later unexpected exits.
      child.once('exit', () => {
        if (this.child === child) {
          this.child = null;
          if (this.shouldBeOpen) this.scheduleRestart();
        }
      });
      return;
    }

    this.killChild();

    if (exited && exitInfo) {
      const info = exitInfo as { code: number | null; signal: NodeJS.Signals | null };
      const authFailure = /permission denied|authentication failed|no supported authentication/i.test(
        this.stderrTail,
      );
      if (authFailure) {
        throw new Error(
          'SSH authentication failed — ensure your key is loaded in ssh-agent ' +
            '(or is passphrase-less) and that the host is trusted.',
        );
      }
      throw new Error(
        `ssh tunnel exited before the forward was ready (code ${info.code ?? 'null'}` +
          `${info.signal ? `, signal ${info.signal}` : ''}). ` +
          `stderr: ${this.stderrTail.trim() || '<empty>'}`,
      );
    }

    throw new Error(
      `Timed out after ${this.readinessTimeoutMs}ms waiting for the ssh tunnel on 127.0.0.1:${localPort}. ` +
        `ssh may be prompting for confirmation, which BatchMode=yes forbids. ` +
        `stderr: ${this.stderrTail.trim() || '<empty>'}`,
    );
  }

  /** Build the ssh argument list (excluding the target). */
  private buildArgs(options: SshTunnelOpenOptions, localPort: number): string[] {
    const args = [
      '-N',
      '-L',
      `${localPort}:127.0.0.1:${options.remotePort}`,
      // When a user has other unrelated LocalForward entries in ~/.ssh/config
      // that fail to bind locally, ExitOnForwardFailure=yes would prematurely
      // abort this dedicated tunnel. Since we probe readiness ourselves via
      // TCP connection test, keep ExitOnForwardFailure=no so unrelated binds don't kill us.
      '-o',
      'ExitOnForwardFailure=no',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'BatchMode=yes',
    ];
    if (options.port !== undefined) args.push('-p', String(options.port));
    if (options.identityFile) args.push('-i', options.identityFile);
    return args;
  }

  /** Build the `user@host` (or bare alias) ssh target. */
  private buildTarget(options: SshTunnelOpenOptions): string {
    const host = options.hostName ?? options.alias;
    return options.user ? `${options.user}@${host}` : host;
  }

  /**
   * Poll the local port until it accepts a connection, the child exits, or the
   * timeout elapses.
   */
  private waitForReady(
    localPort: number,
    hasExited: () => boolean,
    exitPromise: Promise<void>,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const deadline = Date.now() + this.readinessTimeoutMs;

      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        resolve(ok);
      };

      const tick = async (): Promise<void> => {
        if (settled) return;
        if (hasExited()) {
          finish(false);
          return;
        }
        if (Date.now() > deadline) {
          finish(false);
          return;
        }
        if (await probeTcp(localPort)) finish(true);
      };

      const timer = setInterval(() => void tick(), this.pollIntervalMs);
      void tick();

      void exitPromise.then(() => finish(false));
    });
  }

  /** Schedule an automatic restart with capped exponential backoff. */
  private scheduleRestart(): void {
    if (!this.shouldBeOpen) return;
    this.setState('reconnecting');
    const delay = Math.min(
      INITIAL_BACKOFF_MS * BACKOFF_FACTOR ** this.restartAttempts,
      MAX_BACKOFF_MS,
    );
    this.restartAttempts += 1;

    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restart();
    }, delay);
  }

  private async restart(): Promise<void> {
    if (!this.shouldBeOpen) return;
    const options = this.openOptions;
    const localPort = this.activeLocalPort;
    if (!options || localPort === null) return;

    try {
      await this.launch(localPort);
      this.setState('connected');
      this.restartAttempts = 0;
    } catch (err) {
      this.reportError(err instanceof Error ? err : new Error(String(err)));
      if (this.shouldBeOpen) this.scheduleRestart();
    }
  }

  /** SIGTERM the child, escalating to SIGKILL after a grace period. */
  private killChild(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;

    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, SIGKILL_ESCALATION_MS);

    child.once('exit', () => clearTimeout(killTimer));
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(killTimer);
    }
  }

  /**
   * Close the tunnel and stop auto-restarting. Idempotent.
   */
  async close(): Promise<void> {
    this.shouldBeOpen = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.killChild();
    this.setState('closed');
  }
}

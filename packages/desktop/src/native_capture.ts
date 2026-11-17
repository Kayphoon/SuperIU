/**
 * Lifecycle of the embedded macOS capture helper (`SuperIUNative`).
 *
 * The Swift helper owns the menu-bar item, the Carbon global shortcuts and the
 * screenshot/clipboard UI. Electron only launches it in hosted mode, watches
 * the single ready line it prints, and stops it during app shutdown.
 *
 * The helper's stdin is a pipe whose EOF terminates the helper. That is the
 * orphan guard: if Electron dies abruptly the pipe closes and the helper exits
 * with it, so no menu-bar process survives the app.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  NativeCaptureSettingsError,
  parseNativeCaptureConfiguration,
  type NativeCaptureConfiguration
} from './native_capture_settings.js';

export const NATIVE_READY_LINE = 'SUPERIU_NATIVE_READY';

const HELPER_ARGS: readonly string[] = ['--hosted'];

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const FORCE_KILL_WAIT_MS = 1_000;
const MAX_LOG_CHARS = 400;
const MAX_STREAM_BUFFER = 8 * 1024;

export type NativeCaptureLogLevel = 'info' | 'warn';

export interface NativeCaptureOptions {
  readonly binaryPath: string;
  readonly readyTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly log?: (level: NativeCaptureLogLevel, message: string) => void;
  readonly onSettings?: (configuration: NativeCaptureConfiguration) => void;
}

/**
 * Whether this host can run the helper at all.
 *
 * The Swift package targets macOS 14. Linux and older macOS versions simply do
 * not start it: capture is unavailable, never an application failure.
 */
export function isNativeCaptureSupported(
  platform: NodeJS.Platform,
  systemVersion: string
): boolean {
  if (platform !== 'darwin') return false;
  const major = Number.parseInt(systemVersion, 10);
  return Number.isFinite(major) && major >= 14;
}

function errorCode(error: Error): string | undefined {
  if (!('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function defaultLog(level: NativeCaptureLogLevel, message: string): void {
  const line = `[native-capture] ${message}`;
  if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * One hosted helper process.
 *
 * `start` is idempotent for the lifetime of the instance: a second call returns
 * the first result instead of spawning a second menu-bar process. `stop` is
 * idempotent in the same way and can race `start` safely - it closes over the
 * live child, asks it to quit, and escalates to SIGKILL only for that child.
 */
export class NativeCapture {
  private readonly binaryPath: string;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly log: (level: NativeCaptureLogLevel, message: string) => void;

  private child: ChildProcess | null = null;
  private state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' = 'idle';
  private startPromise: Promise<boolean> | null = null;
  private stopPromise: Promise<void> | null = null;
  private settleStart: ((started: boolean) => void) | null = null;
  private readonly onSettings: NativeCaptureOptions['onSettings'];
  private nextRequestId = 0;
  private readonly requests = new Map<number, {
    readonly resolve: (configuration: NativeCaptureConfiguration) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();

  constructor(options: NativeCaptureOptions) {
    this.binaryPath = options.binaryPath;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.log = options.log ?? defaultLog;
    this.onSettings = options.onSettings;
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  getSettings(): Promise<NativeCaptureConfiguration> {
    return this.request('getSettings');
  }

  configure(configuration: NativeCaptureConfiguration): Promise<NativeCaptureConfiguration> {
    return this.request('configure', parseNativeCaptureConfiguration(configuration));
  }

  async clearHistory(): Promise<void> {
    await this.request('clearHistory');
  }

  private request(
    action: 'getSettings' | 'configure' | 'clearHistory',
    settings?: NativeCaptureConfiguration
  ): Promise<NativeCaptureConfiguration> {
    const child = this.child;
    if (!this.isRunning || !child?.stdin || child.stdin.destroyed) {
      return Promise.reject(new NativeCaptureSettingsError('Capture helper is not running.'));
    }
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new NativeCaptureSettingsError('Capture helper did not respond to the settings request.'));
      }, this.readyTimeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      child.stdin?.write(JSON.stringify({ id, action, ...(settings ? { settings } : {}) }) + '\n');
    });
  }

  private receiveSettings(line: string): void {
    const responsePrefix = 'SUPERIU_NATIVE_RESPONSE ';
    const eventPrefix = 'SUPERIU_NATIVE_SETTINGS ';
    const isResponse = line.startsWith(responsePrefix);
    if (!isResponse && !line.startsWith(eventPrefix)) return;
    let request: ReturnType<typeof this.requests.get>;
    try {
      const payload: unknown = JSON.parse(line.slice(isResponse ? responsePrefix.length : eventPrefix.length));
      if (!isResponse) {
        this.onSettings?.(parseNativeCaptureConfiguration(payload));
        return;
      }
      if (
        typeof payload !== 'object' || payload === null ||
        !('id' in payload) || typeof payload.id !== 'number'
      ) throw new NativeCaptureSettingsError('Invalid capture settings response.');
      request = this.requests.get(payload.id);
      if (!request) return;
      this.requests.delete(payload.id);
      clearTimeout(request.timer);
      if ('ok' in payload && payload.ok === true && 'settings' in payload) {
        request.resolve(parseNativeCaptureConfiguration(payload.settings));
      } else {
        request.reject(new NativeCaptureSettingsError(
          'error' in payload && typeof payload.error === 'string'
            ? payload.error : 'Capture settings could not be applied.'
        ));
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new NativeCaptureSettingsError(String(error));
      if (request) request.reject(failure);
      this.log('warn', `invalid settings message: ${failure.message}`);
    }
  }

  private rejectRequests(): void {
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new NativeCaptureSettingsError('Capture helper stopped before applying settings.'));
    }
    this.requests.clear();
  }

  /**
   * Spawn the helper and resolve true once it prints {@link NATIVE_READY_LINE}.
   *
   * Failures are reported through `log` and resolve false: a missing or
   * misbehaving helper disables capture, it never takes the app down.
   */
  start(): Promise<boolean> {
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'idle') return Promise.resolve(this.state === 'running');
    const promise = this.launch();
    this.startPromise = promise;
    return promise;
  }

  private launch(): Promise<boolean> {
    this.state = 'starting';

    const child = spawn(this.binaryPath, [...HELPER_ARGS], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let readyTimer: NodeJS.Timeout | undefined;

      const finishStart = (started: boolean): void => {
        if (settled) return;
        settled = true;
        this.settleStart = null;
        clearTimeout(readyTimer);
        resolve(started);
      };
      this.settleStart = finishStart;

      readyTimer = setTimeout(() => {
        if (settled) return;
        this.log('warn', `no ${NATIVE_READY_LINE} within ${this.readyTimeoutMs}ms; stopping`);
        finishStart(false);
        void this.stop();
      }, this.readyTimeoutMs);

      child.once('error', (error) => {
        const code = errorCode(error);
        const reason =
          code === 'ENOENT'
            ? `not found at ${this.binaryPath}; run swift build or reinstall the packaged app`
            : error.message;
        this.log('warn', `helper failed to start: ${reason}`);
        if (this.child === child) this.child = null;
        if (this.state !== 'stopping' && this.state !== 'stopped') this.state = 'stopped';
        finishStart(false);
      });

      child.once('exit', (code, signal) => {
        this.rejectRequests();
        if (this.child === child) this.child = null;
        if (this.state !== 'stopping' && this.state !== 'stopped') {
          this.state = 'stopped';
          this.log('warn', `helper exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
        }
        finishStart(false);
      });

      let stdoutBuffer = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        if (stdoutBuffer.length > MAX_STREAM_BUFFER) {
          stdoutBuffer = stdoutBuffer.slice(-MAX_STREAM_BUFFER);
        }
        let newline = stdoutBuffer.indexOf('\n');
        while (newline !== -1) {
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line === NATIVE_READY_LINE && this.state === 'starting') {
            this.state = 'running';
            this.log('info', 'helper ready');
            finishStart(true);
          }
          this.receiveSettings(line);
          newline = stdoutBuffer.indexOf('\n');
        }
      });

      let stderrBuffer = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderrBuffer += chunk;
        if (stderrBuffer.length > MAX_STREAM_BUFFER) {
          stderrBuffer = stderrBuffer.slice(-MAX_STREAM_BUFFER);
        }
        let newline = stderrBuffer.indexOf('\n');
        while (newline !== -1) {
          const line = stderrBuffer.slice(0, newline).trim();
          stderrBuffer = stderrBuffer.slice(newline + 1);
          if (line) this.log('warn', `helper: ${line.slice(0, MAX_LOG_CHARS)}`);
          newline = stderrBuffer.indexOf('\n');
        }
      });

      // The helper may exit before a quit is written; EPIPE is expected then.
      child.stdin?.on('error', (error) => {
        if (errorCode(error) === 'EPIPE') return;
        this.log('warn', `helper stdin: ${error.message}`);
      });
    });
  }

  /**
   * Ask the helper to quit, then close stdin so EOF terminates it regardless.
   * Wait `stopTimeoutMs` for exit, force-killing only this owned child if it
   * remains unresponsive.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.shutdown();
    return this.stopPromise;
  }

  private async shutdown(): Promise<void> {
    this.rejectRequests();
    // A close that lands while start is still settling unblocks `start()` now;
    // the ready line, if it still arrives, can no longer claim the state.
    this.settleStart?.(false);

    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      return;
    }

    this.state = 'stopping';
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });

    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write('quit\n');
        child.stdin.end();
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log('warn', `could not ask helper to quit: ${reason}`);
    }

    if (!(await settlesWithin(exited, this.stopTimeoutMs))) {
      this.log('warn', `helper did not exit within ${this.stopTimeoutMs}ms; force-killing`);
      try {
        child.kill('SIGKILL');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.log('warn', `could not force-kill helper: ${reason}`);
      }
      await settlesWithin(exited, FORCE_KILL_WAIT_MS);
    }

    if (this.child === child) this.child = null;
    this.state = 'stopped';
  }
}

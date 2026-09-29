import type { RpcMethod, RpcParamsMap, RpcResultMap } from '@agent/protocol';
import type { ExecutionContext } from './types.js';

/** Thrown when the target desktop device cannot be reached. */
export class TargetDeviceOfflineError extends Error {
  readonly deviceId?: string;
  readonly reason: 'not_connected' | 'timeout' | 'disconnected' | 'rpc_error';

  constructor(
    deviceId: string | undefined,
    reason: TargetDeviceOfflineError['reason'],
    message?: string
  ) {
    super(
      message ??
        `Target desktop device${deviceId ? ` "${deviceId}"` : ''} is offline (${reason}).`
    );
    this.name = 'TargetDeviceOfflineError';
    this.deviceId = deviceId;
    this.reason = reason;
  }
}

/**
 * Dispatches an RPC call to the connected desktop client.
 *
 * Implementations are responsible for the actual transport (WebSocket gateway,
 * in-memory test double, ...) and MUST reject with a
 * {@link TargetDeviceOfflineError} when the device is unreachable, times out,
 * or the connection drops mid-call.
 */
export type RpcDelegate = <M extends RpcMethod>(
  method: M,
  params: RpcParamsMap[M],
  deviceId?: string
) => Promise<RpcResultMap[M]>;

export interface RemoteDesktopExecutionContextOptions {
  deviceId?: string;
  workspaceDir: string;
  spilloverDir?: string;
  /** Dispatches typed JSON-RPC calls to the desktop client. */
  delegate: RpcDelegate;
}

/**
 * Routes filesystem and command execution to a connected desktop device over
 * JSON-RPC. This is the counterpart to {@link LocalExecutionContext}: tools
 * written against `ExecutionContext` become location agnostic.
 */
export class RemoteDesktopExecutionContext implements ExecutionContext {
  readonly location = 'desktop' as const;
  readonly deviceId?: string;
  readonly workspaceDir: string;
  readonly spilloverDir?: string;

  private readonly delegate: RpcDelegate;

  constructor(options: RemoteDesktopExecutionContextOptions) {
    this.deviceId = options.deviceId;
    this.workspaceDir = options.workspaceDir;
    this.spilloverDir = options.spilloverDir;
    this.delegate = options.delegate;
  }

  private async dispatch<M extends RpcMethod>(
    method: M,
    params: RpcParamsMap[M]
  ): Promise<RpcResultMap[M]> {
    try {
      return await this.delegate(method, params, this.deviceId);
    } catch (err: unknown) {
      if (err instanceof TargetDeviceOfflineError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const reason = /timeout|timed out/i.test(message) ? 'timeout' : 'rpc_error';
      throw new TargetDeviceOfflineError(this.deviceId, reason, message);
    }
  }

  async readFile(params: { path: string; offset?: number; limit?: number }): Promise<string> {
    const result = await this.dispatch('fs.readFile', {
      path: params.path,
      offset: params.offset,
      limit: params.limit
    });
    return result.content;
  }

  async writeFile(params: { path: string; content: string }): Promise<{ bytesWritten: number }> {
    return this.dispatch('fs.writeFile', {
      path: params.path,
      content: params.content
    });
  }

  async executeCommand(params: {
    command: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{
    stdout: string;
    stderr: string;
    exitCode?: number;
    isCanceled?: boolean;
    timedOut?: boolean;
  }> {
    const result = await this.dispatch('bash.execute', {
      command: params.command,
      cwd: this.workspaceDir,
      timeoutMs: params.timeoutMs
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  }
}

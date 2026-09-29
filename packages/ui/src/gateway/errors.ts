/**
 * Errors raised by the VPS Gateway.
 *
 * These are deliberately concrete classes rather than bare `Error`s so callers
 * (the gateway server, the agent loop, tests) can discriminate on the failure
 * without matching on a message string.
 */

/**
 * Thrown when an RPC targets a device that is not currently connected, or when
 * a device drops while an RPC is in flight.
 *
 * Any pending RPC promises belonging to a disconnected device are rejected with
 * this error, so a caller waiting on a remote file read or shell command can
 * tell "the device is gone" apart from "the command failed".
 */
export class TargetDeviceOfflineError extends Error {
  /** Device the RPC was addressed to. */
  public readonly deviceId: string;
  /** RPC method that was being invoked, when known. */
  public readonly method: string | undefined;

  constructor(deviceId: string, method?: string, message?: string) {
    super(
      message ??
        `Target device '${deviceId}' is offline${method ? ` (method '${method}')` : ''}.`
    );
    this.name = 'TargetDeviceOfflineError';
    this.deviceId = deviceId;
    this.method = method;
    // Restore the prototype chain after transpilation targeting ES5-style
    // classes; harmless on ES2022 but keeps `instanceof` reliable everywhere.
    Object.setPrototypeOf(this, TargetDeviceOfflineError.prototype);
  }
}

/** Thrown when an RPC response does not arrive within the caller's timeout. */
export class RpcTimeoutError extends Error {
  public readonly deviceId: string;
  public readonly method: string | undefined;
  public readonly timeoutMs: number;

  constructor(deviceId: string, method: string | undefined, timeoutMs: number) {
    super(
      `RPC to device '${deviceId}'${method ? ` (method '${method}')` : ''} timed out after ${timeoutMs}ms.`
    );
    this.name = 'RpcTimeoutError';
    this.deviceId = deviceId;
    this.method = method;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, RpcTimeoutError.prototype);
  }
}

/** Thrown when a client completes a JSON-RPC response with an `error` object. */
export class RemoteRpcError extends Error {
  public readonly code: number;
  public readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RemoteRpcError';
    this.code = code;
    this.data = data;
    Object.setPrototypeOf(this, RemoteRpcError.prototype);
  }
}

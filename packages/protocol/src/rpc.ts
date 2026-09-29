/**
 * JSON-RPC 2.0 style request/response envelopes used for client <-> server calls.
 */

/** Standard JSON-RPC 2.0 protocol version string. */
export const JSON_RPC_VERSION = '2.0' as const;

export type JsonRpcVersion = typeof JSON_RPC_VERSION;

/** A JSON-RPC request originating from either side of the connection. */
export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  jsonrpc: JsonRpcVersion;
  id: string | number;
  method: M;
  params: RpcParamsMap[M];
}

/** A successful JSON-RPC response. */
export interface RpcSuccessResponse<M extends RpcMethod = RpcMethod> {
  jsonrpc: JsonRpcVersion;
  id: string | number;
  result: RpcResultMap[M];
  error?: never;
}

/** A failed JSON-RPC response. */
export interface RpcErrorResponse {
  jsonrpc: JsonRpcVersion;
  id: string | number | null;
  error: RpcError;
  result?: never;
}

/** JSON-RPC error object. */
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Any JSON-RPC response. */
export type RpcResponse<M extends RpcMethod = RpcMethod> =
  | RpcSuccessResponse<M>
  | RpcErrorResponse;

// ---------------------------------------------------------------------------
// fs.readFile
// ---------------------------------------------------------------------------

export interface FsReadFileParams {
  path: string;
  /** Byte offset to start reading from. */
  offset?: number;
  /** Maximum number of bytes (or lines, per implementation) to read. */
  limit?: number;
}

export interface FsReadFileResult {
  content: string;
}

// ---------------------------------------------------------------------------
// fs.writeFile
// ---------------------------------------------------------------------------

export interface FsWriteFileParams {
  path: string;
  content: string;
}

export interface FsWriteFileResult {
  bytesWritten: number;
}

// ---------------------------------------------------------------------------
// bash.execute
// ---------------------------------------------------------------------------

export interface BashExecuteParams {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface BashExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// review.confirm
// ---------------------------------------------------------------------------

export interface ReviewConfirmParams {
  command: string;
  reason?: string;
}

export interface ReviewConfirmResult {
  approved: boolean;
}

/** Registry mapping RPC method names to their parameter types. */
export interface RpcParamsMap {
  'fs.readFile': FsReadFileParams;
  'fs.writeFile': FsWriteFileParams;
  'bash.execute': BashExecuteParams;
  'review.confirm': ReviewConfirmParams;
}

/** Registry mapping RPC method names to their result types. */
export interface RpcResultMap {
  'fs.readFile': FsReadFileResult;
  'fs.writeFile': FsWriteFileResult;
  'bash.execute': BashExecuteResult;
  'review.confirm': ReviewConfirmResult;
}

/** Union of all supported RPC method names. */
export type RpcMethod = keyof RpcParamsMap;

/** Well known JSON-RPC error codes. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

/** Helper to construct a typed RPC request. */
export function createRpcRequest<M extends RpcMethod>(
  id: string | number,
  method: M,
  params: RpcParamsMap[M],
): RpcRequest<M> {
  return { jsonrpc: JSON_RPC_VERSION, id, method, params };
}

/** Type guard for a JSON-RPC request envelope. */
export function isRpcRequest(value: unknown): value is RpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<RpcRequest>;
  return (
    v.jsonrpc === JSON_RPC_VERSION &&
    (typeof v.id === 'string' || typeof v.id === 'number') &&
    typeof v.method === 'string'
  );
}

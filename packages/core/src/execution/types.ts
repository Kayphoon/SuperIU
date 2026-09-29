/**
 * ExecutionContext abstracts *where* filesystem and command operations run.
 *
 * Historically tools executed directly against local `node:fs` / `execa`.
 * Introducing this seam lets the same tools run either on the server (VPS)
 * or on a connected desktop client over JSON-RPC.
 */

export interface ExecutionContext {
  /** Where the operations physically execute. */
  location: 'server' | 'desktop';
  /** Identifier of the connected desktop device, when `location === 'desktop'`. */
  deviceId?: string;
  /** Workspace root that relative paths resolve against. */
  workspaceDir: string;
  /** Optional directory used for spilled/truncated command output. */
  spilloverDir?: string;

  readFile(params: { path: string; offset?: number; limit?: number }): Promise<string>;

  writeFile(params: { path: string; content: string }): Promise<{ bytesWritten: number }>;

  executeCommand(params: {
    command: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{
    stdout: string;
    stderr: string;
    exitCode?: number;
    isCanceled?: boolean;
    timedOut?: boolean;
  }>;
}

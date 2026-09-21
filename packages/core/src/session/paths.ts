import * as path from 'node:path';

export const SESSION_FILE_EXTENSION = '.jsonl';

/**
 * Encode a workspace path into a single safe directory name.
 *
 * Path separators (and Windows drive colons) become `-`:
 * `/Users/kayphoon/SuperIU` -> `-Users-kayphoon-SuperIU`.
 */
export function encodeCwd(cwd: string): string {
  const absolute = path.resolve(cwd);
  const encoded = absolute.replace(/[:/\\]+/g, '-');
  return encoded || '-';
}

/** Root directory holding all workspace buckets: `<base>/.myagent/sessions`. */
export function getSessionsRoot(workspaceDir?: string): string {
  const base = workspaceDir ? path.resolve(workspaceDir) : process.cwd();
  return path.join(base, '.myagent', 'sessions');
}

/** Bucket directory for one workspace: `<base>/.myagent/sessions/<encoded-cwd>`. */
export function getSessionDir(cwd: string = process.cwd(), workspaceDir?: string): string {
  return path.join(getSessionsRoot(workspaceDir), encodeCwd(cwd));
}

/** Compact, filename-safe rendering of an epoch-millisecond timestamp. */
export function formatFileTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/[:.]/g, '-');
}

/** `<timestamp>_<sessionId>.jsonl` inside the workspace bucket. */
export function createSessionFilePath(
  sessionId: string,
  timestamp: number = Date.now(),
  cwd: string = process.cwd(),
  workspaceDir?: string
): string {
  return path.join(
    getSessionDir(cwd, workspaceDir),
    `${formatFileTimestamp(timestamp)}_${sessionId}${SESSION_FILE_EXTENSION}`
  );
}

/** Generate a session id: 16 lowercase hex characters. */
export function createSessionId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

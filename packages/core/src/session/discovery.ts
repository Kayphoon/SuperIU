import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionHeader } from './types.js';
import { getSessionDir, SESSION_FILE_EXTENSION } from './paths.js';

export interface SessionDescriptor extends SessionHeader {
  filePath: string;
  mtimeMs: number;
}

/** All sessions in one workspace bucket, newest first. */
export function listSessions(
  cwd: string = process.cwd(),
  workspaceDir?: string
): SessionDescriptor[] {
  const dir = getSessionDir(cwd, workspaceDir);

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const descriptors: SessionDescriptor[] = [];

  for (const name of names) {
    if (!name.endsWith(SESSION_FILE_EXTENSION)) continue;

    const filePath = path.join(dir, name);
    try {
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      const firstLine = content.split('\n', 1)[0];
      if (!firstLine) continue;
      const header = JSON.parse(firstLine) as SessionHeader;
      if (header?.type !== 'session' || typeof header.id !== 'string') continue;
      descriptors.push({ ...header, filePath, mtimeMs: stat.mtimeMs });
    } catch {
      continue;
    }
  }

  // mtime is authoritative for recency: files created within the same millisecond
  // share a header timestamp, but only one was written last.
  return descriptors.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Newest session file in the workspace bucket, or null when none exists. */
export function findMostRecentSession(
  cwd: string = process.cwd(),
  workspaceDir?: string
): string | null {
  return listSessions(cwd, workspaceDir)[0]?.filePath ?? null;
}

/** Resolve a session by full path, file name, session id, or session-id prefix. */
export function resolveSessionFile(
  reference: string,
  cwd: string = process.cwd(),
  workspaceDir?: string
): string | null {
  if (path.isAbsolute(reference) && fs.existsSync(reference)) {
    return reference;
  }

  const sessions = listSessions(cwd, workspaceDir);

  for (const session of sessions) {
    if (path.basename(session.filePath) === reference || session.id === reference) {
      return session.filePath;
    }
  }

  for (const session of sessions) {
    if (session.id.startsWith(reference) || path.basename(session.filePath).startsWith(reference)) {
      return session.filePath;
    }
  }

  return null;
}

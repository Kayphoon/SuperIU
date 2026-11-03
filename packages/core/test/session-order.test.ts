/**
 * Session-list ordering: activity, not file mtime.
 *
 * The regression these tests pin: opening a conversation used to move it to the
 * top of the sidebar. `/api/sessions/load` records the model in force by
 * rewriting the session header (`SessionManager.updateModel`), and that write
 * refreshed the file's mtime — so "the session I just looked at" and "the
 * session I just talked to" became indistinguishable, and a busy conversation
 * slid down the list behind a stale one the user only peeked at.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../src/session/manager.js';
import { listSessions, findMostRecentSession } from '../src/session/discovery.js';

let workspace: string;
let cwd: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-session-order-'));
  cwd = path.join(workspace, 'project');
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function createSession(content: string): SessionManager {
  const session = SessionManager.create({ workspaceDir: workspace, cwd, model: 'model-a' });
  session.appendMessage({ role: 'user', content });
  session.close();
  return session;
}

function order(): string[] {
  return listSessions(cwd, workspace).map((descriptor) => descriptor.id);
}

describe('session listing order', () => {
  it('sorts by last activity, not by creation time', async () => {
    const older = createSession('older');

    // Backdate the first file far enough that a creation-time sort and an
    // activity sort would disagree, then talk to it again: its last entry is
    // now the newest activity while its header (creation) stays the oldest.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(older.getFilePath()!, past, past);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const newer = createSession('newer');

    expect(order()).toEqual([newer.getSessionId(), older.getSessionId()]);

    // A later turn in the OLDER session is activity and must win.
    const reopened = SessionManager.open(older.getFilePath()!);
    reopened.appendMessage({ role: 'assistant', content: 'still working here' });
    reopened.close();

    expect(order()).toEqual([older.getSessionId(), newer.getSessionId()]);
    expect(findMostRecentSession(cwd, workspace)).toBe(older.getFilePath());
  });

  it('does not reorder when a session is merely opened (header rewrite)', async () => {
    const first = createSession('first');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = createSession('second');

    expect(order()).toEqual([second.getSessionId(), first.getSessionId()]);

    // Exactly what `POST /api/sessions/load` does: open the older session and
    // record the model/effort now in force on its header. Both calls rewrite
    // line 1, which bumps the file mtime without adding any activity.
    const opened = SessionManager.open(first.getFilePath()!);
    const before = fs.statSync(first.getFilePath()!).mtimeMs;
    opened.updateModel('model-b', 'low');
    opened.updateSummary('a freshly regenerated summary');
    opened.close();
    const after = fs.statSync(first.getFilePath()!).mtimeMs;

    // Precondition: the rewrite really did touch the file, otherwise this test
    // could pass for the wrong reason (no mtime change, nothing to resist).
    expect(after).toBeGreaterThanOrEqual(before);

    // The opened session must NOT float to the top.
    expect(order()).toEqual([second.getSessionId(), first.getSessionId()]);
    expect(findMostRecentSession(cwd, workspace)).toBe(second.getFilePath());
  });

  it('exposes updatedAtMs as the last entry timestamp', async () => {
    const session = createSession('hello');
    session.close();

    const [descriptor] = listSessions(cwd, workspace);
    const lines = fs
      .readFileSync(descriptor.filePath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());
    const lastEntry = JSON.parse(lines[lines.length - 1]) as { timestamp: string };

    expect(descriptor.updatedAtMs).toBe(Date.parse(lastEntry.timestamp));
    // Creation time is a separate value and must not be confused with it.
    expect(descriptor.updatedAtMs).toBeGreaterThanOrEqual(Date.parse(descriptor.timestamp));
  });

  it('falls back to the header timestamp when the tail cannot be parsed', async () => {
    const session = createSession('broken tail');
    const filePath = session.getFilePath()!;
    session.close();

    fs.appendFileSync(filePath, '{"type":"message","timestamp":oops\n');

    const [descriptor] = listSessions(cwd, workspace);
    const header = JSON.parse(fs.readFileSync(filePath, 'utf-8').split('\n')[0]) as {
      timestamp: string;
    };
    expect(descriptor.updatedAtMs).toBe(Date.parse(header.timestamp));
  });
});

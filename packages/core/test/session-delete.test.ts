import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRunner } from '../src/runner.js';
import { SessionManager } from '../src/session/manager.js';
import { listSessions, deleteSessionFile } from '../src/session/discovery.js';

describe('Session deletion', () => {
  let workspace: string;
  let cwd: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-session-delete-'));
    cwd = path.join(workspace, 'project');
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function createPersistedSession(content: string): SessionManager {
    const session = SessionManager.create({ workspaceDir: workspace, cwd: workspace, model: 'model-a' });
    session.appendMessage({ role: 'user', content });
    session.close();
    return session;
  }

  it('deleteSessionFile unlinks resolved file and returns false for missing session', () => {
    const session = createPersistedSession('hello world');
    const filePath = session.getFilePath()!;
    expect(fs.existsSync(filePath)).toBe(true);

    const deleted = deleteSessionFile(session.getSessionId(), workspace, workspace);
    expect(deleted).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);

    const deletedAgain = deleteSessionFile(session.getSessionId(), workspace, workspace);
    expect(deletedAgain).toBe(false);
  });

  it('runner.deleteSession deletes an inactive session without interrupting active session', () => {
    const inactiveSession = createPersistedSession('session 1');
    const inactiveId = inactiveSession.getSessionId();
    const inactiveFile = inactiveSession.getFilePath()!;

    const runner = new AgentRunner({ workspaceDir: workspace, newSession: true });
    const activeId = runner.getSessionId();
    expect(activeId).not.toBe(inactiveId);

    expect(listSessions(workspace, workspace).some((s) => s.id === inactiveId)).toBe(true);

    const result = runner.deleteSession(inactiveId);
    expect(result.deletedId).toBe(inactiveId);
    expect(result.activeDeleted).toBe(false);
    expect(fs.existsSync(inactiveFile)).toBe(false);

    expect(runner.getSessionId()).toBe(activeId);
    expect(listSessions(workspace, workspace).some((s) => s.id === inactiveId)).toBe(false);
  });

  it('runner.deleteSession deletes active session and creates fresh draft session', () => {
    const runner = new AgentRunner({ workspaceDir: workspace });
    runner.session.appendMessage({ role: 'user', content: 'active conversation' });
    const activeId = runner.getSessionId();
    const activeFile = runner.getSessionFile()!;

    expect(fs.existsSync(activeFile)).toBe(true);

    const result = runner.deleteSession(activeId);
    expect(result.deletedId).toBe(activeId);
    expect(result.activeDeleted).toBe(true);
    expect(fs.existsSync(activeFile)).toBe(false);

    expect(runner.getSessionId()).not.toBe(activeId);
    expect(runner.getMessages()).toHaveLength(0);
  });

  it('runner.deleteSession throws when session does not exist', () => {
    const runner = new AgentRunner({ workspaceDir: workspace });
    expect(() => runner.deleteSession('nonexistent-session-id')).toThrow(/not found/);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@agent/core';
import { startServer, type ServerHandle } from '../src/server.js';

describe('Session deletion API endpoints', () => {
  let handle: ServerHandle | undefined;
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-session-delete-api-'));
  });

  afterEach(async () => {
    if (handle) {
      const closing = handle;
      handle = undefined;
      await closing.close();
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function boot(): Promise<ServerHandle> {
    handle = await startServer({
      port: 0,
      host: '127.0.0.1',
      workspaceDir: workspace,
      quiet: true,
      webAuth: false,
      gatewayPath: null
    });
    return handle;
  }

  async function api(
    route: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${handle!.url}${route}`, {
      method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
      headers: options.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
    return { status: response.status, body: await response.json() };
  }

  function createPersistedSession(content: string): SessionManager {
    const session = SessionManager.create({ workspaceDir: workspace, cwd: workspace, model: 'model-a' });
    session.appendMessage({ role: 'user', content });
    session.close();
    return session;
  }

  it('rejects POST /api/sessions/delete when sessionIdOrPath is missing', async () => {
    await boot();
    const { status, body } = await api('/api/sessions/delete', { body: {} });
    expect(status).toBe(400);
    expect(body.error).toContain('Missing required field');
  });

  it('returns 404 when session does not exist', async () => {
    await boot();
    const { status, body } = await api('/api/sessions/delete', {
      body: { sessionIdOrPath: 'nonexistent-session-id' }
    });
    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  });

  it('deletes inactive session via POST /api/sessions/delete', async () => {
    const s1 = createPersistedSession('first session');
    const s1Id = s1.getSessionId();
    const s1File = s1.getFilePath()!;

    await boot();

    await api('/api/sessions/new', { body: {} });

    const listBefore = await api('/api/sessions');
    expect(listBefore.body.some((s: any) => s.id === s1Id)).toBe(true);

    const deleteResp = await api('/api/sessions/delete', {
      body: { sessionIdOrPath: s1Id }
    });

    expect(deleteResp.status).toBe(200);
    expect(deleteResp.body.ok).toBe(true);
    expect(deleteResp.body.deletedId).toBe(s1Id);
    expect(deleteResp.body.activeDeleted).toBe(false);
    expect(fs.existsSync(s1File)).toBe(false);

    const listAfter = await api('/api/sessions');
    expect(listAfter.body.some((s: any) => s.id === s1Id)).toBe(false);
  });

  it('deletes session via DELETE /api/sessions query param', async () => {
    const s1 = createPersistedSession('to be deleted with query');
    const s1Id = s1.getSessionId();
    const s1File = s1.getFilePath()!;

    await boot();
    await api('/api/sessions/new', { body: {} });

    const deleteResp = await api(`/api/sessions?sessionIdOrPath=${s1Id}`, {
      method: 'DELETE'
    });

    expect(deleteResp.status).toBe(200);
    expect(deleteResp.body.ok).toBe(true);
    expect(deleteResp.body.deletedId).toBe(s1Id);
    expect(deleteResp.body.activeDeleted).toBe(false);
    expect(fs.existsSync(s1File)).toBe(false);
  });

  it('deletes active session and creates clean new draft session', async () => {
    const s1 = createPersistedSession('active conversation');
    const s1Id = s1.getSessionId();
    const s1File = s1.getFilePath()!;

    await boot();

    const deleteResp = await api('/api/sessions/delete', {
      body: { sessionIdOrPath: s1Id }
    });

    expect(deleteResp.status).toBe(200);
    expect(deleteResp.body.ok).toBe(true);
    expect(deleteResp.body.activeDeleted).toBe(true);
    expect(deleteResp.body.deletedId).toBe(s1Id);
    expect(fs.existsSync(s1File)).toBe(false);

    expect(deleteResp.body.status.sessionId).not.toBe(s1Id);
    expect(deleteResp.body.messages).toHaveLength(0);

    const listAfter = await api('/api/sessions');
    expect(listAfter.body.some((s: any) => s.id === s1Id)).toBe(false);
  });

  it('defines in-place two-step confirmation keys in i18n and styles in index.html', () => {
    const i18nPath = path.resolve(__dirname, '../public/i18n.js');
    const indexPath = path.resolve(__dirname, '../public/index.html');
    const i18n = fs.readFileSync(i18nPath, 'utf8');
    const html = fs.readFileSync(indexPath, 'utf8');

    // i18n keys
    expect(i18n).toContain("'sidebar.delete.confirmButton': '确认'");
    expect(i18n).toContain("'sidebar.delete.confirmAction': '确认删除'");
    expect(i18n).toContain("'sidebar.delete.confirmButton': 'Confirm'");
    expect(i18n).toContain("'sidebar.delete.confirmAction': 'Confirm delete'");

    // In-place confirmation styles
    expect(html).toContain('.siu-session-item-delete.is-confirming');
    expect(html).toContain('.siu-session-item-delete-text');

    // No window.confirm modal in deleteSession
    expect(html).not.toMatch(/async function deleteSession[^{]*\{[^}]*confirm\(/);

    // In-place click handler handles two-step deletion
    expect(html).toContain('delBtn.classList.add(\'is-confirming\')');
    expect(html).toContain('CHECK_GLYPH');
    expect(html).toContain('sidebar.delete.confirmButton');
    expect(html).toContain('sidebar.delete.confirmAction');
  });
});

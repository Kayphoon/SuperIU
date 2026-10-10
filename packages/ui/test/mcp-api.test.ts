/**
 * `/api/mcp*` route tests: a real ephemeral server with the MCP config path
 * pinned into a temp workspace, driven over HTTP. The live-connection cases
 * spawn `fixtures/mock-mcp-server.mjs` — a minimal stdio MCP server — so no
 * network or external tooling is involved, and the real `~/.superiu/mcp.json`
 * is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, type ServerHandle } from '../src/server.js';

const MOCK_SERVER = new URL('./fixtures/mock-mcp-server.mjs', import.meta.url).pathname;

describe('MCP API endpoints', () => {
  let handle: ServerHandle | undefined;
  let workspace: string;
  let mcpConfigPath: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-mcp-api-'));
    mcpConfigPath = path.join(workspace, '.superiu', 'mcp.json');
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
      mcpConfigPath,
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

  function readConfigFile(): any {
    return JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
  }

  it('GET /api/mcp reports the pinned config path and no servers on a fresh install', async () => {
    await boot();
    const { status, body } = await api('/api/mcp');
    expect(status).toBe(200);
    expect(body.configPath).toBe(mcpConfigPath);
    expect(body.servers).toEqual({});
    expect(body.statuses).toEqual([]);
  });

  it('rejects methods the MCP routes do not allow', async () => {
    await boot();
    const { status, body } = await api('/api/mcp', { method: 'POST' });
    expect(status).toBe(405);
    expect(body.error).toContain('Method not allowed');
  });

  it('POST /api/mcp/server validates name, transport and the transport-specific fields', async () => {
    await boot();

    // Missing name.
    expect((await api('/api/mcp/server', { body: { transport: 'stdio', command: 'x' } })).status).toBe(400);
    // Missing transport.
    expect((await api('/api/mcp/server', { body: { name: 's' } })).status).toBe(400);
    // Unknown transport.
    expect((await api('/api/mcp/server', { body: { name: 's', transport: 'carrier-pigeon' } })).status).toBe(400);
    // stdio without command.
    expect((await api('/api/mcp/server', { body: { name: 's', transport: 'stdio' } })).status).toBe(400);
    // sse without url.
    expect((await api('/api/mcp/server', { body: { name: 's', transport: 'sse' } })).status).toBe(400);
  });

  it('POST /api/mcp/server adds a disabled stdio server and persists it without the name key', async () => {
    await boot();
    const { status, body } = await api('/api/mcp/server', {
      body: {
        name: 'local',
        transport: 'stdio',
        command: 'definitely-not-a-real-command-xyz',
        args: ['--flag'],
        enabled: false
      }
    });
    expect(status).toBe(200);

    // The `servers` map mirrors the on-disk shape: the name is the key, never a
    // property of the value.
    expect(body.servers.local).toMatchObject({
      command: 'definitely-not-a-real-command-xyz',
      args: ['--flag'],
      enabled: false
    });
    expect(body.servers.local.name).toBeUndefined();

    const row = body.statuses.find((s: any) => s.name === 'local');
    expect(row).toMatchObject({ enabled: false, connected: false, transport: 'stdio', error: null, tools: [] });

    const onDisk = readConfigFile();
    expect(onDisk.mcpServers.local.command).toBe('definitely-not-a-real-command-xyz');
    expect(onDisk.mcpServers.local.name).toBeUndefined();
    // 2-space indentation and a trailing newline, matching the settings writer.
    const raw = fs.readFileSync(mcpConfigPath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "mcpServers"');
  });

  it('POST /api/mcp/server connects an enabled stdio server and lists its tools', async () => {
    await boot();
    const { status, body } = await api('/api/mcp/server', {
      body: { name: 'mock', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER] }
    });
    expect(status).toBe(200);

    const row = body.statuses.find((s: any) => s.name === 'mock');
    expect(row.enabled).toBe(true);
    expect(row.connected).toBe(true);
    expect(row.error).toBeNull();
    expect(row.tools).toEqual([{ name: 'echo', description: 'Echo the provided text back.' }]);
  });

  it('records the last connect error per server instead of failing the request', async () => {
    await boot();
    const { status, body } = await api('/api/mcp/server', {
      body: { name: 'broken', transport: 'stdio', command: 'definitely-not-a-real-command-xyz' }
    });
    expect(status).toBe(200);

    const row = body.statuses.find((s: any) => s.name === 'broken');
    expect(row.connected).toBe(false);
    expect(typeof row.error).toBe('string');
    expect(row.error.length).toBeGreaterThan(0);

    // The error is ledgered on the manager, so a later GET reports it too.
    const again = await api('/api/mcp');
    expect(again.body.statuses.find((s: any) => s.name === 'broken').error).toBe(row.error);
  });

  it('POST /api/mcp/toggle flips the enabled flag, persists it, and 404s on unknown servers', async () => {
    await boot();
    await api('/api/mcp/server', {
      body: { name: 'mock', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER] }
    });

    const disabled = await api('/api/mcp/toggle', { body: { name: 'mock', enabled: false } });
    expect(disabled.status).toBe(200);
    expect(disabled.body.statuses.find((s: any) => s.name === 'mock')).toMatchObject({
      enabled: false,
      connected: false
    });
    expect(readConfigFile().mcpServers.mock.enabled).toBe(false);

    const enabled = await api('/api/mcp/toggle', { body: { name: 'mock', enabled: true } });
    expect(enabled.status).toBe(200);
    expect(enabled.body.statuses.find((s: any) => s.name === 'mock')).toMatchObject({
      enabled: true,
      connected: true
    });

    expect((await api('/api/mcp/toggle', { body: { name: 'ghost', enabled: true } })).status).toBe(404);
    expect((await api('/api/mcp/toggle', { body: { name: 'mock' } })).status).toBe(400);
  });

  it('DELETE /api/mcp/server and POST /api/mcp/delete remove servers from memory and disk', async () => {
    await boot();
    await api('/api/mcp/server', {
      body: { name: 'one', transport: 'stdio', command: 'x', enabled: false }
    });
    await api('/api/mcp/server', {
      body: { name: 'two', transport: 'sse', url: 'http://127.0.0.1:9/sse', enabled: false }
    });

    const byQuery = await api('/api/mcp/server?name=one', { method: 'DELETE' });
    expect(byQuery.status).toBe(200);
    expect(byQuery.body.servers.one).toBeUndefined();
    expect(byQuery.body.servers.two).toBeDefined();
    expect(byQuery.body.statuses.find((s: any) => s.name === 'two').transport).toBe('sse');

    const byBody = await api('/api/mcp/delete', { body: { name: 'two' } });
    expect(byBody.status).toBe(200);
    expect(byBody.body.servers.two).toBeUndefined();

    expect(readConfigFile().mcpServers).toEqual({});

    expect((await api('/api/mcp/delete', { body: {} })).status).toBe(400);
  });

  it('POST /api/mcp/raw replaces the config file and rejects malformed payloads', async () => {
    await boot();

    const invalid = await api('/api/mcp/raw', { body: { raw: '{ not valid json' } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('Invalid JSON');

    // A body with no `mcpServers` object is refused, whether raw or structured.
    expect((await api('/api/mcp/raw', { body: {} })).status).toBe(400);
    expect((await api('/api/mcp/raw', { body: { raw: '{"hello":1}' } })).status).toBe(400);

    const written = await api('/api/mcp/raw', {
      body: {
        raw: JSON.stringify({
          mcpServers: {
            alpha: { command: 'a-command', args: ['1'], enabled: false },
            beta: { url: 'http://127.0.0.1:9/sse', enabled: false }
          }
        })
      }
    });
    expect(written.status).toBe(200);
    expect(Object.keys(written.body.servers).sort()).toEqual(['alpha', 'beta']);
    expect(written.body.statuses.find((s: any) => s.name === 'beta').transport).toBe('sse');

    const onDisk = readConfigFile();
    expect(onDisk.mcpServers.alpha.command).toBe('a-command');
    expect(onDisk.mcpServers.beta.url).toBe('http://127.0.0.1:9/sse');
  });

  it('POST /api/mcp/reload picks up edits made directly to the config file', async () => {
    await boot();

    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    fs.writeFileSync(
      mcpConfigPath,
      `${JSON.stringify({ mcpServers: { edited: { command: 'edited-command', enabled: false } } }, null, 2)}\n`
    );

    const { status, body } = await api('/api/mcp/reload', { method: 'POST' });
    expect(status).toBe(200);
    expect(body.servers.edited).toMatchObject({ command: 'edited-command', enabled: false });
    expect(body.statuses.find((s: any) => s.name === 'edited')).toMatchObject({
      enabled: false,
      connected: false
    });
  });
});

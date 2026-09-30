import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  McpManager,
  MCP_TOOL_PREFIX,
  DEFAULT_MCP_TIMEOUT_MS,
  qualifyToolName,
  parseQualifiedToolName,
  resolveDefaultMcpConfigPath,
  isSseServerConfig,
  type McpServerConfig
} from '../src/mcp/index.js';

const tmpDirs: string[] = [];

async function writeConfig(contents: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'mcp.json');
  const text = typeof contents === 'string' ? contents : JSON.stringify(contents);
  await fs.writeFile(file, text, 'utf-8');
  return file;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('MCP config parsing', () => {
  it('parses a stdio server shape', async () => {
    const configPath = await writeConfig({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          env: { FOO: 'bar' }
        }
      }
    });

    const manager = new McpManager({ configPath });
    const added = await manager.loadConfigFile();

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { FOO: 'bar' }
    });
    expect(isSseServerConfig(added[0])).toBe(false);
    expect(manager.listServerNames()).toEqual(['filesystem']);
  });

  it('parses an SSE server shape', async () => {
    const configPath = await writeConfig({
      mcpServers: {
        remote: {
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: 'Bearer token' }
        }
      }
    });

    const manager = new McpManager({ configPath });
    const [server] = await manager.loadConfigFile();

    expect(server).toMatchObject({
      name: 'remote',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token' }
    });
    expect(isSseServerConfig(server)).toBe(true);
  });

  it('parses a mixed config and preserves enabled flags', async () => {
    const configPath = await writeConfig({
      mcpServers: {
        local: { command: 'node', args: ['server.js'] },
        off: { command: 'node', enabled: false },
        remote: { url: 'https://x.test/sse' }
      }
    });

    const manager = new McpManager({ configPath });
    const added = await manager.loadConfigFile();

    expect(added.map((s) => s.name)).toEqual(['local', 'off', 'remote']);
    expect(manager.listServerNames()).toEqual(['local', 'off', 'remote']);
    expect(added.find((s) => s.name === 'off')?.enabled).toBe(false);
  });

  it('treats a missing config file as an empty configuration', async () => {
    const manager = new McpManager({ configPath: '/definitely/not/here/mcp.json' });
    const errors: string[] = [];
    const withHook = new McpManager({
      configPath: '/definitely/not/here/mcp.json',
      onError: (server) => errors.push(server)
    });

    expect(await manager.loadConfigFile()).toEqual([]);
    expect(await withHook.loadConfigFile()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('reports malformed JSON via onError and ignores the file', async () => {
    const configPath = await writeConfig('{ not valid json');
    const errors: Array<{ server: string; error: Error }> = [];
    const manager = new McpManager({
      configPath,
      onError: (server, error) => errors.push({ server, error })
    });

    expect(await manager.loadConfigFile()).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].server).toContain('config:');
  });

  it('reports a config missing the mcpServers object', async () => {
    const configPath = await writeConfig({ servers: {} });
    const errors: Error[] = [];
    const manager = new McpManager({
      configPath,
      onError: (_server, error) => errors.push(error)
    });

    expect(await manager.loadConfigFile()).toEqual([]);
    expect(errors[0].message).toMatch(/missing an "mcpServers" object/);
  });

  it('skips non-object server entries with a per-server error', async () => {
    const configPath = await writeConfig({
      mcpServers: {
        good: { command: 'node' },
        bad: 'nope'
      }
    });
    const errors: string[] = [];
    const manager = new McpManager({
      configPath,
      onError: (server) => errors.push(server)
    });

    const added = await manager.loadConfigFile();
    expect(added.map((s) => s.name)).toEqual(['good']);
    expect(errors).toEqual(['bad']);
  });

  it('supports programmatic add/remove/enable/disable', async () => {
    const manager = new McpManager({ configPath: null });

    // enableServer flips state and attempts a connect; an unspawnable command
    // returns null rather than throwing.
    const broken: McpServerConfig = { name: 'p', command: '/nonexistent/superiu-test-binary' };
    manager.addServer(broken);
    await manager.disableServer('p');
    expect(await manager.connect('p')).toBeNull();
    await expect(manager.enableServer('p')).resolves.toBeNull();

    await manager.removeServer('p');
    expect(manager.listServerNames()).toEqual([]);
  });

  it('resolves the default config path under an explicit home', () => {
    expect(resolveDefaultMcpConfigPath('/home/someone')).toBe(
      path.join('/home/someone', '.superiu', 'mcp.json')
    );
    expect(DEFAULT_MCP_TIMEOUT_MS).toBe(30_000);
  });
});

describe('MCP tool naming', () => {
  it('qualifies with the mcp__<server>__<tool> prefix', () => {
    expect(MCP_TOOL_PREFIX).toBe('mcp');
    expect(qualifyToolName('filesystem', 'read_file')).toBe('mcp__filesystem__read_file');
  });

  it('round-trips through parseQualifiedToolName', () => {
    expect(parseQualifiedToolName(qualifyToolName('srv', 'do_it'))).toEqual({
      serverName: 'srv',
      toolName: 'do_it'
    });
  });

  it('preserves additional __ in the tool name', () => {
    expect(parseQualifiedToolName('mcp__a__b__c')).toEqual({
      serverName: 'a',
      toolName: 'b__c'
    });
  });

  it('returns null when the prefix is absent or malformed', () => {
    expect(parseQualifiedToolName('read_file')).toBeNull();
    expect(parseQualifiedToolName('other__srv__tool')).toBeNull();
    expect(parseQualifiedToolName('mcp__srv')).toBeNull();
  });
});

describe('MCP tool conversion', () => {
  /** Build a manager whose connections/tools are stubbed, avoiding a real client. */
  function stubManager(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>) {
    const manager = new McpManager({ configPath: null });
    vi.spyOn(manager, 'listTools').mockResolvedValue(
      tools.map((t) => ({ serverName: 'demo', ...t }))
    );
    return manager;
  }

  it('flattens server tools into prefixed core tool definitions', async () => {
    const manager = stubManager([
      { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'list_dir', description: 'List a directory' }
    ]);

    const coreTools = await manager.asCoreTools();
    expect(Object.keys(coreTools).sort()).toEqual([
      'mcp__demo__list_dir',
      'mcp__demo__read_file'
    ]);
    expect(coreTools['mcp__demo__read_file'].description).toBe('Read a file');
  });

  it('keeps the first definition when a qualified name collides', async () => {
    const manager = stubManager([
      { name: 'dup', description: 'first' },
      { name: 'dup', description: 'second' }
    ]);

    const coreTools = await manager.asCoreTools();
    expect(Object.keys(coreTools)).toEqual(['mcp__demo__dup']);
    expect(coreTools['mcp__demo__dup'].description).toBe('first');
  });

  it('callTool routes a converted tool back through the manager', async () => {
    const manager = stubManager([{ name: 'echo' }]);
    vi.spyOn(manager, 'callTool').mockResolvedValue({
      content: 'echoed!',
      isError: false,
      raw: {}
    });

    const coreTools = await manager.asCoreTools();
    const execute = coreTools['mcp__demo__echo'].execute as (args: unknown) => Promise<string>;
    const output = await execute({ value: 1 });

    expect(output).toBe('echoed!');
    expect(manager.callTool).toHaveBeenCalledWith('demo', 'echo', { value: 1 });
  });
});

describe('MCP offline / unreachable servers', () => {
  it('reports an error and returns null when connecting an unknown server', async () => {
    const errors: Array<{ server: string; error: Error }> = [];
    const manager = new McpManager({
      configPath: null,
      onError: (server, error) => errors.push({ server, error })
    });

    expect(await manager.connect('missing')).toBeNull();
    expect(errors[0].server).toBe('missing');
    expect(errors[0].error.message).toMatch(/Unknown MCP server 'missing'/);
  });

  it('does not connect a disabled server and reports no error', async () => {
    const errors: Error[] = [];
    const manager = new McpManager({ configPath: null, onError: (_s, e) => errors.push(e) });
    manager.addServer({ name: 'off', command: 'node', enabled: false });

    expect(await manager.connect('off')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('contains a stdio server that cannot be spawned', async () => {
    const errors: Array<{ server: string; error: Error }> = [];
    const manager = new McpManager({
      configPath: null,
      timeoutMs: 2_000,
      onError: (server, error) => errors.push({ server, error })
    });
    manager.addServer({
      name: 'broken',
      command: '/nonexistent/binary/that/does/not/exist',
      args: []
    });

    const client = await manager.connect('broken');
    expect(client).toBeNull();
    expect(manager.isConnected('broken')).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].server).toBe('broken');
  });

  it('callTool throws (not returns) for an unconnected server', async () => {
    const manager = new McpManager({ configPath: null, timeoutMs: 1_000 });
    await expect(manager.callTool('nope', 'tool', {})).rejects.toThrow(
      /not connected/
    );
  });

  it('listToolInfos is empty when nothing is connected', async () => {
    const manager = new McpManager({ configPath: null });
    expect(await manager.listToolInfos()).toEqual([]);
    expect(await manager.asCoreTools()).toEqual({});
  });

  it('does not let a throwing onError observer destabilize the manager', async () => {
    const manager = new McpManager({
      configPath: null,
      onError: () => {
        throw new Error('observer blew up');
      }
    });

    await expect(manager.connect('missing')).resolves.toBeNull();
  });

  it('disconnect and closeAll are safe with no connections', async () => {
    const manager = new McpManager({ configPath: null });
    await expect(manager.disconnect('nothing')).resolves.toBeUndefined();
    await expect(manager.closeAll()).resolves.toBeUndefined();
  });
});

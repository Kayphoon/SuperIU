import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { jsonSchema, tool } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolDefinition } from '../loop/engine.js';
import {
  isSseServerConfig,
  type McpConfigFile,
  type McpServerConfig,
  type McpToolInfo
} from './types.js';

/** Default location of the shared MCP config, alongside the other `.superiu` files. */
export const DEFAULT_MCP_CONFIG_PATH = path.join(os.homedir(), '.superiu', 'mcp.json');

/** Prefix applied to every MCP tool so a server cannot shadow a core tool. */
export const MCP_TOOL_PREFIX = 'mcp';

/** Default ceiling for connect/list/call round-trips, so a hung server cannot wedge a turn. */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

/** Resolve the default config path under an explicit home directory (test seam). */
export function resolveDefaultMcpConfigPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.superiu', 'mcp.json');
}

export interface McpManagerOptions {
  /**
   * Config file to load on demand. Defaults to `~/.superiu/mcp.json`. Pass
   * `null` to skip file loading entirely (programmatic-only usage).
   */
  configPath?: string | null;
  /** Connect every enabled server immediately rather than lazily on first use. */
  autoConnect?: boolean;
  /** Per-operation timeout in milliseconds. Defaults to {@link DEFAULT_MCP_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Client name advertised to servers during the MCP handshake. */
  clientName?: string;
  /** Client version advertised to servers during the MCP handshake. */
  clientVersion?: string;
  /**
   * Notified when a server fails to connect or drops mid-session. Never throws
   * into the caller: a broken server degrades its own tools, not the process.
   */
  onError?: (serverName: string, error: Error) => void;
}

/** One live connection plus the config that produced it. */
interface Connection {
  client: Client;
  transport: Transport;
  config: McpServerConfig;
}

/** A tool name qualified with its server, used as the engine's tool key. */
export function qualifyToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}__${serverName}__${toolName}`;
}

/** Strip the `mcp__<server>__` prefix back into its two parts, or `null` if absent. */
export function parseQualifiedToolName(
  qualified: string
): { serverName: string; toolName: string } | null {
  const parts = qualified.split('__');
  if (parts.length < 3 || parts[0] !== MCP_TOOL_PREFIX) {
    return null;
  }
  return { serverName: parts[1], toolName: parts.slice(2).join('__') };
}

/**
 * Owns the lifecycle of every MCP server connection.
 *
 * Connections are keyed by server name. Operations are individually timed out
 * and every failure is contained: a server that is down, slow, or malformed
 * reports an error for its own tools and leaves the rest of the manager (and
 * the host process) untouched.
 */
export class McpManager {
  private readonly connections = new Map<string, Connection>();
  private readonly configs = new Map<string, McpServerConfig>();
  private readonly configPath: string | null;
  private readonly timeoutMs: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly onError?: (serverName: string, error: Error) => void;
  /** Per-server in-flight connect promises, so concurrent calls share one handshake. */
  private readonly connecting = new Map<string, Promise<Client | null>>();

  constructor(options: McpManagerOptions = {}) {
    this.configPath = options.configPath === null ? null : options.configPath ?? DEFAULT_MCP_CONFIG_PATH;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    this.clientName = options.clientName ?? 'superiu';
    this.clientVersion = options.clientVersion ?? '0.1.0';
    this.onError = options.onError;
  }

  /** Names currently configured (enabled or not), in insertion order. */
  public listServerNames(): string[] {
    return [...this.configs.keys()];
  }

  /** Names with a live connection. */
  public listConnectedServerNames(): string[] {
    return [...this.connections.keys()];
  }

  /** Whether `name` is currently connected. */
  public isConnected(name: string): boolean {
    return this.connections.has(name);
  }

  /**
   * Load servers from a JSON config file and merge them into the registry.
   *
   * A missing file is not an error: the common case is "no MCP servers
   * configured", which yields an empty manager. A malformed file reports via
   * `onError` and is otherwise ignored. When `autoConnect` was requested,
   * newly-added enabled servers are connected eagerly.
   */
  public async loadConfigFile(
    configPath: string = this.configPath ?? DEFAULT_MCP_CONFIG_PATH,
    options: { connect?: boolean } = {}
  ): Promise<McpServerConfig[]> {
    let raw: string;
    try {
      raw = await fs.readFile(configPath, 'utf-8');
    } catch {
      return [];
    }

    let parsed: McpConfigFile;
    try {
      parsed = JSON.parse(raw) as McpConfigFile;
    } catch (err) {
      this.reportError(`config:${configPath}`, asError(err));
      return [];
    }

    if (!parsed || typeof parsed !== 'object' || typeof parsed.mcpServers !== 'object' || parsed.mcpServers === null) {
      this.reportError(
        `config:${configPath}`,
        new Error('MCP config is missing an "mcpServers" object')
      );
      return [];
    }

    const added: McpServerConfig[] = [];
    for (const [name, config] of Object.entries(parsed.mcpServers)) {
      if (!config || typeof config !== 'object') {
        this.reportError(name, new Error('MCP server entry must be an object'));
        continue;
      }
      const normalized: McpServerConfig = { ...config, name };
      this.configs.set(name, normalized);
      added.push(normalized);
    }

    if (options.connect) {
      await Promise.all(
        added.filter((config) => config.enabled !== false).map((config) => this.connect(config.name))
      );
    }

    return added;
  }

  /** Register (or replace) a server programmatically. */
  public addServer(config: McpServerConfig): void {
    this.configs.set(config.name, config);
  }

  /** Remove a server: disconnects it if live and forgets its config. */
  public async removeServer(name: string): Promise<void> {
    await this.disconnect(name);
    this.configs.delete(name);
  }

  /** Mark a server enabled and connect it. */
  public async enableServer(name: string): Promise<Client | null> {
    const config = this.configs.get(name);
    if (!config) {
      throw new Error(`Unknown MCP server '${name}'`);
    }
    const enabled: McpServerConfig = { ...config, enabled: true };
    this.configs.set(name, enabled);
    return this.connect(name);
  }

  /** Mark a server disabled and disconnect it. */
  public async disableServer(name: string): Promise<void> {
    const config = this.configs.get(name);
    if (config) {
      this.configs.set(name, { ...config, enabled: false });
    }
    await this.disconnect(name);
  }

  /**
   * Open a connection to a configured server, reusing an existing one. Returns
   * the client, or `null` when the server is missing, disabled, or failed to
   * start — the failure is reported via `onError` rather than thrown, so a
   * caller enumerating servers can connect the healthy ones and move on.
   */
  public async connect(name: string): Promise<Client | null> {
    const existing = this.connections.get(name);
    if (existing) {
      return existing.client;
    }

    const config = this.configs.get(name);
    if (!config) {
      this.reportError(name, new Error(`Unknown MCP server '${name}'`));
      return null;
    }
    if (config.enabled === false) {
      return null;
    }

    const inFlight = this.connecting.get(name);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.openConnection(config).finally(() => {
      this.connecting.delete(name);
    });
    this.connecting.set(name, promise);
    return promise;
  }

  private async openConnection(config: McpServerConfig): Promise<Client | null> {
    const name = config.name;
    try {
      const transport = this.createTransport(config);
      const client = new Client(
        { name: this.clientName, version: this.clientVersion },
        { capabilities: {} }
      );

      // A dropped server marks itself dead instead of throwing into the loop.
      transport.onerror = (error) => this.reportError(name, error);
      transport.onclose = () => {
        const live = this.connections.get(name);
        if (live && live.transport === transport) {
          this.connections.delete(name);
        }
      };

      await withTimeout(client.connect(transport), this.timeoutMs, `connect to '${name}'`);
      this.connections.set(name, { client, transport, config });
      return client;
    } catch (err) {
      this.reportError(name, asError(err));
      return null;
    }
  }

  private createTransport(config: McpServerConfig): Transport {
    if (isSseServerConfig(config)) {
      const headers = config.headers;
      return new SSEClientTransport(new URL(config.url), {
        // Headers on the recurring POST requests.
        requestInit: headers ? { headers } : undefined,
        // The initial SSE GET is issued by the underlying EventSource, which
        // takes its own fetch override rather than the `requestInit` above.
        eventSourceInit: headers
          ? {
              fetch: (url: string | URL, init?: RequestInit) =>
                fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } })
            }
          : undefined
      });
    }

    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      stderr: 'pipe'
    });
  }

  /** Close a single connection, swallowing teardown errors. */
  public async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) {
      return;
    }
    this.connections.delete(name);
    try {
      await withTimeout(connection.client.close(), this.timeoutMs, `close '${name}'`);
    } catch (err) {
      this.reportError(name, asError(err));
    }
  }

  /** Close every connection. Safe to call repeatedly. */
  public async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((name) => this.disconnect(name)));
  }

  /**
   * Connect every enabled configured server that is not already live.
   * Failures are contained per server.
   */
  public async connectAll(): Promise<void> {
    await Promise.all(
      [...this.configs.values()]
        .filter((config) => config.enabled !== false)
        .map((config) => this.connect(config.name))
    );
  }

  /**
   * Query every connected server for its tools. A server that fails to answer
   * contributes no tools and reports the error; the rest are still returned.
   */
  public async listTools(): Promise<McpToolInfo[]> {
    const results: McpToolInfo[] = [];

    await Promise.all(
      [...this.connections.entries()].map(async ([serverName, connection]) => {
        try {
          const response = await withTimeout(
            connection.client.listTools(),
            this.timeoutMs,
            `listTools on '${serverName}'`
          );
          for (const item of response.tools ?? []) {
            results.push({
              serverName,
              name: item.name,
              description: item.description,
              inputSchema: item.inputSchema as Record<string, unknown> | undefined
            });
          }
        } catch (err) {
          this.reportError(serverName, asError(err));
        }
      })
    );

    return results;
  }

  /**
   * Invoke a tool on a named server, reconnecting once if the connection had
   * been lost. Returns the textual result; never throws for a server-side tool
   * error (that is returned as text with `isError`), only for transport-level
   * failures, which the caller converts to feedback.
   */
  public async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; retry?: boolean } = {}
  ): Promise<{ content: string; isError: boolean; raw: unknown }> {
    const client = await this.connect(serverName);
    if (!client) {
      throw new Error(`MCP server '${serverName}' is not connected`);
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    try {
      const result = await withTimeout(
        client.callTool({ name: toolName, arguments: args }),
        timeoutMs,
        `callTool '${serverName}/${toolName}'`
      );
      return {
        content: stringifyToolResult(result),
        isError: result.isError === true,
        raw: result
      };
    } catch (err) {
      // One reconnect attempt covers a server that restarted between turns.
      if (options.retry !== false) {
        await this.disconnect(serverName);
        const reconnected = await this.connect(serverName);
        if (reconnected) {
          return this.callTool(serverName, toolName, args, { timeoutMs, retry: false });
        }
      }
      throw asError(err);
    }
  }

  /**
   * Every available MCP tool, flattened across connected servers with
   * collision-proof names (`mcp__<server>__<tool>`).
   */
  public async listToolInfos(): Promise<McpToolInfo[]> {
    return this.listTools();
  }

  /**
   * Convert every available MCP tool into a `ToolDefinition` the
   * `AgentRunner` / `AgentLoopEngine` can execute.
   *
   * Names are prefixed so an MCP server can never shadow a core tool, and the
   * model-facing schema/description are preserved as declared. The returned
   * `execute` calls back into this manager, so the loop keeps its role as the
   * sole execution authority.
   */
  public async asCoreTools(): Promise<Record<string, ToolDefinition>> {
    const tools = await this.listTools();
    const result: Record<string, ToolDefinition> = {};

    for (const info of tools) {
      const qualified = qualifyToolName(info.serverName, info.name);
      // A duplicate qualified name (same server + tool listed twice) keeps the
      // first declaration: the schema is identical and later entries add nothing.
      if (result[qualified]) {
        continue;
      }

      const parameters =
        info.inputSchema && Object.keys(info.inputSchema).length > 0
          ? jsonSchema(info.inputSchema as Parameters<typeof jsonSchema>[0])
          : jsonSchema({ type: 'object', properties: {} } as Parameters<typeof jsonSchema>[0]);

      result[qualified] = tool({
        description:
          info.description ??
          `MCP tool '${info.name}' provided by server '${info.serverName}'.`,
        parameters,
        execute: async (args: unknown) => {
          const { content } = await this.callTool(
            info.serverName,
            info.name,
            (args as Record<string, unknown> | undefined) ?? {}
          );
          return content;
        }
      }) as unknown as ToolDefinition;
    }

    return result;
  }

  private reportError(serverName: string, error: Error): void {
    try {
      this.onError?.(serverName, error);
    } catch {
      // An observer must never take down the manager it observes.
    }
  }
}

/** Render an MCP `callTool` result into prompt-friendly text. */
function stringifyToolResult(result: unknown): string {
  const typed = result as { content?: unknown; structuredContent?: unknown };
  const parts: string[] = [];

  if (Array.isArray(typed.content)) {
    for (const item of typed.content) {
      const block = item as { type?: string; text?: string; data?: string; mimeType?: string };
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block.type === 'image' || block.type === 'audio') {
        parts.push(`[${block.type}: ${block.mimeType ?? 'unknown'}]`);
      } else if (block.type === 'resource' || block.type === 'resource_link') {
        parts.push(`[resource: ${JSON.stringify(item)}]`);
      } else {
        parts.push(typeof item === 'string' ? item : JSON.stringify(item));
      }
    }
  }

  if (parts.length === 0 && typed.structuredContent !== undefined) {
    parts.push(JSON.stringify(typed.structuredContent));
  }

  if (parts.length === 0) {
    return typeof result === 'string' ? result : JSON.stringify(result ?? null);
  }

  return parts.join('\n');
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Await `promise`, rejecting with a descriptive timeout error after `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP operation timed out after ${ms}ms: ${label}`)), ms);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

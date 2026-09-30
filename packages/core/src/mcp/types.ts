/**
 * MCP (Model Context Protocol) client configuration.
 *
 * These shapes mirror the `mcpServers` block used by other MCP-aware tools, so
 * the same JSON file can be shared without translation. A server is either a
 * local process reached over stdio or a remote endpoint reached over SSE; the
 * discriminant is `command` (stdio) versus `url` (SSE).
 */

/** A server launched as a child process and spoken to over stdin/stdout. */
export interface StdioMcpServerConfig {
  /** Executable to spawn (e.g. `npx`, `node`, `uvx`). */
  command: string;
  /** Command-line arguments passed to the executable. */
  args?: string[];
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;
}

/** A remote server reached over Server-Sent Events. */
export interface SseMcpServerConfig {
  /** SSE endpoint URL. */
  url: string;
  /** Headers attached to the SSE request (e.g. `Authorization`). */
  headers?: Record<string, string>;
}

/**
 * One configured server. `name` is the stable key assigned by the config map;
 * `enabled` defaults to true so a config only has to opt servers *out*.
 */
export type McpServerConfig = (StdioMcpServerConfig | SseMcpServerConfig) & {
  name: string;
  enabled?: boolean;
};

/** The on-disk `mcp.json` shape: a name→config map. */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

/** A tool advertised by a connected MCP server, flattened with its server. */
export interface McpToolInfo {
  serverName: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Type guard: a config reached over SSE rather than stdio. */
export function isSseServerConfig(
  config: McpServerConfig
): config is SseMcpServerConfig & { name: string; enabled?: boolean } {
  return typeof (config as SseMcpServerConfig).url === 'string';
}

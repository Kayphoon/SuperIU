/**
 * Zero-dependency `~/.ssh/config` parser.
 *
 * The desktop client needs to offer the user the same set of hosts their
 * terminal `ssh` already knows about, so we parse the OpenSSH client config
 * ourselves rather than shelling out to `ssh -G` (which is not available on all
 * platforms and would require a live ssh binary to be probed).
 *
 * The parser mirrors real OpenSSH semantics closely enough for host discovery:
 *
 *   - `Host` blocks may list multiple aliases (`Host a b c`).
 *   - Keys are case-insensitive (`HostName`, `hostname`, `HOSTNAME` are equal).
 *   - Values may be double-quoted.
 *   - `#` starts a comment; blank lines are ignored.
 *   - `Include <path>` pulls in another file, with bounded recursion so an
 *     include cycle cannot hang the process.
 *   - First-match-wins: the first `Host` block whose pattern matches supplies
 *     the value; wildcard blocks (`Host *`) act as defaults for options that a
 *     more specific (earlier) match did not set.
 *
 * Only the handful of options the provisioner cares about are retained
 * (`HostName`, `User`, `Port`, `IdentityFile`); everything else is ignored,
 * exactly like an ssh implementation reading a config for those options.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readFile } from 'node:fs/promises';

/** A resolved host entry suitable for driving an `ssh` invocation. */
export interface SshHostEntry {
  /** The alias the user would type, e.g. `myserver`. */
  alias: string;
  /** `HostName`, defaulting to the alias when absent (real ssh behaviour). */
  hostName: string;
  /** `User`, when configured. */
  user?: string;
  /** `Port`, defaulting to 22. */
  port: number;
  /** `IdentityFile`, with `~/` expanded to the user's home directory. */
  identityFile?: string;
}

/** Raised for malformed config content. Never thrown by {@link readSshConfig}. */
export class SshConfigParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SshConfigParseError';
  }
}

/** Recursion guard for nested `Include` directives. */
const MAX_INCLUDE_DEPTH = 8;

/** Raw options collected for a single host pattern (pre-resolution). */
interface RawHostBlock {
  /** Patterns/aliases attached to this block, in declaration order. */
  patterns: string[];
  values: Partial<Record<RawOptionKey, string>>;
}

type RawOptionKey = 'hostname' | 'user' | 'port' | 'identityfile';

/** A parsed file: ordered blocks plus the include directives seen. */
interface ParsedFile {
  blocks: RawHostBlock[];
  includes: string[];
}

/**
 * Tokenise one line into whitespace-separated fields, honouring double quotes.
 * `Host "my host"` yields a single token `my host`.
 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let started = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '\\' && inQuotes && i + 1 < line.length) {
      // Inside quotes a backslash escapes the next character.
      current += line[i + 1];
      i += 1;
      started = true;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      started = true;
      continue;
    }

    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += ch;
    started = true;
  }

  if (inQuotes) {
    // Unterminated quote: fall back to what we have so a single typo cannot
    // discard every other host in the file.
    if (started) tokens.push(current);
    return tokens;
  }

  if (started) tokens.push(current);
  return tokens;
}

/** Strip an unquoted trailing comment. */
function stripComment(line: string): string {
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Expand a leading `~/` to the user's home directory. */
export function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Resolve an `Include` path. Relative paths in ssh config resolve against
 * `~/.ssh` (which is also where ssh resolves them from in practice).
 */
function resolveIncludePath(value: string, baseDir: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : join(baseDir, expanded);
}

/** Parse a single config file's *text* into blocks + includes (no recursion). */
function parseText(text: string): ParsedFile {
  const blocks: RawHostBlock[] = [];
  const includes: string[] = [];
  let current: RawHostBlock | null = null;

  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    const tokens = tokenize(line);
    if (tokens.length === 0) continue;

    const keyword = tokens[0].toLowerCase();
    const values = tokens.slice(1);

    if (keyword === 'host') {
      if (values.length === 0) {
        throw new SshConfigParseError('`Host` directive without any pattern');
      }
      current = { patterns: values, values: {} };
      blocks.push(current);
      continue;
    }

    if (keyword === 'include') {
      for (const value of values) includes.push(value);
      continue;
    }

    // Any other directive only matters if we are inside a Host block.
    if (!current) continue;

    const key = keyword as RawOptionKey;
    if (key !== 'hostname' && key !== 'user' && key !== 'port' && key !== 'identityfile') {
      continue;
    }
    if (values.length === 0) continue;

    // First assignment within a block wins, matching ssh.
    if (current.values[key] === undefined) {
      current.values[key] = values[0];
    }
  }

  return { blocks, includes };
}

/**
 * Match a pattern against an alias honouring `*` and `?` wildcards, mirroring
 * OpenSSH's `match_pattern` (which anchors the whole value).
 */
export function matchHostPattern(pattern: string, alias: string): boolean {
  // A bare `*` matches everything.
  if (pattern === '*') return true;

  let regex = '';
  for (const ch of pattern) {
    if (ch === '*') regex += '.*';
    else if (ch === '?') regex += '.';
    else regex += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${regex}$`).test(alias);
}

/** Is this block a pure wildcard/default block (e.g. `Host *`)? */
function isWildcardBlock(block: RawHostBlock): boolean {
  return block.patterns.every((p) => p.includes('*') || p.includes('?'));
}

/**
 * Parse `text` into resolved host entries.
 *
 * `configDir` is used to resolve relative `Include` paths; it defaults to
 * `~/.ssh`. Include recursion is bounded by {@link MAX_INCLUDE_DEPTH} and a set
 * of already-visited absolute paths, so cycles terminate.
 */
export function parseSshConfig(text: string, _configDir?: string): SshHostEntry[] {
  // Synchronous parse cannot follow `Include` (that would require fs access);
  // the async `readSshConfig` below performs include expansion.
  const { blocks } = parseText(text);
  return resolveEntries(blocks);
}

/**
 * Turn ordered raw blocks into concrete host entries using first-match-wins
 * for concrete aliases and wildcard blocks as fallbacks.
 *
 * `Host *` (and other pure-wildcard blocks) set defaults; a specific block
 * overrides any option it defines.
 */
export function resolveEntries(blocks: RawHostBlock[]): SshHostEntry[] {
  // Concrete aliases: every pattern that is not a pure wildcard block.
  const aliases: string[] = [];
  for (const block of blocks) {
    if (isWildcardBlock(block)) continue;
    for (const pattern of block.patterns) {
      // Patterns inside a mixed block (`Host myserver *`) are unusual but treat
      // a wildcard pattern as a default rather than a concrete alias.
      if (pattern.includes('*') || pattern.includes('?')) continue;
      if (!aliases.includes(pattern)) aliases.push(pattern);
    }
  }

  const wildcardBlocks = blocks.filter(isWildcardBlock);

  const entries: SshHostEntry[] = aliases.map((alias) => {
    const values: Partial<Record<RawOptionKey, string>> = {};

    // First-match-wins across concrete blocks for the alias.
    for (const block of blocks) {
      if (isWildcardBlock(block)) continue;
      if (!block.patterns.some((p) => matchHostPattern(p, alias))) continue;
      for (const key of Object.keys(block.values) as RawOptionKey[]) {
        if (values[key] === undefined) values[key] = block.values[key];
      }
      // A single concrete match supplies all its options; later concrete
      // blocks do not contribute (ssh stops at the first matching Host).
      break;
    }

    // Wildcard blocks supply defaults only for options still unset.
    for (const block of wildcardBlocks) {
      if (!block.patterns.some((p) => matchHostPattern(p, alias))) continue;
      for (const key of Object.keys(block.values) as RawOptionKey[]) {
        if (values[key] === undefined) values[key] = block.values[key];
      }
    }

    const port = values.port !== undefined ? Number.parseInt(values.port, 10) : 22;
    return {
      alias,
      hostName: values.hostname ?? alias,
      user: values.user,
      port: Number.isFinite(port) && port > 0 ? port : 22,
      identityFile: values.identityfile ? expandHome(values.identityfile) : undefined,
    };
  });

  return entries;
}

/**
 * Read `~/.ssh/config` (or `configPath`) and return the resolved host list.
 *
 * Never throws: a missing file, an unreadable file, or a malformed file all
 * degrade to an empty (or partial) list so the UI can still show something.
 */
export async function readSshConfig(configPath?: string): Promise<SshHostEntry[]> {
  const explicit = configPath !== undefined;
  const root = explicit ? configPath : join(homedir(), '.ssh', 'config');
  const configDir = join(root, '..');

  const collected: RawHostBlock[] = [];
  const visited = new Set<string>();

  const load = async (file: string, depth: number): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH) return;
    const absolute = expandHome(file);
    if (visited.has(absolute)) return;
    visited.add(absolute);

    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch {
      // Missing or unreadable: an optional include is not an error, and a
      // missing top-level config simply yields no hosts.
      return;
    }

    let parsed: ParsedFile;
    try {
      parsed = parseText(text);
    } catch (err) {
      if (err instanceof SshConfigParseError) {
        // Malformed content: keep whatever other files gave us.
        return;
      }
      throw err;
    }

    collected.push(...parsed.blocks);

    for (const inc of parsed.includes) {
      await load(resolveIncludePath(inc, configDir), depth + 1);
    }
  };

  await load(root, 0);
  return resolveEntries(collected);
}

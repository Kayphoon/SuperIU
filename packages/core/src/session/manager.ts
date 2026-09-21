import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { ContextMessage } from '../context/types.js';
import {
  CURRENT_SESSION_VERSION,
  isMessageEntry,
  type PersistedMessage,
  type SessionEntry,
  type SessionEntryInput,
  type SessionHeader,
  type SessionMessageEntry
} from './types.js';
import { createSessionFilePath, createSessionId } from './paths.js';

export interface SessionManagerOptions {
  /** Workspace root that owns the `.myagent/sessions` bucket. Defaults to the session cwd. */
  workspaceDir?: string;
  /** Session cwd recorded in the header and used for bucket encoding. Defaults to `process.cwd()`. */
  cwd?: string;
  title?: string;
  /** In-memory only: skip all disk I/O (used by tests). */
  inMemory?: boolean;
}

export interface SessionAppendMessage {
  role: ContextMessage['role'];
  content?: string;
  toolCalls?: ContextMessage['toolCalls'];
  toolResults?: ContextMessage['toolResults'];
  id?: string;
  createdAt?: number;
}

function createEntryId(): string {
  return crypto.randomBytes(4).toString('hex');
}

function toPersistedRole(role: ContextMessage['role']): PersistedMessage['role'] {
  return role === 'tool' ? 'toolResult' : role;
}

function fromPersistedRole(role: PersistedMessage['role']): ContextMessage['role'] {
  return role === 'toolResult' ? 'tool' : role;
}

/**
 * omp-native session manager.
 *
 * Append-only JSONL tree with a mutable leaf pointer:
 * - every append creates one entry whose `parentId` is the current `leafId`;
 * - `branch(entryId)` moves the leaf without mutating history;
 * - `buildSessionContext()` walks `leafId` -> root, reverses to time order, and
 *   truncates everything up to the latest `reset_boundary`.
 */
export class SessionManager {
  public header: SessionHeader;
  public filePath: string | null;

  private readonly entriesById = new Map<string, SessionEntry>();
  private readonly children = new Map<string | null, SessionEntry[]>();
  private readonly inMemory: boolean;
  private leafId: string | null = null;
  private closed = false;

  private constructor(header: SessionHeader, filePath: string | null, inMemory: boolean) {
    this.header = header;
    this.filePath = filePath;
    this.inMemory = inMemory;
  }

  /** Create a brand new session, materializing its JSONL header immediately. */
  public static create(options: SessionManagerOptions = {}): SessionManager {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const timestamp = Date.now();
    const header: SessionHeader = {
      type: 'session',
      version: CURRENT_SESSION_VERSION,
      id: createSessionId(),
      timestamp: new Date(timestamp).toISOString(),
      cwd,
      title: options.title ?? 'Initial Session',
      titleSource: 'auto'
    };

    const inMemory = options.inMemory === true;
    const filePath = inMemory
      ? null
      : createSessionFilePath(header.id, timestamp, cwd, options.workspaceDir);

    const manager = new SessionManager(header, filePath, inMemory);
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(header)}\n`, 'utf-8');
    }
    return manager;
  }

  /** Open an existing session file. A missing or header-less file is replaced by a fresh session. */
  public static open(filePath: string): SessionManager {
    const absolute = path.resolve(filePath);
    const header = SessionManager.readHeader(absolute);

    if (!header) {
      return SessionManager.createAt(absolute);
    }

    const manager = new SessionManager(header, absolute, false);
    manager.loadEntries();
    return manager;
  }

  /** Create a session bound to an explicit path (used by `open` recovery). */
  private static createAt(filePath: string): SessionManager {
    const cwd = path.resolve(process.cwd());
    const header: SessionHeader = {
      type: 'session',
      version: CURRENT_SESSION_VERSION,
      id: createSessionId(),
      timestamp: new Date().toISOString(),
      cwd,
      title: 'Initial Session',
      titleSource: 'auto'
    };
    const manager = new SessionManager(header, filePath, false);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(header)}\n`, 'utf-8');
    return manager;
  }

  private static readHeader(filePath: string): SessionHeader | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const firstLine = content.split('\n', 1)[0];
      if (!firstLine) return null;
      const parsed = JSON.parse(firstLine) as SessionHeader;
      if (parsed?.type !== 'session' || typeof parsed.id !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private loadEntries(): void {
    if (!this.filePath) return;

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const lines = content.split('\n');
    let lastEntry: SessionEntry | null = null;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      let entry: SessionEntry;
      try {
        entry = JSON.parse(line) as SessionEntry;
      } catch {
        continue;
      }

      if (!entry || typeof entry.id !== 'string') continue;

      this.entriesById.set(entry.id, entry);
      const siblings = this.children.get(entry.parentId) ?? [];
      siblings.push(entry);
      this.children.set(entry.parentId, siblings);
      lastEntry = entry;
    }

    this.leafId = lastEntry ? lastEntry.id : null;
  }

  public getSessionId(): string {
    return this.header.id;
  }

  public getFilePath(): string | null {
    return this.filePath;
  }

  public getLeafId(): string | null {
    return this.leafId;
  }

  public getEntry(entryId: string): SessionEntry | undefined {
    return this.entriesById.get(entryId);
  }

  /** All non-header entries in insertion order. */
  public getEntries(): SessionEntry[] {
    return Array.from(this.entriesById.values());
  }

  /**
   * Append an entry whose parent is the current leaf; the entry becomes the new leaf.
   *
   * The entry id is the canonical identity. For `message` entries the persisted
   * `message.id` mirrors it, so context messages, leaf pointers, and branch
   * navigation all address the same value.
   */
  public appendEntry(input: SessionEntryInput, id?: string): SessionEntry {
    const entry = {
      ...input,
      id: id ?? createEntryId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString()
    } as SessionEntry;

    if (entry.type === 'message') {
      entry.message = { ...entry.message, id: entry.id };
    }

    this.entriesById.set(entry.id, entry);
    const siblings = this.children.get(entry.parentId) ?? [];
    siblings.push(entry);
    this.children.set(entry.parentId, siblings);
    this.leafId = entry.id;

    this.persist(entry);
    return entry;
  }

  public appendMessage(message: SessionAppendMessage): ContextMessage {
    const entry = this.appendEntry(
      {
        type: 'message',
        message: {
          role: toPersistedRole(message.role),
          content: message.content,
          toolCalls: message.toolCalls,
          toolResults: message.toolResults,
          createdAt: message.createdAt ?? Date.now()
        }
      },
      message.id
    );

    if (entry.type !== 'message') {
      throw new Error(`Session entry '${entry.id}' was persisted with an unexpected type`);
    }

    return this.toContextMessage(entry);
  }

  public appendMessages(messages: SessionAppendMessage[]): ContextMessage[] {
    return messages.map((message) => this.appendMessage(message));
  }

  /** `/clear`: append a reset boundary so context reconstruction restarts from here. */
  public clear(): SessionEntry {
    return this.appendEntry({ type: 'reset_boundary' });
  }

  /** Move the leaf pointer without mutating any existing entry. */
  public branch(entryId: string): void {
    if (!this.entriesById.has(entryId)) {
      throw new Error(`Cannot branch: entry '${entryId}' not found in session ${this.header.id}`);
    }
    this.leafId = entryId;
  }

  public resetLeaf(): void {
    this.leafId = null;
  }

  /** Children of an entry (or roots when `entryId` is null). */
  public getChildren(entryId: string | null): SessionEntry[] {
    return [...(this.children.get(entryId) ?? [])];
  }

  /**
   * Rebuild the linear model context for the active branch.
   *
   * 1. Walk `parentId` from the leaf to the root, then reverse to time order.
   * 2. Drop everything up to and including the latest `reset_boundary`.
   * 3. Drop dangling tool calls and orphaned tool results.
   */
  public buildSessionContext(leafId?: string | null): ContextMessage[] {
    const targetLeaf = leafId === undefined ? this.leafId : leafId;
    if (targetLeaf === null) return [];

    const chain: SessionEntry[] = [];
    const seen = new Set<string>();
    let cursor: string | null = targetLeaf;

    while (cursor) {
      if (seen.has(cursor)) break; // corrupt cycle guard
      seen.add(cursor);
      const entry: SessionEntry | undefined = this.entriesById.get(cursor);
      if (!entry) break;
      chain.push(entry);
      cursor = entry.parentId;
    }

    chain.reverse();

    let startIndex = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].type === 'reset_boundary') {
        startIndex = i + 1;
        break;
      }
    }

    const activeMessages = chain
      .slice(startIndex)
      .filter(isMessageEntry)
      .map((entry) => this.toContextMessage(entry));

    return SessionManager.dropDanglingToolCalls(activeMessages);
  }

  private toContextMessage(entry: SessionMessageEntry): ContextMessage {
    return {
      id: entry.message.id,
      role: fromPersistedRole(entry.message.role),
      content: entry.message.content,
      toolCalls: entry.message.toolCalls,
      toolResults: entry.message.toolResults,
      createdAt: entry.message.createdAt
    };
  }

  private static dropDanglingToolCalls(messages: ContextMessage[]): ContextMessage[] {
    const resultIds = new Set<string>();
    for (const msg of messages) {
      for (const tr of msg.toolResults ?? []) {
        resultIds.add(tr.toolCallId);
      }
    }

    const callIds = new Set<string>();
    const pruned: ContextMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const settled = msg.toolCalls.filter((tc) => resultIds.has(tc.id));
        for (const tc of settled) callIds.add(tc.id);

        if (settled.length === 0 && !msg.content) {
          continue; // assistant turn consisting only of an unfinished call
        }

        pruned.push(settled.length === msg.toolCalls.length ? msg : { ...msg, toolCalls: settled });
        continue;
      }

      if (msg.role === 'tool' && msg.toolResults && msg.toolResults.length > 0) {
        const matched = msg.toolResults.filter((tr) => callIds.has(tr.toolCallId));
        if (matched.length === 0) continue;
        pruned.push(matched.length === msg.toolResults.length ? msg : { ...msg, toolResults: matched });
        continue;
      }

      pruned.push(msg);
    }

    return pruned;
  }

  /** Last `limit` messages of the active branch (full branch when omitted). */
  public getMessages(limit?: number): ContextMessage[] {
    const context = this.buildSessionContext();
    if (limit === undefined || limit <= 0 || limit >= context.length) {
      return context;
    }
    return context.slice(context.length - limit);
  }

  public updateTitle(title: string, titleSource: 'auto' | 'user' = 'user'): void {
    this.header.title = title;
    this.header.titleSource = titleSource;
    if (!this.filePath) return;

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const newlineIndex = content.indexOf('\n');
    const rest = newlineIndex === -1 ? '' : content.slice(newlineIndex);
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.header)}${rest}`, 'utf-8');
  }

  /** Drain pending writes. Appends are synchronous, so this only guards closed state. */
  public flush(): void {
    if (this.closed) return;
  }

  public close(): void {
    this.flush();
    this.closed = true;
  }

  private persist(entry: SessionEntry): void {
    if (!this.filePath || this.inMemory) return;
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
  }
}

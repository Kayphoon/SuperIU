import type { ToolCallItem, ToolResultItem } from '../context/types.js';

/** Current on-disk session protocol version (aligned with omp). */
export const CURRENT_SESSION_VERSION = 3;

/** Physical first line of every `.jsonl` session file. */
export interface SessionHeader {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  title?: string;
  titleSource?: 'auto' | 'user';
}

/** Fields shared by every non-header entry. */
export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

/**
 * Persisted message payload.
 *
 * `role` follows the omp wire naming: the internal `tool` role is persisted as
 * `toolResult` so external readers of the JSONL see the canonical taxonomy.
 */
export interface PersistedMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'toolResult';
  content?: string;
  toolCalls?: ToolCallItem[];
  toolResults?: ToolResultItem[];
  createdAt: number;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: 'message';
  message: PersistedMessage;
}

/** Payload-free marker appended by `/clear`; context reconstruction stops at the latest one. */
export interface SessionResetBoundaryEntry extends SessionEntryBase {
  type: 'reset_boundary';
}

export interface SessionCompactionEntry extends SessionEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string | null;
}

export interface SessionBranchSummaryEntry extends SessionEntryBase {
  type: 'branch_summary';
  fromId: string;
  summary: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | SessionResetBoundaryEntry
  | SessionCompactionEntry
  | SessionBranchSummaryEntry;

/** Entry payload accepted by `SessionManager.appendEntry` (identity fields are assigned by the manager). */
export type SessionEntryInput =
  | Omit<SessionMessageEntry, 'id' | 'parentId' | 'timestamp' | 'message'> & {
      message: Omit<PersistedMessage, 'id'>;
    }
  | Omit<SessionResetBoundaryEntry, 'id' | 'parentId' | 'timestamp'>
  | Omit<SessionCompactionEntry, 'id' | 'parentId' | 'timestamp'>
  | Omit<SessionBranchSummaryEntry, 'id' | 'parentId' | 'timestamp'>;

export function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === 'message';
}

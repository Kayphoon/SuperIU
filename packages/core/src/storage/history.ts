import { DatabaseSync, type StatementSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface PromptHistoryEntry {
  id: string;
  prompt: string;
  createdAt: number;
  cwd: string;
  sessionId: string;
}

export interface PromptHistoryOptions {
  dbPath?: string;
}

const CREATE_HISTORY_SQL = `
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  session_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_cwd ON history(cwd, created_at);
`;

interface HistoryRow {
  id: string;
  prompt: string;
  created_at: number;
  cwd: string;
  session_id: string;
}

/**
 * Prompt recall/search storage, deliberately decoupled from the session tree.
 *
 * Lives in `.myagent/history.db` so prompt history survives session branching
 * and `/clear` boundaries.
 */
export class PromptHistoryStorage {
  private db: DatabaseSync;
  private dbPath: string;
  private lastPromptBySession = new Map<string, string>();

  private stmtInsert!: StatementSync;
  private stmtSearch!: StatementSync;
  private stmtRecent!: StatementSync;

  constructor(options: PromptHistoryOptions = {}) {
    this.dbPath = options.dbPath ?? path.resolve(process.cwd(), '.myagent', 'history.db');

    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(CREATE_HISTORY_SQL);
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmtInsert = this.db.prepare(
      `INSERT INTO history (id, prompt, created_at, cwd, session_id) VALUES (?, ?, ?, ?, ?)`
    );

    this.stmtSearch = this.db.prepare(
      `SELECT id, prompt, created_at, cwd, session_id
       FROM history
       WHERE cwd = ? AND prompt LIKE ?
       ORDER BY created_at DESC
       LIMIT ?`
    );

    this.stmtRecent = this.db.prepare(
      `SELECT id, prompt, created_at, cwd, session_id
       FROM history
       WHERE cwd = ?
       ORDER BY created_at DESC
       LIMIT ?`
    );
  }

  public getDbPath(): string {
    return this.dbPath;
  }

  /** Record a prompt. Consecutive duplicates within a session are dropped. */
  public append(prompt: string, cwd: string, sessionId: string): PromptHistoryEntry | null {
    const trimmed = prompt.trim();
    if (!trimmed) return null;

    if (this.lastPromptBySession.get(sessionId) === trimmed) {
      return null;
    }
    this.lastPromptBySession.set(sessionId, trimmed);

    const entry: PromptHistoryEntry = {
      id: crypto.randomUUID(),
      prompt: trimmed,
      createdAt: Date.now(),
      cwd: path.resolve(cwd),
      sessionId
    };

    this.stmtInsert.run(entry.id, entry.prompt, entry.createdAt, entry.cwd, entry.sessionId);
    return entry;
  }

  /** Most recent prompts for a workspace; pass `query` for a substring filter. */
  public search(cwd: string, query?: string, limit = 20): PromptHistoryEntry[] {
    const resolvedCwd = path.resolve(cwd);
    const rows = (
      query && query.trim()
        ? this.stmtSearch.all(resolvedCwd, `%${query.trim()}%`, limit)
        : this.stmtRecent.all(resolvedCwd, limit)
    ) as unknown as HistoryRow[];

    return rows.map((row) => ({
      id: row.id,
      prompt: row.prompt,
      createdAt: row.created_at,
      cwd: row.cwd,
      sessionId: row.session_id
    }));
  }

  public close(): void {
    this.db.close();
  }
}

/**
 * Pairing credential store for the web console.
 *
 * The console can run shell commands through the agent, so exposing it beyond
 * loopback needs a credential. Rather than an operator-managed shared secret,
 * access is granted by *pairing*: a short-lived one-time code is exchanged for a
 * long-lived key, and the browser keeps that key in an HttpOnly cookie.
 *
 * This file owns the on-disk shape only — it knows nothing about HTTP. The
 * middleware in `./middleware.ts` decides who must present a credential.
 *
 * Design notes:
 *
 *  - Only SHA-256 digests of keys and codes are ever written. The raw value
 *    exists in memory for the length of the request that minted it and is never
 *    logged. `id` is a non-secret handle (the first 12 hex characters of the
 *    digest) used for display and revocation.
 *  - Expiry *slides*: a key is valid for `ttlDays` after its most recent use (or
 *    creation), so an active browser never has to re-pair. `markUsed` refreshes
 *    that timestamp in memory on every authenticated request but only writes it
 *    to disk once an hour per key, so a busy console does not churn the file.
 *  - One-time codes live five minutes and are consumed atomically with the key
 *    they issue.
 *  - The file is read-through cached by mtime: `verify` / `mintCode` re-read it
 *    when another process (e.g. `superiu-server pair` run offline) changed it,
 *    so a daemon holding the store in memory does not lose those updates.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Days a key stays valid after its most recent use when no override is given. */
export const DEFAULT_PAIRING_TTL_DAYS = 30;

/** Lifetime of a one-time pairing code. */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/** Minimum gap between `markUsed`-driven disk writes for a single key. */
export const MARK_USED_PERSIST_INTERVAL_MS = 60 * 60 * 1000;

/** A stored long-lived key. `hash` is the SHA-256 digest of the raw key, hex. */
export interface PairingKeyRecord {
  id: string;
  hash: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
}

/** A stored one-time pairing code. `hash` is the SHA-256 digest of the raw code. */
export interface PairingCodeRecord {
  hash: string;
  createdAt: string;
  expiresAt: string;
}

/** A key as projected to clients: no `hash`, plus a computed `expiresAt`. */
export interface PairingKeyView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

interface PairingFile {
  keys: PairingKeyRecord[];
  codes: PairingCodeRecord[];
}

export interface PairingStoreOptions {
  /** Override the sliding TTL. Defaults to `SUPERIU_PAIRING_TTL_DAYS` or 30. */
  ttlDays?: number;
  /** Clock injection point for tests. Defaults to `Date.now`. */
  now?: () => Date;
}

/**
 * Parse `SUPERIU_PAIRING_TTL_DAYS`.
 *
 * Read once at store construction, per the requirement that a live server does
 * not change its TTL mid-flight. Anything that is not a finite positive number
 * falls back to {@link DEFAULT_PAIRING_TTL_DAYS}.
 */
export function parseTtlDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PAIRING_TTL_DAYS;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PAIRING_TTL_DAYS;
  return value;
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** True for a 64-character lowercase-or-uppercase hex digest. */
function isHexDigest(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

/** Constant-time equality of two hex digests. */
function digestsEqual(left: string, right: string): boolean {
  if (!isHexDigest(left) || !isHexDigest(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Coerce an untrusted parsed value into a well-formed store file. */
function normalizeFile(parsed: unknown): PairingFile {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { keys: [], codes: [] };
  }
  const record = parsed as Record<string, unknown>;
  const keys: PairingKeyRecord[] = [];
  if (Array.isArray(record.keys)) {
    for (const entry of record.keys) {
      if (entry === null || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      if (
        typeof item.id === 'string' &&
        typeof item.hash === 'string' &&
        typeof item.label === 'string' &&
        typeof item.createdAt === 'string' &&
        typeof item.lastUsedAt === 'string'
      ) {
        keys.push({
          id: item.id,
          hash: item.hash,
          label: item.label,
          createdAt: item.createdAt,
          lastUsedAt: item.lastUsedAt
        });
      }
    }
  }
  const codes: PairingCodeRecord[] = [];
  if (Array.isArray(record.codes)) {
    for (const entry of record.codes) {
      if (entry === null || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      if (
        typeof item.hash === 'string' &&
        typeof item.createdAt === 'string' &&
        typeof item.expiresAt === 'string'
      ) {
        codes.push({ hash: item.hash, createdAt: item.createdAt, expiresAt: item.expiresAt });
      }
    }
  }
  return { keys, codes };
}

/**
 * The pairing credential store.
 *
 * All mutating operations are synchronous and single-process: the daemon holds
 * one instance in memory and Node's event loop serializes access. A CLI that
 * mints offline is reconciled through the mtime read-through cache.
 */
export class PairingStore {
  private readonly filePath: string;
  readonly ttlDays: number;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private keys: PairingKeyRecord[] = [];
  private codes: PairingCodeRecord[] = [];
  /** mtime of the last read/write; `-1` when the file is absent. */
  private lastReadMtimeMs = -1;
  /** Per-key timestamp of the last `markUsed` write that reached disk. */
  private readonly lastPersistedUsedAt = new Map<string, number>();

  constructor(filePath: string, options: PairingStoreOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.ttlDays = options.ttlDays ?? parseTtlDays(process.env.SUPERIU_PAIRING_TTL_DAYS);
    this.ttlMs = this.ttlDays * 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  /** Construct and load a store. Mirrors the `load(path)` entry point. */
  static load(filePath: string, options: PairingStoreOptions = {}): PairingStore {
    return new PairingStore(filePath, options);
  }

  /** Absolute path of the backing JSON file. */
  get path(): string {
    return this.filePath;
  }

  /**
   * Whether any credential (key or pending code) is present. Refreshes from disk
   * first so a code minted by another process is visible without a restart.
   */
  hasCredentials(): boolean {
    this.refresh();
    return this.keys.length > 0 || this.codes.length > 0;
  }

  /** (Re)read the backing file from disk, replacing in-memory state. */
  load(): void {
    let raw: string;
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(this.filePath).mtimeMs;
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      this.keys = [];
      this.codes = [];
      this.lastReadMtimeMs = -1;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt file is treated as empty but must not be clobbered by a read.
      this.keys = [];
      this.codes = [];
      this.lastReadMtimeMs = mtimeMs;
      return;
    }

    const file = normalizeFile(parsed);
    this.keys = file.keys;
    this.codes = file.codes;
    this.lastReadMtimeMs = mtimeMs;
    if (this.prune(this.now().getTime())) this.persist();
  }

  /** Public key listing, projected for clients (never exposes `hash`). */
  list(): PairingKeyView[] {
    this.refresh();
    if (this.prune(this.now().getTime())) this.persist();
    return this.keys.map((key) => ({
      id: key.id,
      label: key.label,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      expiresAt: new Date(this.expiryBasis(key) + this.ttlMs).toISOString()
    }));
  }

  /**
   * Mint a long-lived key. Returns the raw key (shown once) and its handle.
   */
  mintKey(label: string): { raw: string; id: string } {
    this.refresh();
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = sha256Hex(raw);
    const id = hash.slice(0, 12);
    const at = this.now().toISOString();
    this.keys.push({ id, hash, label, createdAt: at, lastUsedAt: at });
    this.prune(this.now().getTime());
    this.persist();
    return { raw, id };
  }

  /** Mint a one-time code valid for {@link PAIRING_CODE_TTL_MS}. */
  mintCode(): { raw: string; expiresAt: string } {
    this.refresh();
    const raw = crypto.randomBytes(24).toString('base64url');
    const hash = sha256Hex(raw);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
    this.codes.push({ hash, createdAt: now.toISOString(), expiresAt });
    this.prune(now.getTime());
    this.persist();
    return { raw, expiresAt };
  }

  /**
   * Consume a one-time code and atomically issue the key it grants. Returns the
   * raw key and its id, or `null` when the code is unknown, already used, or
   * expired. The two mutations land in a single disk write.
   */
  consumeCode(raw: string, label = 'web'): { raw: string; id: string } | null {
    if (!raw) return null;
    this.refresh();
    const hash = sha256Hex(raw);
    const index = this.codes.findIndex((code) => digestsEqual(code.hash, hash));
    if (index === -1) return null;

    const code = this.codes[index];
    this.codes.splice(index, 1);
    const now = this.now();
    if (now.getTime() > Date.parse(code?.expiresAt ?? '')) {
      this.persist();
      return null;
    }

    const keyRaw = crypto.randomBytes(32).toString('hex');
    const keyHash = sha256Hex(keyRaw);
    const id = keyHash.slice(0, 12);
    const at = now.toISOString();
    this.keys.push({ id, hash: keyHash, label, createdAt: at, lastUsedAt: at });
    this.prune(now.getTime());
    this.persist();
    return { raw: keyRaw, id };
  }

  /**
   * Verify a raw key. Codes are never accepted here — they are consumed
   * explicitly through {@link consumeCode}. Returns `{id,label}` on success.
   */
  verify(raw: string): { id: string; label: string } | null {
    if (!raw) return null;
    this.refresh();
    const hash = sha256Hex(raw);
    const nowMs = this.now().getTime();
    for (const key of this.keys) {
      if (digestsEqual(key.hash, hash)) {
        if (this.isExpired(key, nowMs)) return null;
        return { id: key.id, label: key.label };
      }
    }
    return null;
  }

  /**
   * Record a use of `rawKeyOrHash`, sliding its expiry. The in-memory timestamp
   * is always current; the disk write is throttled to once an hour per key.
   */
  markUsed(rawKeyOrHash: string, now: Date = this.now()): void {
    if (!rawKeyOrHash) return;
    this.refresh();
    const key = this.findKey(rawKeyOrHash);
    if (!key) return;
    key.lastUsedAt = now.toISOString();
    const last = this.lastPersistedUsedAt.get(key.id) ?? 0;
    if (now.getTime() - last >= MARK_USED_PERSIST_INTERVAL_MS) {
      this.persist();
      this.lastPersistedUsedAt.set(key.id, now.getTime());
    }
  }

  /** Revoke one key by its display id. Returns whether a key was removed. */
  revoke(id: string): boolean {
    this.refresh();
    const before = this.keys.length;
    this.keys = this.keys.filter((key) => key.id !== id);
    if (this.keys.length === before) return false;
    this.persist();
    return true;
  }

  /**
   * Revoke every key, or every key except `exceptId`. Returns the count removed.
   */
  revokeAll(exceptId?: string): number {
    this.refresh();
    const before = this.keys.length;
    this.keys = exceptId ? this.keys.filter((key) => key.id === exceptId) : [];
    const removed = before - this.keys.length;
    if (removed > 0) this.persist();
    return removed;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Re-read the file when another writer changed it, merging the result. */
  private refresh(): void {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch {
      return;
    }
    if (mtimeMs === this.lastReadMtimeMs) return;

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const file = normalizeFile(parsed);
    this.mergeKeys(file.keys);
    this.mergeCodes(file.codes);
    this.lastReadMtimeMs = mtimeMs;
  }

  /**
   * Merge keys from disk into memory. A key present on both sides keeps the
   * later `lastUsedAt`, so an in-memory use that has not yet been persisted is
   * not lost when the file is re-read.
   */
  private mergeKeys(incoming: PairingKeyRecord[]): void {
    const byHash = new Map(this.keys.map((key) => [key.hash, key]));
    for (const key of incoming) {
      const existing = byHash.get(key.hash);
      if (!existing) {
        this.keys.push(key);
        byHash.set(key.hash, key);
        continue;
      }
      if (Date.parse(key.lastUsedAt) > Date.parse(existing.lastUsedAt)) {
        existing.lastUsedAt = key.lastUsedAt;
      }
      if (key.label && key.label !== existing.label) existing.label = key.label;
    }
  }

  /** Union codes by digest; disk wins on a collision (same digest, same code). */
  private mergeCodes(incoming: PairingCodeRecord[]): void {
    const known = new Set(this.codes.map((code) => code.hash));
    for (const code of incoming) {
      if (known.has(code.hash)) continue;
      this.codes.push(code);
      known.add(code.hash);
    }
  }

  /** Find a key by raw value or by its stored digest. */
  private findKey(rawKeyOrHash: string): PairingKeyRecord | undefined {
    // A raw key and a digest are both 64 hex characters, so a direct match is
    // tried first (internal callers pass a digest), then the value is hashed.
    const direct = this.keys.find((key) => digestsEqual(key.hash, rawKeyOrHash));
    if (direct) return direct;
    const hash = sha256Hex(rawKeyOrHash);
    return this.keys.find((key) => digestsEqual(key.hash, hash));
  }

  /** Drop expired keys and codes; returns whether anything was removed. */
  private prune(nowMs: number): boolean {
    const keysBefore = this.keys.length;
    const codesBefore = this.codes.length;
    this.keys = this.keys.filter((key) => !this.isExpired(key, nowMs));
    this.codes = this.codes.filter((code) => nowMs <= Date.parse(code.expiresAt));
    return this.keys.length !== keysBefore || this.codes.length !== codesBefore;
  }

  /** Expiry basis for a key: the later of creation and last use. */
  private expiryBasis(key: PairingKeyRecord): number {
    const created = Date.parse(key.createdAt);
    const used = Date.parse(key.lastUsedAt);
    return Math.max(Number.isFinite(created) ? created : 0, Number.isFinite(used) ? used : 0);
  }

  private isExpired(key: PairingKeyRecord, nowMs: number): boolean {
    const created = Date.parse(key.createdAt);
    const used = Date.parse(key.lastUsedAt);
    if (!Number.isFinite(created) || !Number.isFinite(used)) return true;
    return nowMs - Math.max(created, used) > this.ttlMs;
  }

  /** Atomically replace the backing file, mode 0600. */
  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // A filesystem that refuses chmod still gets the 0600 file below.
    }

    const payload: PairingFile = { keys: this.keys, codes: this.codes };
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // Same rationale as the directory chmod above.
    }
    fs.renameSync(tmp, this.filePath);

    // Our own write is now the newest version: record its mtime so the next
    // `refresh` does not treat it as a foreign update.
    try {
      this.lastReadMtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch {
      // If it vanished again, the next refresh simply re-reads.
    }
  }
}

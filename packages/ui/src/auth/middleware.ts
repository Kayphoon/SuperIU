/**
 * Pairing authentication middleware for the web console.
 *
 * The layer sits in front of `handleApi`: it decides whether a request may
 * proceed, hands the pairing endpoints to `./routes.ts`, and otherwise enforces
 * the credential check. It is a no-op when auth is off, which is the default for
 * a loopback bind with no keys — preserving `pnpm ui`, desktop local mode and
 * SSH-tunnel access.
 *
 * Enablement (evaluated per request so an offline `superiu-server pair` is
 * picked up without a restart):
 *
 *   - `SUPERIU_WEB_AUTH=1` forces auth on; `=0` forces it off.
 *   - Otherwise AUTO: on when the bind host is not loopback, or when the pairing
 *     store holds at least one key or code.
 *
 * Trust: when auth is on, a request whose socket peer is loopback
 * (`127.0.0.1` / `::1` / `::ffff:127.0.0.1`) is exempt. `X-Forwarded-For` is
 * never consulted — only the actual peer address counts.
 */

import * as http from 'node:http';
import * as path from 'node:path';
import { PairingStore } from './store.js';
import { handleConnectCode, handlePair, handlePairing, sendJson } from './routes.js';

/** Cookie carrying the raw pairing key. */
export const PAIRING_COOKIE_NAME = 'superiu_pair';

/** Window over which failed attempts are counted, per peer address. */
export const FAILURE_WINDOW_MS = 60_000;
/** Failed attempts per window before the peer is throttled. */
export const MAX_FAILURES_PER_WINDOW = 20;
/** Minimum gap between `Set-Cookie` refreshes for a key. */
export const COOKIE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** `'on'`/`'off'` are explicit; `'auto'` derives from host and stored keys. */
export type AuthMode = 'on' | 'off' | 'auto';

/** The credential a request presented, once verified. */
export interface AuthenticatedKey {
  id: string;
  label: string;
  raw: string;
}

export interface AuthLayerOptions {
  /** Workspace root owning `.superiu/`. The store lives at `.superiu/pairing.json`. */
  workspaceDir: string;
  /** Bind host, used for the AUTO enablement rule. */
  host: string;
  /** Explicit enablement mode; defaults to `'auto'`. */
  mode?: AuthMode;
  /** Clock injection point for tests. */
  now?: () => Date;
  /** Injectable store (tests); otherwise one is created at the workspace path. */
  store?: PairingStore;
  /** Pairing file path override (tests). Defaults to `<workspace>/.superiu/pairing.json`. */
  pairingPath?: string;
}

/** Translate `SUPERIU_WEB_AUTH` into a mode. */
export function authModeFromEnv(raw: string | undefined): AuthMode {
  const value = raw?.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes') return 'on';
  if (value === '0' || value === 'false' || value === 'no') return 'off';
  return 'auto';
}

/** Whether a bind host is loopback. `127.0.0.0/8`, `::1`, and `localhost` are. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value === '::1') return true;
  if (value.startsWith('::ffff:127.')) return true;
  return /^127\./.test(value);
}

/**
 * Whether a socket peer address is the trusted loopback. Deliberately narrower
 * than {@link isLoopbackHost}: only the canonical forms are exempt, so an
 * address on the loopback network that is not literally `127.0.0.1` still has to
 * authenticate.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

/**
 * Whether the peer on a request is local to this host.
 *
 * This includes canonical loopback IP addresses (`127.0.0.1`, `::1`,
 * `::ffff:127.0.0.1`) AND Unix domain sockets (`req.socket.remoteAddress ===
 * undefined`). By POSIX definition, AF_UNIX is strictly local inter-process
 * communication on the same host. Desktop remote mode forwards over SSH to a
 * Unix domain socket.
 */
export function isLoopbackPeer(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  if (addr === undefined) return true;
  return isLoopbackAddress(addr);
}

/** Resolve enablement from mode, host, and stored credentials. */
export function resolveAuthEnabled(
  host: string,
  hasCredentials: boolean,
  envValue?: string
): boolean {
  const mode = authModeFromEnv(envValue);
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return !isLoopbackHost(host) || hasCredentials;
}

/** Read a cookie by name from the `Cookie` header. */
function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Whether the request reached us over TLS (directly or through a proxy). */
function requestIsSecure(req: http.IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  const value = Array.isArray(proto) ? proto[0] : proto;
  if (typeof value === 'string' && value.split(',')[0]?.trim().toLowerCase() === 'https') {
    return true;
  }
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

/** The credential presented on a request, if any. `Authorization` wins. */
function extractCredential(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match && match[1]) return match[1].trim();
  }
  return readCookie(req, PAIRING_COOKIE_NAME);
}

function peerAddress(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unix';
}

/**
 * The pairing authentication layer. One instance per server.
 */
export class AuthLayer {
  readonly store: PairingStore;
  readonly ttlDays: number;
  private readonly ttlMs: number;
  private readonly host: string;
  private readonly mode: AuthMode;
  private readonly now: () => Date;
  /** Failed attempts per peer address, newest last. */
  private readonly failures = new Map<string, number[]>();
  /** Last `Set-Cookie` time per key id. */
  private readonly lastCookieAt = new Map<string, number>();

  constructor(options: AuthLayerOptions) {
    this.host = options.host;
    this.mode = options.mode ?? 'auto';
    this.now = options.now ?? (() => new Date());
    const pairingPath =
      options.pairingPath ?? path.join(options.workspaceDir, '.superiu', 'pairing.json');
    this.store =
      options.store ?? new PairingStore(pairingPath, { now: this.now });
    this.ttlDays = this.store.ttlDays;
    this.ttlMs = this.ttlDays * 24 * 60 * 60 * 1000;
  }

  /** Whether auth is currently enforced. */
  isEnabled(): boolean {
    if (this.mode === 'on') return true;
    if (this.mode === 'off') return false;
    return !isLoopbackHost(this.host) || this.store.hasCredentials();
  }

  /**
   * Handle a request before the normal API routing. Returns `true` when the
   * response was fully written (or blocked) and the caller must stop.
   */
  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<boolean> {
    const method = req.method ?? 'GET';
    const pathname = url.pathname;

    if (this.mode !== 'off') {
      // Public pairing endpoints: reachable without a credential, because the
      // code/key they carry *is* the credential being established.
      if (pathname === '/api/pair' && method === 'POST') {
        await handlePair(this, req, res);
        return true;
      }
      if (pathname.startsWith('/auth/connect/') && method === 'GET') {
        handleConnectCode(this, req, res, url);
        return true;
      }

      // Pairing management requires a credential (loopback is always trusted).
      if (pathname === '/api/pairing' || pathname.startsWith('/api/pairing/')) {
        const who = this.authenticate(req, res);
        if (!who) return true;
        await handlePairing(this, who, req, res, url);
        return true;
      }
    }

    if (!this.isEnabled()) return false;

    // Static assets, `/readyz` and `/favicon*` are always public.
    if (!pathname.startsWith('/api/')) return false;

    // A loopback peer is trusted (desktop remote mode over an SSH tunnel).
    if (isLoopbackPeer(req)) return false;

    const who = this.authenticate(req, res);
    return who === null;
  }

  /**
   * Verify the request's credential, applying the failure throttle. On success
   * returns the key and refreshes the cookie; on failure writes 401/429 and
   * returns `null`. A loopback peer is trusted and needs no credential.
   */
  authenticate(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): AuthenticatedKey | null {
    if (isLoopbackPeer(req)) {
      return { id: '', label: 'local', raw: '' };
    }

    const peer = peerAddress(req);
    if (this.throttled(peer)) {
      sendJson(res, 429, { error: 'too_many_requests' });
      return null;
    }

    const credential = extractCredential(req);
    if (credential) {
      const record = this.store.verify(credential);
      if (record) {
        this.store.markUsed(credential);
        this.maybeRefreshCookie(req, res, record.id, credential);
        return { id: record.id, label: record.label, raw: credential };
      }
    }

    this.recordFailure(peer);
    this.sendUnauthorized(req, res);
    return null;
  }

  /** Reject a `/api/pair` attempt, honouring the same throttle. */
  rejectPair(req: http.IncomingMessage, res: http.ServerResponse): void {
    const peer = peerAddress(req);
    if (this.throttled(peer)) {
      sendJson(res, 429, { error: 'too_many_requests' });
      return;
    }
    this.recordFailure(peer);
    sendJson(res, 401, { error: 'invalid_code_or_key' });
  }

  /**
   * Mint a one-time connect code. When `advertiseUrl` is omitted the URL is a
   * relative path; callers that know the public origin should pass it.
   */
  mintConnectCode(advertiseUrl?: string): { code: string; url: string; expiresAt: string } {
    const minted = this.store.mintCode();
    const base = (advertiseUrl ?? '').replace(/\/+$/, '');
    const suffix = `/auth/connect/${minted.raw}`;
    return { code: minted.raw, url: base ? `${base}${suffix}` : suffix, expiresAt: minted.expiresAt };
  }

  /** The scheme + host a browser used to reach us. */
  publicOrigin(req: http.IncomingMessage): string {
    const scheme = requestIsSecure(req) ? 'https' : 'http';
    const host = req.headers.host ?? 'localhost';
    return `${scheme}://${host}`;
  }

  /** Set the pairing cookie, honouring the TTL and transport security. */
  issueCookie(res: http.ServerResponse, req: http.IncomingMessage, rawKey: string): void {
    const maxAge = Math.floor(this.ttlMs / 1000);
    const parts = [
      `${PAIRING_COOKIE_NAME}=${rawKey}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`
    ];
    if (requestIsSecure(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private maybeRefreshCookie(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    rawKey: string
  ): void {
    const now = this.now().getTime();
    const last = this.lastCookieAt.get(id) ?? 0;
    if (now - last < COOKIE_REFRESH_INTERVAL_MS) return;
    this.issueCookie(res, req, rawKey);
    this.lastCookieAt.set(id, now);
  }

  private throttled(peer: string): boolean {
    const now = this.now().getTime();
    const recent = (this.failures.get(peer) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);
    this.failures.set(peer, recent);
    return recent.length >= MAX_FAILURES_PER_WINDOW;
  }

  private recordFailure(peer: string): void {
    const now = this.now().getTime();
    const recent = (this.failures.get(peer) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);
    recent.push(now);
    this.failures.set(peer, recent);
  }

  /**
   * 401 with a JSON body. A `WWW-Authenticate` challenge is sent only for a
   * top-level navigation; a fetch that received it would trigger the browser's
   * native credential prompt and stall the app.
   */
  private sendUnauthorized(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.headers['sec-fetch-mode'] === 'navigate') {
      res.setHeader('WWW-Authenticate', 'Bearer realm="superiu"');
    }
    sendJson(res, 401, { error: 'unauthorized' });
  }
}

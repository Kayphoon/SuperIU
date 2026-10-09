/**
 * Tests for the web-console pairing authentication layer.
 *
 * Two layers are exercised:
 *
 *  - {@link PairingStore}: sliding expiry, one-time codes, the `markUsed` write
 *    throttle, revocation, and the mtime read-through cache. Clocks are injected
 *    (the store takes `now: () => Date`) rather than faked, so expiry can be
 *    driven years into the future without touching timers.
 *  - {@link AuthLayer} + `startServer`: a real ephemeral HTTP server with auth
 *    forced on, so the 401/429 paths, the pair endpoints, the connect redirect
 *    and the loopback exemption are validated end-to-end.
 *
 * The loopback exemption makes a `127.0.0.1` client trusted even with auth on,
 * so the enforced paths are driven from a NON-loopback local address: the server
 * binds `0.0.0.0` and the test connects to the host's own LAN address, which the
 * kernel reports as the socket peer.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_PAIRING_TTL_DAYS,
  PAIRING_CODE_TTL_MS,
  PairingStore,
  parseTtlDays
} from '../src/auth/store.js';
import {
  authModeFromEnv,
  isLoopbackAddress,
  isLoopbackHost,
  resolveAuthEnabled
} from '../src/auth/middleware.js';
import { startServer, type ServerHandle } from '../src/server.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-pairing-'));
  tempDirs.push(dir);
  return dir;
}

interface MutableClock {
  ms: number;
}

function makeStore(ttlDays?: number): { dir: string; store: PairingStore; clock: MutableClock } {
  const dir = tempDir();
  const clock: MutableClock = { ms: T0 };
  const store = new PairingStore(path.join(dir, 'pairing.json'), {
    ttlDays,
    now: () => new Date(clock.ms)
  });
  return { dir, store, clock };
}

/** Identify a file by inode so a replace-by-rename is detectable. */
function fileStamp(file: string): string {
  const stat = fs.statSync(file);
  return `${stat.ino}:${stat.mtimeMs}`;
}

function cookieValue(res: Response, name: string): string | undefined {
  const header = res.headers.get('set-cookie');
  if (!header) return undefined;
  const match = new RegExp(`${name}=([^;]+)`).exec(header);
  return match?.[1];
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * A raw HTTP GET. `fetch` silently drops forbidden headers such as
 * `sec-fetch-mode`, so this is the only way to exercise the navigation challenge.
 */
function rawGet(url: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

/** The host's own non-loopback IPv4, if it has one. */
function nonLoopbackIPv4(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

const servers: ServerHandle[] = [];
async function startAuthServer(host: string, webAuth = true): Promise<ServerHandle> {
  const handle = await startServer({
    port: 0,
    host,
    workspaceDir: tempDir(),
    settingsFile: path.join(tempDir(), 'ui-settings.json'),
    quiet: true,
    gatewayPath: null,
    webAuth
  });
  servers.push(handle);
  return handle;
}

afterEach(async () => {
  for (const handle of servers.splice(0)) {
    await handle.close().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PairingStore
// ---------------------------------------------------------------------------

describe('PairingStore', () => {
  it('mints a 64-hex key and a base64url one-time code', () => {
    const { store } = makeStore();
    const key = store.mintKey('web');
    expect(key.raw).toMatch(/^[0-9a-f]{64}$/);
    expect(key.id).toMatch(/^[0-9a-f]{12}$/);

    const code = store.mintCode();
    expect(code.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code.raw.length).toBeGreaterThan(20);
  });

  it('stores only hashes, never the raw secret', () => {
    const { dir, store } = makeStore();
    const { raw } = store.mintKey('web');
    const onDisk = fs.readFileSync(path.join(dir, 'pairing.json'), 'utf-8');
    expect(onDisk).not.toContain(raw);
  });

  it('slides expiry: valid at day 29, invalid at day 31', () => {
    const { store, clock } = makeStore();
    const { raw } = store.mintKey('web');

    clock.ms = T0 + 29 * DAY_MS;
    expect(store.verify(raw)).toEqual({ id: expect.any(String), label: 'web' });

    clock.ms = T0 + 31 * DAY_MS;
    expect(store.verify(raw)).toBeNull();
  });

  it('extends expiry on use, then expires 30 days after the last use', () => {
    const { store, clock } = makeStore();
    const { raw } = store.mintKey('web');

    clock.ms = T0 + 20 * DAY_MS;
    store.markUsed(raw);

    // 45 days after creation, but only 25 after last use -> still valid.
    clock.ms = T0 + 45 * DAY_MS;
    expect(store.verify(raw)).not.toBeNull();

    // 31 days after last use -> expired.
    clock.ms = T0 + 51 * DAY_MS;
    expect(store.verify(raw)).toBeNull();
  });

  it('honours a custom TTL', () => {
    const { store, clock } = makeStore(1);
    const { raw } = store.mintKey('web');
    clock.ms = T0 + 2 * DAY_MS;
    expect(store.verify(raw)).toBeNull();
  });

  it('consumes a one-time code exactly once', () => {
    const { store, clock } = makeStore();
    const code = store.mintCode();

    clock.ms = T0 + 4 * 60 * 1000;
    const issued = store.consumeCode(code.raw, 'web');
    expect(issued?.raw).toMatch(/^[0-9a-f]{64}$/);
    expect(issued?.id).toMatch(/^[0-9a-f]{12}$/);

    // The key it issued works; the code does not.
    expect(store.verify(issued?.raw ?? '')).not.toBeNull();
    expect(store.consumeCode(code.raw, 'web')).toBeNull();
  });

  it('rejects an expired code', () => {
    const { store, clock } = makeStore();
    const code = store.mintCode();
    clock.ms = T0 + PAIRING_CODE_TTL_MS + 1000;
    expect(store.consumeCode(code.raw, 'web')).toBeNull();
  });

  it('sweeps expired keys and codes on load', () => {
    const { dir, store, clock } = makeStore();
    store.mintKey('web');
    store.mintCode();
    clock.ms = T0 + 31 * DAY_MS;

    // A fresh store reads and prunes the same file.
    const reloaded = new PairingStore(path.join(dir, 'pairing.json'), {
      now: () => new Date(clock.ms)
    });
    expect(reloaded.list()).toHaveLength(0);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'pairing.json'), 'utf-8')) as {
      keys: unknown[];
      codes: unknown[];
    };
    expect(onDisk.keys).toHaveLength(0);
    expect(onDisk.codes).toHaveLength(0);
  });

  it('writes markUsed at most once an hour per key', () => {
    const { dir, store, clock } = makeStore();
    const { raw } = store.mintKey('web');
    const file = path.join(dir, 'pairing.json');

    const afterMint = fileStamp(file);

    clock.ms = T0 + 60 * 1000;
    store.markUsed(raw);
    const afterFirst = fileStamp(file);
    expect(afterFirst).not.toBe(afterMint);

    clock.ms = T0 + 31 * 60 * 1000;
    store.markUsed(raw);
    expect(fileStamp(file)).toBe(afterFirst);

    clock.ms = T0 + 62 * 60 * 1000;
    store.markUsed(raw);
    expect(fileStamp(file)).not.toBe(afterFirst);
  });

  it('revokes by id and revokes all', () => {
    const { store } = makeStore();
    const first = store.mintKey('one');
    const second = store.mintKey('two');
    expect(store.list()).toHaveLength(2);

    expect(store.revoke(first.id)).toBe(true);
    expect(store.verify(first.raw)).toBeNull();
    expect(store.verify(second.raw)).not.toBeNull();
    expect(store.revoke(first.id)).toBe(false);

    expect(store.revokeAll()).toBe(1);
    expect(store.list()).toHaveLength(0);
  });

  it('revokeAll(exceptId) keeps one key', () => {
    const { store } = makeStore();
    const keep = store.mintKey('keep');
    store.mintKey('drop');
    expect(store.revokeAll(keep.id)).toBe(1);
    expect(store.list().map((key) => key.id)).toEqual([keep.id]);
  });

  it('re-reads a file changed by another process', () => {
    const dir = tempDir();
    const file = path.join(dir, 'pairing.json');
    const writer = new PairingStore(file);
    const reader = new PairingStore(file);

    const { raw } = writer.mintKey('offline');
    expect(reader.verify(raw)).toEqual({ id: expect.any(String), label: 'offline' });
  });

  it('lists keys without exposing hashes, with a projected expiresAt', () => {
    const { store, clock } = makeStore();
    const { id } = store.mintKey('web');
    clock.ms = T0 + 5 * DAY_MS;
    const [view] = store.list();
    expect(view).toBeDefined();
    expect(view?.id).toBe(id);
    expect(Object.keys(view ?? {})).toEqual(
      expect.arrayContaining(['id', 'label', 'createdAt', 'lastUsedAt', 'expiresAt'])
    );
    expect(view && 'hash' in view).toBe(false);
    expect(view?.expiresAt).toBe(new Date(T0 + 30 * DAY_MS).toISOString());
  });
});

describe('parseTtlDays', () => {
  it('parses a positive number and falls back on junk', () => {
    expect(parseTtlDays(undefined)).toBe(DEFAULT_PAIRING_TTL_DAYS);
    expect(parseTtlDays('7')).toBe(7);
    expect(parseTtlDays(' 14 ')).toBe(14);
    expect(parseTtlDays('0')).toBe(DEFAULT_PAIRING_TTL_DAYS);
    expect(parseTtlDays('-3')).toBe(DEFAULT_PAIRING_TTL_DAYS);
    expect(parseTtlDays('nope')).toBe(DEFAULT_PAIRING_TTL_DAYS);
  });
});

// ---------------------------------------------------------------------------
// Enablement predicate
// ---------------------------------------------------------------------------

describe('auth enablement', () => {
  it('maps SUPERIU_WEB_AUTH to a mode', () => {
    expect(authModeFromEnv('1')).toBe('on');
    expect(authModeFromEnv('true')).toBe('on');
    expect(authModeFromEnv('0')).toBe('off');
    expect(authModeFromEnv('no')).toBe('off');
    expect(authModeFromEnv(undefined)).toBe('auto');
    expect(authModeFromEnv('whatever')).toBe('auto');
  });

  it('classifies bind hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.53')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('10.0.0.13')).toBe(false);
  });

  it('classifies peer addresses strictly', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.2')).toBe(false);
    expect(isLoopbackAddress('10.0.0.13')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('resolves the AUTO rule', () => {
    expect(resolveAuthEnabled('127.0.0.1', false, undefined)).toBe(false);
    expect(resolveAuthEnabled('127.0.0.1', true, undefined)).toBe(true);
    expect(resolveAuthEnabled('0.0.0.0', false, undefined)).toBe(true);
    expect(resolveAuthEnabled('0.0.0.0', false, '0')).toBe(false);
    expect(resolveAuthEnabled('127.0.0.1', false, '1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Middleware + endpoints on a real server
// ---------------------------------------------------------------------------

describe('AuthLayer over HTTP', () => {
  it('exempts a loopback peer even with auth forced on', async () => {
    const handle = await startAuthServer('127.0.0.1', true);
    expect(handle.pairingEnabled).toBe(true);

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/status`);
    expect(res.status).toBe(200);
  });

  it('reports the resolved pairing flag on the handle', async () => {
    const handle = await startAuthServer('127.0.0.1', false);
    expect(handle.pairingEnabled).toBe(false);
  });

  it('allows a loopback peer to manage pairing even in auto mode with no keys', async () => {
    const handle = await startServer({
      port: 0,
      host: '127.0.0.1',
      workspaceDir: tempDir(),
      settingsFile: path.join(tempDir(), 'ui-settings.json'),
      quiet: true,
      gatewayPath: null
    });
    servers.push(handle);

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/pairing`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[]; ttlDays: number };
    expect(body.ttlDays).toBe(30);
    expect(body.keys).toEqual([]);

    const mintRes = await fetch(`http://127.0.0.1:${handle.port}/api/pairing/code`, { method: 'POST' });
    expect(mintRes.status).toBe(200);
    const mintBody = (await mintRes.json()) as { code: string; url: string };
    expect(mintBody.url).toContain('/auth/connect/');
  });

  const lanIp = nonLoopbackIPv4();
  const enforced = lanIp ? it : it.skip;

  enforced('rejects an unauthenticated request with 401 JSON', async () => {
    const handle = await startAuthServer('0.0.0.0', true);
    const res = await fetch(`http://${lanIp}:${handle.port}/api/status`, {
      headers: { 'sec-fetch-mode': 'cors' }
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  enforced('sends a WWW-Authenticate challenge only for navigation', async () => {
    const handle = await startAuthServer('0.0.0.0', true);
    const base = `http://${lanIp}:${handle.port}/api/status`;

    const nav = await rawGet(base, { 'sec-fetch-mode': 'navigate' });
    expect(nav.status).toBe(401);
    expect(String(nav.headers['www-authenticate'])).toContain('Bearer');

    const cors = await rawGet(base, { 'sec-fetch-mode': 'cors' });
    expect(cors.status).toBe(401);
    expect(cors.headers['www-authenticate']).toBeUndefined();
  });

  enforced('pairs with a one-time code and then authenticates by cookie/bearer', async () => {
    const handle = await startAuthServer('0.0.0.0', true);
    const minted = handle.mintConnectCode(`http://${lanIp}:${handle.port}`);
    expect(minted.url).toContain('/auth/connect/');
    expect(minted.code).toBeTruthy();

    const pair = await fetch(`http://${lanIp}:${handle.port}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: minted.code })
    });
    expect(pair.status).toBe(200);
    const pairBody = (await pair.json()) as { ok: boolean; id: string; label: string };
    expect(pairBody.ok).toBe(true);
    expect(pairBody.label).toBe('web');

    const raw = cookieValue(pair, 'superiu_pair');
    expect(raw).toMatch(/^[0-9a-f]{64}$/);

    const viaCookie = await fetch(`http://${lanIp}:${handle.port}/api/status`, {
      headers: { Cookie: `superiu_pair=${raw}` }
    });
    expect(viaCookie.status).toBe(200);

    const viaBearer = await fetch(`http://${lanIp}:${handle.port}/api/status`, {
      headers: { Authorization: `Bearer ${raw}` }
    });
    expect(viaBearer.status).toBe(200);
  });

  enforced('rejects a bad pairing code with 401', async () => {
    const handle = await startAuthServer('0.0.0.0', true);
    const res = await fetch(`http://${lanIp}:${handle.port}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'not-a-real-code' })
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_code_or_key' });
  });

  enforced('redirects /auth/connect/:code once and rejects the second use', async () => {
    const handle = await startAuthServer('0.0.0.0', true);
    const minted = handle.mintConnectCode();

    const first = await fetch(`http://${lanIp}:${handle.port}/auth/connect/${minted.code}`, {
      redirect: 'manual'
    });
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('/');
    expect(cookieValue(first, 'superiu_pair')).toMatch(/^[0-9a-f]{64}$/);

    const second = await fetch(`http://${lanIp}:${handle.port}/auth/connect/${minted.code}`, {
      redirect: 'manual'
    });
    expect(second.status).toBe(302);
    expect(second.headers.get('location')).toBe('/?pair_error=invalid');
  });

  enforced('throttles repeated failures with 429', async () => {
    const handle = await startAuthServer('0.0.0.0', true);
    const url = `http://${lanIp}:${handle.port}/api/status`;

    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(url, { headers: { 'sec-fetch-mode': 'cors' } });
      expect(res.status).toBe(401);
    }
    const throttled = await fetch(url, { headers: { 'sec-fetch-mode': 'cors' } });
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual({ error: 'too_many_requests' });
  });

  enforced('lists, mints and revokes keys through the API', async () => {
    const handle = await startAuthServer('0.0.0.0', true);
    const base = `http://${lanIp}:${handle.port}`;
    const minted = handle.mintConnectCode(base);
    const pair = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: minted.code })
    });
    const raw = cookieValue(pair, 'superiu_pair') ?? '';
    const auth = { Cookie: `superiu_pair=${raw}` };

    const list = await fetch(`${base}/api/pairing`, { headers: auth });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { keys: Array<Record<string, unknown>>; ttlDays: number };
    expect(listBody.ttlDays).toBe(30);
    expect(listBody.keys).toHaveLength(1);
    expect(listBody.keys[0] && 'hash' in listBody.keys[0]).toBe(false);

    const codeRes = await fetch(`${base}/api/pairing/code`, { method: 'POST', headers: auth });
    expect(codeRes.status).toBe(200);
    const codeBody = (await codeRes.json()) as { code: string; url: string; expiresAt: string };
    expect(codeBody.url).toContain('/auth/connect/');
    expect(codeBody.expiresAt).toBeTruthy();

    const id = listBody.keys[0]?.id as string;
    const revoke = await fetch(`${base}/api/pairing/${id}`, { method: 'DELETE', headers: auth });
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({ revoked: true });

    // The revoked key can no longer authenticate.
    const after = await fetch(`${base}/api/status`, { headers: auth });
    expect(after.status).toBe(401);
  });

  enforced('requires auth for the pairing management API', async () => {
    const handle = await startAuthServer('0.0.0.0', true);
    const res = await fetch(`http://${lanIp}:${handle.port}/api/pairing`, {
      headers: { 'sec-fetch-mode': 'cors' }
    });
    expect(res.status).toBe(401);
  });
});

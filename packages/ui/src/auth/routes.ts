/**
 * HTTP handlers for the pairing endpoints.
 *
 * These are invoked by {@link AuthLayer.handle}:
 *
 *   - `GET  /auth/connect/:code`  — browser navigation; consumes the code and
 *     redirects to `/` with the cookie set.
 *   - `POST /api/pair`            — programmatic pairing with a code or a key.
 *   - `GET  /api/pairing`         — list keys (auth required).
 *   - `POST /api/pairing/code`    — mint a one-time code (auth required).
 *   - `DELETE /api/pairing[/:id]` — revoke one key or every other key.
 *
 * Raw keys and codes appear in a response only at the moment they are minted —
 * they are never logged.
 */

import * as http from 'node:http';
import type { AuthLayer, AuthenticatedKey } from './middleware.js';

const MAX_BODY_BYTES = 1_000_000;

/** Write a JSON response. Shared with the middleware's error paths. */
export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/**
 * `GET /auth/connect/:code`: consume the one-time code, set the cookie and
 * redirect home. Every failure mode redirects to `/?pair_error=invalid` so the
 * SPA can explain it — this route is reached by navigation, not fetch.
 */
export function handleConnectCode(
  layer: AuthLayer,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): void {
  let raw = '';
  try {
    raw = decodeURIComponent(url.pathname.slice('/auth/connect/'.length));
  } catch {
    raw = '';
  }

  let issued = raw ? layer.store.consumeCode(raw, 'web') : null;
  if (!issued && raw && /^[0-9a-fA-F]{64}$/.test(raw)) {
    const verified = layer.store.verify(raw);
    if (verified) {
      layer.store.markUsed(raw);
      issued = { raw, id: verified.id };
    }
  }
  if (!issued) {
    redirect(res, '/?pair_error=invalid');
    return;
  }
  layer.issueCookie(res, req, issued.raw);
  redirect(res, '/');
}

/** `POST /api/pair`: exchange a one-time code (preferred) or an existing key. */
export async function handlePair(
  layer: AuthLayer,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid_body' });
    return;
  }

  const rawLabel = typeof body.label === 'string' ? body.label.trim() : '';
  const label = rawLabel ? rawLabel.slice(0, 64) : 'web';
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const key = typeof body.key === 'string' ? body.key.trim() : '';

  if (code) {
    const issued = layer.store.consumeCode(code, label);
    if (!issued) {
      layer.rejectPair(req, res);
      return;
    }
    layer.issueCookie(res, req, issued.raw);
    sendJson(res, 200, { ok: true, label, id: issued.id });
    return;
  }

  if (key) {
    const record = layer.store.verify(key);
    if (!record) {
      layer.rejectPair(req, res);
      return;
    }
    layer.store.markUsed(key);
    layer.issueCookie(res, req, key);
    sendJson(res, 200, { ok: true, label: record.label, id: record.id });
    return;
  }

  sendJson(res, 400, { error: 'missing_code_or_key' });
}

/** The credential-gated pairing management routes. */
export async function handlePairing(
  layer: AuthLayer,
  who: AuthenticatedKey,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<void> {
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  if (pathname === '/api/pairing' && method === 'GET') {
    sendJson(res, 200, { keys: layer.store.list(), ttlDays: layer.ttlDays });
    return;
  }

  if (pathname === '/api/pairing/code' && method === 'POST') {
    sendJson(res, 200, layer.mintConnectCode(layer.publicOrigin(req)));
    return;
  }

  if (pathname === '/api/pairing' && method === 'DELETE') {
    // No id: revoke every key except the one making this request (a loopback
    // peer presents none, so it revokes all).
    const revoked = layer.store.revokeAll(who.id || undefined);
    sendJson(res, 200, { revoked });
    return;
  }

  if (pathname.startsWith('/api/pairing/') && method === 'DELETE') {
    let id = '';
    try {
      id = decodeURIComponent(pathname.slice('/api/pairing/'.length));
    } catch {
      id = '';
    }
    sendJson(res, 200, { revoked: id ? layer.store.revoke(id) : false });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

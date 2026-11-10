import * as http from 'node:http';
import * as https from 'node:https';
import type { Duplex } from 'node:stream';
import type { DshManager } from './dsh.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

export function isDshPath(pathname: string): boolean {
  return pathname === '/dsh' || pathname.startsWith('/dsh/');
}

/**
 * Detect Vite-style content-hashed static assets served under DSH's assets directory.
 * e.g. `/dsh/assets/vendor-BUMdD3V7.js`, `/dsh/assets/fonts/montserrat-light-Cvd2VjE_.woff2`,
 * `/dsh/assets/langs/python-B6aJPvgy.js`.
 * Non-hashed files (e.g. `/dsh/assets/fonts/Montserrat-OFL.txt`, HTML roots, plugins) return false.
 */
export function isHashedDshAsset(pathname: string): boolean {
  return /^\/dsh\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|ttf|eot|png|jpe?g|gif|svg|ico|webp|wasm)$/i.test(pathname);
}

function targetPath(url: URL): string {
  const pathname = url.pathname.slice('/dsh'.length) || '/';
  return `${pathname}${url.search}`;
}

function requestIsSecure(req: http.IncomingMessage): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return Boolean((req.socket as { encrypted?: boolean }).encrypted) ||
    typeof value === 'string' && value.split(',')[0]?.trim().toLowerCase() === 'https';
}

function requestHeaders(req: http.IncomingMessage, websocket = false): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  delete headers.authorization;
  const cookie = req.headers.cookie
    ?.split(';')
    .filter((part) => part.trim().split('=', 1)[0] !== 'superiu_pair')
    .join('; ');
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  for (const name of Object.keys(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) && !(websocket && ['connection', 'upgrade'].includes(name.toLowerCase()))) {
      delete headers[name];
    }
  }
  return headers;
}

function rewriteLocation(value: string, target: URL, requestPath: string): string {
  try {
    const location = new URL(value, new URL(requestPath, target.origin));
    if (location.origin === target.origin) return `/dsh${location.pathname}${location.search}${location.hash}`;
  } catch {
    return value;
  }
  return value;
}

function rewriteCookie(value: string, secure: boolean): string {
  let cookie = /;\s*Path=\/(?=;|$)/i.test(value)
    ? value.replace(/;\s*Path=\/(?=;|$)/i, '; Path=/dsh/')
    : `${value}; Path=/dsh/`;
  if (secure && !/;\s*Secure(?=;|$)/i.test(cookie)) cookie += '; Secure';
  return cookie;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class DshProxy {
  private readonly tunnels = new Set<{ client: Duplex; upstream: Duplex }>();
  private readonly manager: Pick<DshManager, 'getTargetOrigin'>;

  constructor(manager: Pick<DshManager, 'getTargetOrigin'>) {
    this.manager = manager;
  }

  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (url.pathname === '/dsh') {
      res.writeHead(308, { location: `/dsh/${url.search}` });
      res.end();
      return;
    }
    const origin = this.manager.getTargetOrigin();
    if (!origin) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('DSH is not connected.\n');
      return;
    }
    const target = new URL(origin);
    const transport = target.protocol === 'https:' ? https : http;
    const upstream = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: targetPath(url),
      headers: requestHeaders(req),
      agent: false
    }, (backend) => {
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(backend.headers)) {
        const lower = name.toLowerCase();
        if (HOP_BY_HOP.has(lower) || lower === 'set-cookie') continue;
        headers[name] = lower === 'location' && typeof value === 'string'
          ? rewriteLocation(value, target, targetPath(url))
          : value;
      }
      const cookies = backend.headers['set-cookie'];
      if (cookies) headers['set-cookie'] = cookies.map((cookie) => rewriteCookie(cookie, requestIsSecure(req)));
      if (isHashedDshAsset(url.pathname) && (backend.statusCode === 200 || backend.statusCode === 304)) {
        headers['cache-control'] = 'public, max-age=31536000, immutable';
      }
      res.writeHead(backend.statusCode ?? 502, backend.statusMessage, headers);
      backend.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('DSH upstream is unavailable.\n');
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  }

  upgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    authorize: () => boolean
  ): void {
    const origin = this.manager.getTargetOrigin();
    if (!authorize()) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (!origin) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    const target = new URL(origin);
    const transport = target.protocol === 'https:' ? https : http;
    const upstream = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: 'GET',
      path: targetPath(url),
      headers: requestHeaders(req, true),
      agent: false
    });
    const timer = setTimeout(() => {
      upstream.destroy();
      rejectUpgrade(socket, 504, 'Gateway Timeout');
    }, 10_000);
    upstream.once('upgrade', (backend, backendSocket, backendHead) => {
      clearTimeout(timer);
      socket.write(`HTTP/${backend.httpVersion} ${backend.statusCode ?? 101} ${backend.statusMessage ?? 'Switching Protocols'}\r\n`);
      for (let index = 0; index < backend.rawHeaders.length; index += 2) {
        socket.write(`${backend.rawHeaders[index]}: ${backend.rawHeaders[index + 1]}\r\n`);
      }
      socket.write('\r\n');
      if (backendHead.length) socket.write(backendHead);
      if (head.length) backendSocket.write(head);
      const tunnel = { client: socket, upstream: backendSocket };
      this.tunnels.add(tunnel);
      const close = (): void => {
        this.tunnels.delete(tunnel);
        socket.destroy();
        backendSocket.destroy();
      };
      socket.once('close', close);
      backendSocket.once('close', close);
      socket.pipe(backendSocket);
      backendSocket.pipe(socket);
    });
    upstream.once('response', (backend) => {
      clearTimeout(timer);
      backend.resume();
      rejectUpgrade(socket, backend.statusCode ?? 502, backend.statusMessage ?? 'Bad Gateway');
    });
    upstream.once('error', () => {
      clearTimeout(timer);
      if (!socket.destroyed) rejectUpgrade(socket, 502, 'Bad Gateway');
    });
    upstream.end();
  }

  close(): void {
    for (const tunnel of this.tunnels) {
      tunnel.client.destroy();
      tunnel.upstream.destroy();
    }
    this.tunnels.clear();
  }
}

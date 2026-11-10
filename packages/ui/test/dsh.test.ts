import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshManager } from '../src/dsh.js';
import { DshProxy, isHashedDshAsset } from '../src/dsh_proxy.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return address.port;
}

function readyManager(url: string): Pick<DshManager, 'getTargetOrigin'> {
  return {
    getTargetOrigin: () => new URL(url).origin
  };
}

describe('DSH manager', () => {
  it('rejects a non-DSH discovery service, manages a real instance, and adopts it without duplication', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'superiu-dsh-manager-'));
    cleanups.push(() => rm(workspaceDir, { recursive: true, force: true }));
    let discoveryRequests = 0;
    const nonDsh = http.createServer((req, res) => {
      discoveryRequests++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const discoveryPort = await listen(nonDsh);
    const env = {
      ...process.env,
      SUPERIU_DSH_URL: '',
      SUPERIU_DSH_PORT: String(discoveryPort),
      DSH_HOME: join(workspaceDir, 'dsh-home')
    };
    await mkdir(join(workspaceDir, '.superiu', 'dsh.log'), { recursive: true });
    const managed = new DshManager({ workspaceDir, env });
    cleanups.push(() => managed.close());
    const state = await managed.connect('http://127.0.0.1:43117');
    expect(state.state).toBe('ready');
    expect(state.managed).toBe(true);
    expect(discoveryRequests).toBeGreaterThan(0);
    expect(managed.getStatus().error).toBeUndefined();

    const publicLaunch = new URL(state.url!, 'http://127.0.0.1');
    const discovered = new DshManager({
      workspaceDir,
      env: { ...env, SUPERIU_DSH_URL: `${managed.getTargetOrigin()}${publicLaunch.search}` }
    });
    cleanups.push(() => discovered.close());
    const adopted = await discovered.connect('http://127.0.0.1:43117');
    expect(adopted.error).toBeUndefined();
    expect(adopted.state).toBe('ready');
    expect(adopted.managed).toBe(false);
    expect(adopted.url).toBe(state.url);
    await discovered.close();
    expect(managed.getStatus().state).toBe('ready');

    const targetOrigin = managed.getTargetOrigin();
    expect(targetOrigin).toBeDefined();
    await managed.close();
    expect(managed.getStatus().state).toBe('idle');
    await expect(fetch(targetOrigin!, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
  }, 120_000);

  it('does not leave a managed child when closed during discovery', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'superiu-dsh-close-'));
    cleanups.push(() => rm(workspaceDir, { recursive: true, force: true }));
    let markProbe!: () => void;
    const probeSeen = new Promise<void>((resolve) => { markProbe = resolve; });
    let releaseProbe!: () => void;
    const probeRelease = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const discovery = http.createServer((_req, res) => {
      markProbe();
      void probeRelease.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    const discoveryPort = await listen(discovery);
    const manager = new DshManager({
      workspaceDir,
      env: {
        ...process.env,
        SUPERIU_DSH_URL: '',
        SUPERIU_DSH_PORT: String(discoveryPort),
        DSH_HOME: join(workspaceDir, 'dsh-home')
      }
    });
    cleanups.push(() => manager.close());
    const connecting = manager.connect('http://127.0.0.1:43117');
    await probeSeen;
    const closing = manager.close();
    releaseProbe();
    await Promise.all([connecting, closing]);
    expect(manager.getStatus().state).toBe('idle');
    let log = '';
    try {
      log = await readFile(join(workspaceDir, '.superiu', 'dsh.log'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const readyUrl = /dsh web:\s*(https?:\/\/\S+)/.exec(log)?.[1];
    if (readyUrl) {
      await expect(fetch(readyUrl, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
    }
  }, 120_000);

  it('falls back for protected discovery but reports auth for an explicit URL', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'superiu-dsh-protected-'));
    cleanups.push(() => rm(workspaceDir, { recursive: true, force: true }));
    const protectedDsh = http.createServer((_req, res) => {
      res.writeHead(401);
      res.end('dsh web authentication required');
    });
    const discoveryPort = await listen(protectedDsh);
    const env = {
      ...process.env,
      SUPERIU_DSH_URL: '',
      SUPERIU_DSH_PORT: String(discoveryPort),
      SUPERIU_DSH_BIN: join(workspaceDir, 'missing-dsh.js')
    };
    const automatic = new DshManager({ workspaceDir, env });
    cleanups.push(() => automatic.close());
    expect((await automatic.connect('http://127.0.0.1:43117')).error).toBe('cli_missing');
    const explicit = new DshManager({
      workspaceDir,
      env: { ...env, SUPERIU_DSH_URL: `http://127.0.0.1:${discoveryPort}/` }
    });
    cleanups.push(() => explicit.close());
    expect((await explicit.connect('http://127.0.0.1:43117')).error).toBe('auth_required');
  });

  it('returns a stable error when the configured CLI does not exist', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'superiu-dsh-missing-'));
    cleanups.push(() => rm(workspaceDir, { recursive: true, force: true }));
    const nonDsh = http.createServer((_req, res) => res.end('not dsh'));
    const discoveryPort = await listen(nonDsh);
    const manager = new DshManager({
      workspaceDir,
      env: {
        ...process.env,
        SUPERIU_DSH_URL: '',
        SUPERIU_DSH_PORT: String(discoveryPort),
        SUPERIU_DSH_BIN: join(workspaceDir, 'missing-dsh.js'),
        DSH_HOME: join(workspaceDir, 'dsh-home')
      }
    });
    cleanups.push(() => manager.close());
    const state = await manager.connect('http://127.0.0.1:43117');
    expect(state.state).toBe('error');
    expect(state.error).toBe('cli_missing');
    expect(state.url).toBeUndefined();
    expect(manager.getStatus()).toEqual(state);
  });
});

describe('DSH proxy', () => {
  it('rewrites HTTP mount headers and tunnels a real WebSocket upgrade', async () => {
    const upstreamRequests: Array<{ url?: string; host?: string; cookie?: string; authorization?: string }> = [];
    const upstreamSockets = new Set<net.Socket>();
    const upstream = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      upstreamRequests.push({
        url: req.url, host: req.headers.host, cookie: req.headers.cookie,
        authorization: req.headers.authorization
      });
      res.writeHead(303, {
        location: req.url === '/relative' ? '../outside' : '/',
        'set-cookie': 'dsh-auth-test=secret; Path=/; HttpOnly; SameSite=Strict'
      });
      res.end();
    });
    upstream.on('upgrade', (req, socket) => {
      upstreamSockets.add(socket);
      socket.once('close', () => upstreamSockets.delete(socket));
      upstreamRequests.push({
        url: req.url, host: req.headers.host, cookie: req.headers.cookie,
        authorization: req.headers.authorization
      });
      const accept = createHash('sha1')
        .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n` +
        'dsh-upgrade-ok'
      );
    });
    const upstreamPort = await listen(upstream);
    cleanups.push(() => {
      for (const socket of upstreamSockets) socket.destroy();
    });
    const proxy = new DshProxy(readyManager(`http://127.0.0.1:${upstreamPort}/`));
    const frontend = http.createServer((req, res) => {
      proxy.handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'));
    });
    frontend.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket, head, () => true));
    const frontendPort = await listen(frontend);
    cleanups.push(() => proxy.close());

    const response = await fetch(`http://127.0.0.1:${frontendPort}/dsh/?token=test`, {
      redirect: 'manual',
      headers: { cookie: 'superiu_pair=secret; dsh-auth-test=abc', authorization: 'Bearer secret' }
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/dsh/');
    expect(response.headers.get('set-cookie')).toContain('Path=/dsh/');
    expect(upstreamRequests[0]).toEqual({
      url: '/?token=test', host: `127.0.0.1:${frontendPort}`,
      cookie: 'dsh-auth-test=abc', authorization: undefined
    });
    const relative = await fetch(`http://127.0.0.1:${frontendPort}/dsh/relative`, { redirect: 'manual' });
    expect(relative.headers.get('location')).toBe('/dsh/outside');

    const socket = net.connect(frontendPort, '127.0.0.1');
    const upgraded = new Promise<string>((resolve, reject) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.includes('dsh-upgrade-ok')) resolve(data);
      });
      socket.on('error', reject);
    });
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      'GET /dsh/socket HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${frontendPort}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      'Cookie: superiu_pair=ws-secret; dsh-auth-ws=ws-cookie\r\n' +
      'Authorization: Bearer ws-secret\r\n\r\n'
    );
    const reply = await upgraded;
    expect(reply).toContain('101 Switching Protocols');
    expect(reply).toContain('dsh-upgrade-ok');
    expect(upstreamRequests[2]).toEqual({
      url: '/socket', host: `127.0.0.1:${frontendPort}`,
      cookie: 'dsh-auth-ws=ws-cookie', authorization: undefined
    });
    socket.destroy();
  });

  it('identifies hashed DSH static assets and ignores non-hashed paths', () => {
    expect(isHashedDshAsset('/dsh/assets/vendor-BUMdD3V7.js')).toBe(true);
    expect(isHashedDshAsset('/dsh/assets/index-lh_YM6sT.css')).toBe(true);
    expect(isHashedDshAsset('/dsh/assets/fonts/montserrat-light-Cvd2VjE_.woff2')).toBe(true);
    expect(isHashedDshAsset('/dsh/assets/langs/python-B6aJPvgy.js')).toBe(true);

    expect(isHashedDshAsset('/dsh/assets/fonts/Montserrat-OFL.txt')).toBe(false);
    expect(isHashedDshAsset('/dsh/')).toBe(false);
    expect(isHashedDshAsset('/dsh/dsh.html')).toBe(false);
    expect(isHashedDshAsset('/dsh/plugins/api-gateway/client.js')).toBe(false);
    expect(isHashedDshAsset('/dsh/api/status')).toBe(false);
    expect(isHashedDshAsset('/api/dsh/status')).toBe(false);
  });

  it('rewrites Cache-Control to immutable for hashed assets on 200/304 and preserves upstream headers otherwise', async () => {
    const upstream = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';
      if (url === '/assets/vendor-BUMdD3V7.js') {
        res.writeHead(200, {
          'content-type': 'application/javascript',
          'cache-control': 'no-cache',
          etag: '"hash-123"'
        });
        res.end('console.log("vendor");');
        return;
      }
      if (url === '/assets/cached-BUMdD3V7.js') {
        res.writeHead(304, {
          'cache-control': 'no-cache',
          etag: '"hash-123"'
        });
        res.end();
        return;
      }
      if (url === '/assets/missing-BUMdD3V7.js') {
        res.writeHead(404, {
          'content-type': 'text/plain',
          'cache-control': 'no-cache'
        });
        res.end('Not found');
        return;
      }
      if (url === '/assets/fonts/Montserrat-OFL.txt') {
        res.writeHead(200, {
          'content-type': 'text/plain',
          'cache-control': 'no-cache'
        });
        res.end('License');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html',
        'cache-control': 'no-cache, must-revalidate'
      });
      res.end('<html></html>');
    });

    const upstreamPort = await listen(upstream);
    const proxy = new DshProxy(readyManager(`http://127.0.0.1:${upstreamPort}/`));
    const frontend = http.createServer((req, res) => {
      proxy.handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'));
    });
    const frontendPort = await listen(frontend);
    cleanups.push(() => proxy.close());

    // 1. Hashed 200 -> immutable
    const hashed200 = await fetch(`http://127.0.0.1:${frontendPort}/dsh/assets/vendor-BUMdD3V7.js`);
    expect(hashed200.status).toBe(200);
    expect(hashed200.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(hashed200.headers.get('etag')).toBe('"hash-123"');

    // 2. Hashed 304 -> immutable
    const hashed304 = await fetch(`http://127.0.0.1:${frontendPort}/dsh/assets/cached-BUMdD3V7.js`);
    expect(hashed304.status).toBe(304);
    expect(hashed304.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    // 3. Hashed 404 -> preserves original cache-control, NOT immutable
    const hashed404 = await fetch(`http://127.0.0.1:${frontendPort}/dsh/assets/missing-BUMdD3V7.js`);
    expect(hashed404.status).toBe(404);
    expect(hashed404.headers.get('cache-control')).toBe('no-cache');

    // 4. Non-hashed asset -> preserves original cache-control
    const plainText = await fetch(`http://127.0.0.1:${frontendPort}/dsh/assets/fonts/Montserrat-OFL.txt`);
    expect(plainText.status).toBe(200);
    expect(plainText.headers.get('cache-control')).toBe('no-cache');

    // 5. HTML root -> preserves original cache-control
    const htmlPage = await fetch(`http://127.0.0.1:${frontendPort}/dsh/`);
    expect(htmlPage.status).toBe(200);
    expect(htmlPage.headers.get('cache-control')).toBe('no-cache, must-revalidate');
  });

  it('forwards Sec-WebSocket-Extensions for compression negotiation over WebSocket upgrade', async () => {
    let receivedExtension: string | undefined;
    const upstream = http.createServer();
    upstream.on('upgrade', (req, socket) => {
      receivedExtension = req.headers['sec-websocket-extensions'] as string | undefined;
      const accept = createHash('sha1')
        .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        'Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n' +
        'deflate-ok'
      );
      cleanups.push(() => socket.destroy());
    });

    const upstreamPort = await listen(upstream);
    const proxy = new DshProxy(readyManager(`http://127.0.0.1:${upstreamPort}/`));
    const frontend = http.createServer();
    frontend.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket, head, () => true));
    const frontendPort = await listen(frontend);
    cleanups.push(() => proxy.close());

    const socket = net.connect(frontendPort, '127.0.0.1');
    const upgraded = new Promise<string>((resolve, reject) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.includes('deflate-ok')) resolve(data);
      });
      socket.on('error', reject);
    });
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      'GET /dsh/socket HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${frontendPort}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n'
    );
    const reply = await upgraded;
    expect(reply).toContain('101 Switching Protocols');
    expect(reply.toLowerCase()).toContain('sec-websocket-extensions: permessage-deflate');
    expect(receivedExtension).toBe('permessage-deflate; client_max_window_bits');
    socket.destroy();
  });
});

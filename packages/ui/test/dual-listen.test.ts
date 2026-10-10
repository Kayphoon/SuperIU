/**
 * Dual-listen tests: a Unix domain socket AND a TCP port served at once.
 *
 * `startServer` only adds the TCP listener when a positive `port` is named
 * alongside `socketPath`; an omitted port keeps the historical socket-only
 * behavior and `port: 0` opts back into it explicitly. These tests drive a real
 * server on both transports so the shared request handler and the gateway's
 * secondary upgrade listener (`GatewayServer.attachSecondary`) are validated
 * end-to-end rather than mocked.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import * as http from 'node:http';
import { WebSocket } from 'ws';
import { startServer, type ServerHandle } from '../src/server.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-dual-'));
  tempDirs.push(dir);
  return dir;
}

const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Ask the kernel for a currently-free TCP port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** GET a path over a Unix domain socket. */
function getOverSocket(socketPath: string, requestPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: requestPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

/** Open a WebSocket and resolve once the handshake completes. */
function openWebSocket(address: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(address);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('dual-listen (Unix socket + TCP)', () => {
  it('serves the API over both transports and reports the TCP url', async () => {
    const workspace = tempDir();
    const socketPath = path.join(workspace, 'server.sock');
    const port = await freePort();

    const handle = await startServer({
      socketPath,
      port,
      host: '127.0.0.1',
      workspaceDir: workspace,
      settingsFile: path.join(workspace, 'ui-settings.json'),
      quiet: true,
      gatewayPath: null
    });
    servers.push(handle);

    expect(handle.port).toBe(port);
    expect(handle.socketPath).toBe(path.resolve(socketPath));
    expect(handle.url).toBe(`http://127.0.0.1:${port}`);

    const overTcp = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(overTcp.status).toBe(200);
    expect(await overTcp.text()).toContain('"status"');

    const overSocket = await getOverSocket(socketPath, '/api/status');
    expect(overSocket.status).toBe(200);
    expect(overSocket.body).toContain('"status"');
  });

  it('answers gateway upgrades on both transports via attachSecondary', async () => {
    const workspace = tempDir();
    const socketPath = path.join(workspace, 'server.sock');
    const port = await freePort();

    const handle = await startServer({
      socketPath,
      port,
      host: '127.0.0.1',
      workspaceDir: workspace,
      settingsFile: path.join(workspace, 'ui-settings.json'),
      quiet: true
    });
    servers.push(handle);

    expect(handle.gatewayUrl).toBe(`ws://127.0.0.1:${port}/ws`);

    const overTcp = await openWebSocket(`ws://127.0.0.1:${port}/ws`);
    expect(overTcp.readyState).toBe(WebSocket.OPEN);
    overTcp.close();

    // `ws` treats `ws+unix:` as an IPC URL and splits the resource off after
    // the colon, so `<path>:<resource>` addresses `/ws` on the socket listener.
    const overSocket = await openWebSocket(`ws+unix://${socketPath}:/ws`);
    expect(overSocket.readyState).toBe(WebSocket.OPEN);
    overSocket.close();
  });

  it('keeps socket-only behavior when the port is omitted', async () => {
    const workspace = tempDir();
    const socketPath = path.join(workspace, 'server.sock');

    const handle = await startServer({
      socketPath,
      workspaceDir: workspace,
      settingsFile: path.join(workspace, 'ui-settings.json'),
      quiet: true,
      gatewayPath: null
    });
    servers.push(handle);

    // Pure socket mode: no TCP port, the socket url is reported.
    expect(handle.port).toBe(0);
    expect(handle.socketPath).toBe(path.resolve(socketPath));
    expect(handle.url).toBe(`http://unix:${path.resolve(socketPath)}`);

    const overSocket = await getOverSocket(socketPath, '/api/status');
    expect(overSocket.status).toBe(200);
  });

  it('keeps socket-only behavior when port is explicitly 0', async () => {
    const workspace = tempDir();
    const socketPath = path.join(workspace, 'server.sock');

    const handle = await startServer({
      socketPath,
      port: 0,
      host: '127.0.0.1',
      workspaceDir: workspace,
      settingsFile: path.join(workspace, 'ui-settings.json'),
      quiet: true,
      gatewayPath: null
    });
    servers.push(handle);

    expect(handle.port).toBe(0);
    expect(handle.socketPath).toBe(path.resolve(socketPath));

    const overSocket = await getOverSocket(socketPath, '/api/status');
    expect(overSocket.status).toBe(200);
  });

  it('removes the socket file on close', async () => {
    const workspace = tempDir();
    const socketPath = path.join(workspace, 'server.sock');
    const port = await freePort();

    const handle = await startServer({
      socketPath,
      port,
      host: '127.0.0.1',
      workspaceDir: workspace,
      settingsFile: path.join(workspace, 'ui-settings.json'),
      quiet: true,
      gatewayPath: null
    });

    expect(fs.existsSync(socketPath)).toBe(true);
    await handle.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});

/**
 * Unit tests for {@link GatewayClient.kick}.
 *
 * `kick()` exists so the desktop shell can force an immediate reconnect when the
 * network comes back, instead of waiting out the exponential backoff. These
 * tests use a real `ws` server so the socket lifecycle is genuine: a dropped
 * connection parks the client in `reconnecting`, and a kick must beat the
 * (500ms) backoff sleep without ever opening a second socket while one is live.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { GatewayClient } from '../src/gateway_client.js';

/** Poll `predicate` until it is true or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startServer(): Promise<{
  wss: WebSocketServer;
  port: number;
  connections: () => number;
}> {
  const wss = new WebSocketServer({ port: 0 });
  let count = 0;
  wss.on('connection', () => {
    count += 1;
  });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { wss, port, connections: () => count };
}

const openClients: GatewayClient[] = [];
const openServers: WebSocketServer[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close();
  await Promise.all(
    openServers.splice(0).map(
      (wss) => new Promise<void>((resolve) => wss.close(() => resolve())),
    ),
  );
});

function makeClient(port: number): GatewayClient {
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    workspaceRoot: mkdtempSync(path.join(os.tmpdir(), 'superiu-gw-')),
    token: 'test-token',
    deviceId: 'test-device',
  });
  openClients.push(client);
  return client;
}

describe('GatewayClient.kick', () => {
  it('reconnects immediately instead of waiting out the backoff', async () => {
    const server = await startServer();
    openServers.push(server.wss);
    const client = makeClient(server.port);

    client.connect();
    await waitFor(() => client.connectionState === 'connected');
    await waitFor(() => server.connections() === 1);

    // Drop the live socket. The client now parks in `reconnecting` with the
    // initial 500ms backoff timer pending.
    for (const socket of server.wss.clients) socket.terminate();
    await waitFor(() => client.connectionState === 'reconnecting');

    const startedAt = Date.now();
    client.kick();
    await waitFor(() => server.connections() === 2);

    // Well under INITIAL_BACKOFF_MS (500ms): the sleep was skipped, not awaited.
    expect(Date.now() - startedAt).toBeLessThan(400);
  });

  it('does not open a second socket while one is live', async () => {
    const server = await startServer();
    openServers.push(server.wss);
    const client = makeClient(server.port);

    client.connect();
    await waitFor(() => client.connectionState === 'connected');
    await waitFor(() => server.connections() === 1);

    client.kick();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(server.connections()).toBe(1);
    expect(client.connectionState).toBe('connected');
  });

  it('is a no-op when the client is not reconnecting', async () => {
    const server = await startServer();
    openServers.push(server.wss);
    const client = makeClient(server.port);

    // Never connected: `shouldReconnect` is false, so kick must not dial out.
    client.kick();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(server.connections()).toBe(0);
    expect(client.connectionState).toBe('idle');
  });
});

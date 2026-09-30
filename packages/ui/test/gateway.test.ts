/**
 * Unit + integration tests for `@agent/ui/gateway`.
 *
 * Three layers are exercised:
 *
 *  - {@link DeviceRegistry}: registration, liveness watchdog, RPC bookkeeping.
 *  - {@link EventHub}: seqId assignment, ring-buffer rollover, fan-out, catch-up.
 *  - {@link GatewayServer}: real WebSocket handshake + outbound RPC round-trip.
 *
 * The `GatewayServer` suite intentionally uses a real `ws` server/client pair
 * over an ephemeral port rather than mocks, so the handshake, auth, framing and
 * RPC correlation are all validated end-to-end.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import type {
  ClientRegisterMessage,
  DeviceIdentity,
  ServerCatchUpResponse,
  StreamEvent
} from '@agent/protocol';
import {
  DEFAULT_BUFFER_SIZE,
  DeviceRegistry,
  EventHub,
  GatewayServer,
  RemoteRpcError,
  RpcTimeoutError,
  TargetDeviceOfflineError,
  type ConnectedClient,
  type PendingRpc
} from '../src/gateway/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A minimal fake WebSocket that records closes without touching the network. */
function fakeSocket(): WebSocket & { closed: Array<{ code?: number; reason?: string }> } {
  const closed: Array<{ code?: number; reason?: string }> = [];
  const ws = {
    readyState: 1,
    closed,
    send: vi.fn(),
    close: vi.fn((code?: number, reason?: string) => {
      closed.push({ code, reason });
    })
  };
  return ws as unknown as WebSocket & { closed: Array<{ code?: number; reason?: string }> };
}

function identity(deviceId: string, overrides: Partial<DeviceIdentity> = {}): DeviceIdentity {
  return {
    deviceId,
    deviceName: `device-${deviceId}`,
    clientType: 'desktop',
    token: 'secret',
    ...overrides
  };
}

function pendingRpc(overrides: Partial<PendingRpc> = {}): PendingRpc {
  return {
    resolve: vi.fn(),
    reject: vi.fn(),
    timer: setTimeout(() => undefined, 60_000),
    ...overrides
  };
}

function chunk(sessionId: string, delta: string): Omit<StreamEvent, 'seqId'> {
  return {
    type: 'agent.chunk',
    sessionId,
    delta,
    timestamp: Date.now()
  } as Omit<StreamEvent, 'seqId'>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `predicate` holds or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('waitFor: condition not met before timeout');
}

function waitForClose(ws: WebSocket, timeoutMs = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
    ws.once('close', (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function waitForMessage(ws: WebSocket, timeoutMs = 5_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no message received')), timeoutMs);
    ws.once('message', (data: Buffer) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

// ---------------------------------------------------------------------------
// DeviceRegistry
// ---------------------------------------------------------------------------

describe('DeviceRegistry', () => {
  const registries: DeviceRegistry[] = [];

  function makeRegistry(options: ConstructorParameters<typeof DeviceRegistry>[0] = {}): DeviceRegistry {
    const registry = new DeviceRegistry(options);
    registries.push(registry);
    return registry;
  }

  afterEach(() => {
    for (const registry of registries.splice(0)) {
      for (const client of registry.getAll()) {
        if (client.heartbeatTimer) clearInterval(client.heartbeatTimer);
      }
    }
  });

  it('registers a device and retrieves it by id', () => {
    const registry = makeRegistry();
    const ws = fakeSocket();
    const client = registry.register(identity('dev-1'), ws);

    expect(client.identity.deviceId).toBe('dev-1');
    expect(registry.get('dev-1')).toBe(client);
    expect(registry.isOnline('dev-1')).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.deviceIds()).toEqual(['dev-1']);
    expect(registry.getAll()).toHaveLength(1);
    expect(client.pendingRpc.size).toBe(0);
    expect(client.lastSeen).toBeLessThanOrEqual(Date.now());
  });

  it('returns undefined for an unknown device', () => {
    const registry = makeRegistry();
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.isOnline('nope')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('replaces a duplicate registration and rejects the stale socket RPCs', async () => {
    const offline = vi.fn();
    const registry = makeRegistry({ onDeviceOffline: offline });
    const firstWs = fakeSocket();

    const first = registry.register(identity('dev-1'), firstWs);
    const pending = pendingRpc({ method: 'fs.readFile' });
    registry.addPendingRpc('dev-1', 'rpc-1', pending);

    const secondWs = fakeSocket();
    const second = registry.register(identity('dev-1'), secondWs);

    // Old entry replaced, not duplicated.
    expect(registry.get('dev-1')).toBe(second);
    expect(registry.size).toBe(1);
    expect(second).not.toBe(first);

    // The stale socket's in-flight RPC is rejected...
    expect(pending.reject).toHaveBeenCalledTimes(1);
    const err = (pending.reject as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeInstanceOf(TargetDeviceOfflineError);
    expect((err as TargetDeviceOfflineError).deviceId).toBe('dev-1');

    // ...but no offline transition fired, because the device is still online.
    expect(offline).not.toHaveBeenCalled();
    expect(first.heartbeatTimer).toBeUndefined();
  });

  it('does not tear down when re-registering the same socket', () => {
    const registry = makeRegistry();
    const ws = fakeSocket();
    const first = registry.register(identity('dev-1'), ws);
    const again = registry.register(identity('dev-1'), ws);
    expect(again).not.toBe(first);
    expect(registry.size).toBe(1);
    // The prior timer is left armed rather than replaced; the entry is the new one.
    expect(registry.get('dev-1')).toBe(again);
  });

  it('unregisters a device idempotently', () => {
    const offline = vi.fn();
    const registry = makeRegistry({ onDeviceOffline: offline });
    registry.register(identity('dev-1'), fakeSocket());

    expect(registry.unregister('dev-1')).toBe(true);
    expect(registry.isOnline('dev-1')).toBe(false);
    // Second call is a no-op and must not re-fire anything.
    expect(registry.unregister('dev-1')).toBe(false);
    expect(offline).not.toHaveBeenCalled();
  });

  it('markOffline removes the device and fires onDeviceOffline exactly once', () => {
    const offline = vi.fn();
    const registry = makeRegistry({ onDeviceOffline: offline });
    const client = registry.register(identity('dev-1'), fakeSocket());
    const pending = pendingRpc({ method: 'bash.execute' });
    registry.addPendingRpc('dev-1', 'rpc-1', pending);

    expect(registry.markOffline('dev-1', 'socket closed')).toBe(true);
    expect(registry.get('dev-1')).toBeUndefined();
    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline).toHaveBeenCalledWith('dev-1');
    expect(pending.reject).toHaveBeenCalledTimes(1);
    expect(client.heartbeatTimer).toBeUndefined();

    // A second markOffline for a gone device is a no-op.
    expect(registry.markOffline('dev-1')).toBe(false);
    expect(offline).toHaveBeenCalledTimes(1);
  });

  it('transitions a silent device to offline via the heartbeat watchdog', async () => {
    const offline = vi.fn();
    const registry = makeRegistry({
      heartbeatIntervalMs: 20,
      offlineTimeoutMs: 40,
      onDeviceOffline: offline
    });
    const ws = fakeSocket();
    registry.register(identity('dev-1'), ws);

    await waitFor(() => !registry.isOnline('dev-1'));

    expect(registry.size).toBe(0);
    expect(offline).toHaveBeenCalledTimes(1);
    expect(offline).toHaveBeenCalledWith('dev-1');
    // The watchdog nudges the peer with a dedicated close code.
    expect(ws.closed.some((c) => c.code === 4000)).toBe(true);
  });

  it('keeps a device online while frames keep arriving', async () => {
    const offline = vi.fn();
    const registry = makeRegistry({
      heartbeatIntervalMs: 20,
      offlineTimeoutMs: 60,
      onDeviceOffline: offline
    });
    registry.register(identity('dev-1'), fakeSocket());

    // Touch well past a couple of watchdog windows.
    for (let i = 0; i < 8; i += 1) {
      await sleep(15);
      registry.touch('dev-1');
    }

    expect(registry.isOnline('dev-1')).toBe(true);
    expect(offline).not.toHaveBeenCalled();
  });

  it('exposes the configured heartbeat / offline constants', () => {
    const registry = makeRegistry({ heartbeatIntervalMs: 7, offlineTimeoutMs: 9 });
    expect(registry.HEARTBEAT_INTERVAL_MS).toBe(7);
    expect(registry.OFFLINE_TIMEOUT_MS).toBe(9);
  });

  it('tracks pending RPCs with take semantics', () => {
    const registry = makeRegistry();
    registry.register(identity('dev-1'), fakeSocket());
    const pending = pendingRpc();
    registry.addPendingRpc('dev-1', 'rpc-1', pending);

    expect(registry.get('dev-1')!.pendingRpc.get('rpc-1')).toBe(pending);
    const taken = registry.takePendingRpc('dev-1', 'rpc-1');
    expect(taken).toBe(pending);
    // Taking twice yields nothing the second time.
    expect(registry.takePendingRpc('dev-1', 'rpc-1')).toBeUndefined();
  });

  it('ignores RPC bookkeeping for an unknown device', () => {
    const registry = makeRegistry();
    expect(() => registry.addPendingRpc('ghost', 'rpc-1', pendingRpc())).not.toThrow();
    expect(registry.takePendingRpc('ghost', 'rpc-1')).toBeUndefined();
  });

  it('clearAll tears every connection down and fires offline for each', () => {
    const offline = vi.fn();
    const registry = makeRegistry({ onDeviceOffline: offline });
    registry.register(identity('dev-1'), fakeSocket());
    registry.register(identity('dev-2'), fakeSocket());

    registry.clearAll();

    expect(registry.size).toBe(0);
    expect(offline.mock.calls.map((c) => c[0]).sort()).toEqual(['dev-1', 'dev-2']);
  });

  it('survives an onDeviceOffline subscriber that throws', () => {
    const registry = makeRegistry({
      onDeviceOffline: () => {
        throw new Error('subscriber blew up');
      }
    });
    registry.register(identity('dev-1'), fakeSocket());
    expect(() => registry.markOffline('dev-1')).not.toThrow();
    expect(registry.isOnline('dev-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EventHub
// ---------------------------------------------------------------------------

describe('EventHub', () => {
  it('assigns monotonically increasing seqIds starting at 1', () => {
    const hub = new EventHub();
    const a = hub.publish(chunk('s1', 'a'));
    const b = hub.publish(chunk('s1', 'b'));
    const c = hub.publish(chunk('s1', 'c'));

    expect([a.seqId, b.seqId, c.seqId]).toEqual([1, 2, 3]);
    expect(hub.nextSeqId('s1')).toBe(4);
  });

  it('scopes seqIds per session', () => {
    const hub = new EventHub();
    expect(hub.publish(chunk('s1', 'a')).seqId).toBe(1);
    expect(hub.publish(chunk('s2', 'a')).seqId).toBe(1);
    expect(hub.publish(chunk('s1', 'b')).seqId).toBe(2);
    expect(hub.nextSeqId('fresh')).toBe(1);
  });

  it('overwrites a producer-supplied seqId with the hub authority', () => {
    const hub = new EventHub();
    const first = hub.publish({ ...chunk('s1', 'a'), seqId: 999 } as never);
    expect(first.seqId).toBe(1);
    // A producer cannot rewind the counter either.
    const second = hub.publish({ ...chunk('s1', 'b'), seqId: 0 } as never);
    expect(second.seqId).toBe(2);
  });

  it('defaults timestamp but preserves an explicit one', () => {
    const hub = new EventHub();
    const auto = hub.publish(chunk('s1', 'a'));
    expect(typeof auto.timestamp).toBe('number');

    const when = 1234567890;
    const fixed = hub.publish({ ...chunk('s1', 'b'), timestamp: when } as never);
    expect(fixed.timestamp).toBe(when);
  });

  it('buffers events up to capacity and rolls over the oldest', () => {
    const hub = new EventHub({ bufferSize: 3 });
    for (let i = 0; i < 5; i += 1) hub.publish(chunk('s1', String(i)));

    const buffered = hub.buffered('s1');
    expect(buffered.map((e) => e.seqId)).toEqual([3, 4, 5]);
    expect((buffered[0] as { delta: string }).delta).toBe('2');

    const snapshot = hub.snapshot('s1')!;
    expect(snapshot.size).toBe(3);
    expect(snapshot.oldestSeqId).toBe(3);
    expect(snapshot.newestSeqId).toBe(5);
    expect(snapshot.nextSeqId).toBe(6);
  });

  it('clamps a nonsensical buffer size to at least 1', () => {
    const hub = new EventHub({ bufferSize: 0 });
    for (let i = 0; i < 3; i += 1) hub.publish(chunk('s1', String(i)));
    expect(hub.buffered('s1')).toHaveLength(1);
    expect(hub.buffered('s1')[0].seqId).toBe(3);
  });

  it('uses the documented default buffer size', () => {
    expect(DEFAULT_BUFFER_SIZE).toBe(1000);
    const hub = new EventHub();
    for (let i = 0; i < DEFAULT_BUFFER_SIZE + 5; i += 1) hub.publish(chunk('s1', 'x'));
    const snapshot = hub.snapshot('s1')!;
    expect(snapshot.size).toBe(DEFAULT_BUFFER_SIZE);
    expect(snapshot.oldestSeqId).toBe(6);
  });

  it('broadcasts only to subscribed clients that are passed in', () => {
    const hub = new EventHub();
    hub.subscribe('s1', 'dev-a');
    hub.subscribe('s1', 'dev-b');

    const a = { identity: identity('dev-a'), ws: fakeSocket() } as ConnectedClient;
    const b = { identity: identity('dev-b'), ws: fakeSocket() } as ConnectedClient;
    const c = { identity: identity('dev-c'), ws: fakeSocket() } as ConnectedClient;

    const sinkCalls: Array<{ deviceId: string; seqId: number }> = [];
    const sink = (client: ConnectedClient, event: StreamEvent) => {
      sinkCalls.push({ deviceId: client.identity.deviceId, seqId: event.seqId });
    };

    hub.publish(chunk('s1', 'hello'), [a, b, c], sink);

    expect(sinkCalls).toEqual([
      { deviceId: 'dev-a', seqId: 1 },
      { deviceId: 'dev-b', seqId: 1 }
    ]);
  });

  it('does not deliver to a client that is not subscribed to the session', () => {
    const hub = new EventHub();
    hub.subscribe('s1', 'dev-a');
    const a = { identity: identity('dev-a'), ws: fakeSocket() } as ConnectedClient;
    const sink = vi.fn();
    hub.publish(chunk('s2', 'other-session'), [a], sink);
    expect(sink).not.toHaveBeenCalled();
  });

  it('default sink JSON-encodes onto the socket when open', () => {
    const hub = new EventHub();
    hub.subscribe('s1', 'dev-a');
    const ws = fakeSocket();
    const client = { identity: identity('dev-a'), ws } as ConnectedClient;

    hub.publish(chunk('s1', 'payload'), [client]); // no sink -> default

    expect(ws.send).toHaveBeenCalledTimes(1);
    const frame = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(frame).toMatchObject({ type: 'agent.chunk', delta: 'payload', seqId: 1 });
  });

  it('default sink ignores a socket that is not open', () => {
    const hub = new EventHub();
    hub.subscribe('s1', 'dev-a');
    const ws = fakeSocket();
    (ws as unknown as { readyState: number }).readyState = 3; // CLOSED
    const client = { identity: identity('dev-a'), ws } as ConnectedClient;

    hub.publish(chunk('s1', 'payload'), [client]);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('replays only events after a given seqId (catch-up)', () => {
    const hub = new EventHub();
    for (let i = 0; i < 5; i += 1) hub.publish(chunk('s1', String(i)));

    expect(hub.eventsSince('s1', 0).map((e) => e.seqId)).toEqual([1, 2, 3, 4, 5]);
    expect(hub.eventsSince('s1', 3).map((e) => e.seqId)).toEqual([4, 5]);
    expect(hub.eventsSince('s1', 5)).toEqual([]);
    expect(hub.eventsSince('unknown', 0)).toEqual([]);
  });

  it('handleCatchUp answers a client catch-up request', () => {
    const hub = new EventHub();
    hub.publish(chunk('s1', 'a'));
    hub.publish(chunk('s1', 'b'));

    const response: ServerCatchUpResponse = hub.handleCatchUp({
      type: 'client.catch_up',
      sessionId: 's1',
      fromSeqId: 1
    });
    expect(response.type).toBe('server.catch_up');
    expect(response.sessionId).toBe('s1');
    expect(response.events.map((e) => e.seqId)).toEqual([2]);
  });

  it('replay after rollover yields only retained events (gap is the caller’s concern)', () => {
    const hub = new EventHub({ bufferSize: 2 });
    for (let i = 0; i < 5; i += 1) hub.publish(chunk('s1', String(i)));
    const replayed = hub.eventsSince('s1', 0);
    expect(replayed.map((e) => e.seqId)).toEqual([4, 5]);
    // Caller can detect the gap by comparing its own fromSeqId to the first event.
    expect(replayed[0].seqId).toBeGreaterThan(0 + 1);
  });

  it('manages subscriptions idempotently', () => {
    const hub = new EventHub();
    hub.subscribe('s1', 'dev-a');
    hub.subscribe('s1', 'dev-a'); // idempotent
    expect([...hub.subscribersFor('s1')]).toEqual(['dev-a']);
    expect(hub.sessionsFor('dev-a')).toEqual(['s1']);

    hub.unsubscribe('s1', 'dev-a');
    expect(hub.subscribersFor('s1').size).toBe(0);
    expect(hub.sessionsFor('dev-a')).toEqual([]);
  });

  it('unsubscribeAll drops every subscription for a device', () => {
    const hub = new EventHub();
    hub.subscribe('s1', 'dev-a');
    hub.subscribe('s2', 'dev-a');
    hub.subscribe('s1', 'dev-b');

    hub.unsubscribeAll('dev-a');

    expect(hub.sessionsFor('dev-a')).toEqual([]);
    expect(hub.subscribersFor('s1')).toEqual(new Set(['dev-b']));
    expect(hub.subscribersFor('s2').size).toBe(0);
  });

  it('drop forgets a session buffer and its subscriptions', () => {
    const hub = new EventHub();
    hub.subscribe('s1', 'dev-a');
    hub.publish(chunk('s1', 'a'));

    hub.drop('s1');

    expect(hub.snapshot('s1')).toBeUndefined();
    expect(hub.buffered('s1')).toEqual([]);
    expect(hub.subscribersFor('s1').size).toBe(0);
  });

  it('clear forgets every session buffer', () => {
    const hub = new EventHub();
    hub.publish(chunk('s1', 'a'));
    hub.publish(chunk('s2', 'a'));
    hub.clear();
    expect(hub.snapshot('s1')).toBeUndefined();
    expect(hub.snapshot('s2')).toBeUndefined();
  });

  it('dispatch re-sends an already-stamped event without consuming a seqId', () => {
    const hub = new EventHub();
    hub.subscribe('s1', 'dev-a');
    const stamped = hub.publish(chunk('s1', 'a'));
    const client = { identity: identity('dev-a'), ws: fakeSocket() } as ConnectedClient;
    const sink = vi.fn();

    hub.dispatch(stamped, [client], sink);

    expect(sink).toHaveBeenCalledWith(client, stamped);
    expect(hub.nextSeqId('s1')).toBe(2); // unchanged
  });
});

// ---------------------------------------------------------------------------
// GatewayServer (integration over real WebSockets)
// ---------------------------------------------------------------------------

describe('GatewayServer', () => {
  const servers: GatewayServer[] = [];
  const sockets: WebSocket[] = [];

  async function makeServer(options: ConstructorParameters<typeof GatewayServer>[0] = {}): Promise<{
    server: GatewayServer;
    port: number;
    url: string;
  }> {
    const server = new GatewayServer({ heartbeatIntervalMs: 50, offlineTimeoutMs: 150, ...options });
    const port = await server.listen(0);
    servers.push(server);
    return { server, port, url: `ws://127.0.0.1:${port}/ws` };
  }

  function connect(url: string): WebSocket {
    const ws = new WebSocket(url);
    sockets.push(ws);
    return ws;
  }

  async function open(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
  }

  async function register(
    ws: WebSocket,
    body: Partial<ClientRegisterMessage> & { deviceId: string }
  ): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    await open(ws);
    const ack = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'client.register',
        deviceId: body.deviceId,
        deviceName: body.deviceName ?? body.deviceId,
        clientType: body.clientType ?? 'desktop',
        token: body.token ?? ''
      })
    );
    return (await ack) as { ok: boolean; sessionId?: string; error?: string };
  }

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it('accepts a registration whose token matches', async () => {
    const { server, url } = await makeServer({ token: 'shibboleth' });
    const ws = connect(url);
    const ack = await register(ws, { deviceId: 'dev-1', token: 'shibboleth' });

    expect(ack.ok).toBe(true);
    expect(ack.error).toBeUndefined();
    expect(server.registry.isOnline('dev-1')).toBe(true);
    expect(server.registry.get('dev-1')!.identity.deviceName).toBe('dev-1');
    expect(server.registry.get('dev-1')!.identity.clientType).toBe('desktop');
  });

  it('rejects a registration with the wrong token and closes the socket', async () => {
    const { server, url } = await makeServer({ token: 'shibboleth' });
    const ws = connect(url);
    const ack = await register(ws, { deviceId: 'dev-1', token: 'wrong' });

    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/token/i);
    expect(server.registry.isOnline('dev-1')).toBe(false);
    await expect(waitForClose(ws)).resolves.toBe(4003);
  });

  it('accepts any token in open (anonymous) mode', async () => {
    const { server, url } = await makeServer({ allowAnonymous: true });
    const ws = connect(url);
    const ack = await register(ws, { deviceId: 'dev-1', token: 'anything' });
    expect(ack.ok).toBe(true);
    expect(server.registry.isOnline('dev-1')).toBe(true);
  });

  it('closes the connection when the first frame is not a register message', async () => {
    const { url } = await makeServer({ allowAnonymous: true });
    const ws = connect(url);
    await open(ws);
    const ack = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'client.prompt', sessionId: 's', prompt: 'hi' }));

    const reply = (await ack) as { type: string; ok: boolean; error?: string };
    expect(reply.type).toBe('server.register.ack');
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/client\.register/i);
    await expect(waitForClose(ws)).resolves.toBe(4001);
  });

  it('round-trips an outbound callClientRpc over real ws', async () => {
    const { server, url } = await makeServer({ allowAnonymous: true });
    const ws = connect(url);
    await register(ws, { deviceId: 'dev-1' });

    // The device answers fs.readFile with a canned result.
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString());
      if (frame.jsonrpc === '2.0' && frame.method === 'fs.readFile') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { content: 'file-body' } }));
      }
    });

    const result = await server.callClientRpc('dev-1', 'fs.readFile', { path: 'a.txt' });
    expect(result).toEqual({ content: 'file-body' });
  });

  it('rejects callClientRpc for an unknown device', async () => {
    const { server } = await makeServer({ allowAnonymous: true });
    await expect(server.callClientRpc('ghost', 'fs.readFile', { path: 'x' })).rejects.toBeInstanceOf(
      TargetDeviceOfflineError
    );
  });

  it('surfaces a JSON-RPC error object as RemoteRpcError', async () => {
    const { server, url } = await makeServer({ allowAnonymous: true });
    const ws = connect(url);
    await register(ws, { deviceId: 'dev-1' });

    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString());
      if (frame.jsonrpc === '2.0' && frame.method === 'bash.execute') {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32000, message: 'nope', data: { detail: 1 } }
          })
        );
      }
    });

    await expect(server.callClientRpc('dev-1', 'bash.execute', { command: 'ls' })).rejects.toMatchObject({
      name: 'RemoteRpcError',
      code: -32000,
      message: 'nope'
    });
  });

  it('rejects an in-flight RPC when the client goes offline mid-call', async () => {
    const { server, url } = await makeServer({ allowAnonymous: true });
    const ws = connect(url);
    await register(ws, { deviceId: 'dev-1' });

    // Never answer: instead drop the socket once the request lands.
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString());
      if (frame.jsonrpc === '2.0' && frame.method === 'fs.readFile') {
        ws.close();
      }
    });

    const promise = server.callClientRpc('dev-1', 'fs.readFile', { path: 'a.txt' });
    await expect(promise).rejects.toBeInstanceOf(TargetDeviceOfflineError);
    expect(server.registry.isOnline('dev-1')).toBe(false);
  });

  it('times out an RPC the client never answers', async () => {
    const { server, url } = await makeServer({ allowAnonymous: true, rpcTimeoutMs: 60 });
    const ws = connect(url);
    await register(ws, { deviceId: 'dev-1' });

    const promise = server.callClientRpc('dev-1', 'fs.readFile', { path: 'a.txt' });
    await expect(promise).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(
      server.callClientRpc('dev-1', 'fs.readFile', { path: 'a.txt' }, 60)
    ).rejects.toMatchObject({ name: 'RpcTimeoutError', timeoutMs: 60 });
  });

  it('goes offline when a registered socket disconnects', async () => {
    const { server, url } = await makeServer({ allowAnonymous: true });
    const ws = connect(url);
    await register(ws, { deviceId: 'dev-1' });
    expect(server.registry.isOnline('dev-1')).toBe(true);

    ws.close();
    await waitFor(() => !server.registry.isOnline('dev-1'));
    expect(server.registry.get('dev-1')).toBeUndefined();
  });

  it('answers a catch-up request with buffered events and subscribes the device', async () => {
    const { server, url } = await makeServer({ allowAnonymous: true });
    const ws = connect(url);
    await register(ws, { deviceId: 'dev-1' });

    // Seed the hub as though earlier events occurred while offline.
    server.emitEvent(chunk('s1', 'one') as never);
    server.emitEvent(chunk('s1', 'two') as never);

    const response = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'client.catch_up', sessionId: 's1', fromSeqId: 0 }));

    const reply = (await response) as ServerCatchUpResponse;
    expect(reply.type).toBe('server.catch_up');
    expect(reply.events.map((e) => e.seqId)).toEqual([1, 2]);
    expect(server.hub.subscribersFor('s1').has('dev-1')).toBe(true);
  });

  it('replaces a lingering connection when the same deviceId reconnects', async () => {
    const { server, url } = await makeServer({ allowAnonymous: true });
    const first = connect(url);
    await register(first, { deviceId: 'dev-1' });

    const firstClient = server.registry.get('dev-1')!;
    const second = connect(url);
    await register(second, { deviceId: 'dev-1' });

    const secondClient = server.registry.get('dev-1')!;
    expect(secondClient).not.toBe(firstClient);
    expect(server.registry.size).toBe(1);
    expect(server.registry.get('dev-1')!.ws).not.toBe(firstClient.ws);
  });
});

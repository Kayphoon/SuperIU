import { describe, expect, it, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GATEWAY_PROTOCOL_VERSION,
  isProtocolCompatible,
  parseMajorVersion,
  type ServerRegisterAckMessage,
} from '@agent/protocol';
import { GatewayClient } from '../src/gateway_client.js';
import { RemoteBootstrapper, type RemoteRunner } from '../src/remote/bootstrap.js';
import { RemoteConnectionManager } from '../src/remote/manager.js';

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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startMockGatewayServer(onClientRegister?: (ws: any, message: any) => void): Promise<{
  wss: WebSocketServer;
  port: number;
}> {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'client.register') {
          if (onClientRegister) {
            onClientRegister(ws, msg);
          } else {
            const ack: ServerRegisterAckMessage = {
              type: 'server.register.ack',
              ok: true,
              sessionId: 'test-session',
              serverVersion: '0.2.79',
              protocolVersion: GATEWAY_PROTOCOL_VERSION,
            };
            ws.send(JSON.stringify(ack));
          }
        }
      } catch {
        void 0;
      }
    });
  });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  openServers.push(wss);
  return { wss, port };
}

function makeClient(port: number): GatewayClient {
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    workspaceRoot: mkdtempSync(path.join(os.tmpdir(), 'superiu-compat-')),
    token: 'test-token',
    deviceId: 'test-device',
  });
  openClients.push(client);
  return client;
}

describe('Protocol version compatibility predicate', () => {
  it('parses major version integers correctly', () => {
    expect(parseMajorVersion('1.0.0')).toBe(1);
    expect(parseMajorVersion('v2.3.4')).toBe(2);
    expect(parseMajorVersion('10.0.1-beta.1')).toBe(10);
    expect(parseMajorVersion('')).toBeNull();
    expect(parseMajorVersion(undefined)).toBeNull();
  });

  it('declares identical or same-major protocol versions compatible', () => {
    expect(isProtocolCompatible('1.0.0', '1.0.0')).toBe(true);
    expect(isProtocolCompatible('1.0.0', '1.5.2')).toBe(true);
    expect(isProtocolCompatible('v1.2.0', '1.0.0')).toBe(true);
  });

  it('declares different major protocol versions incompatible', () => {
    expect(isProtocolCompatible('1.0.0', '2.0.0')).toBe(false);
    expect(isProtocolCompatible('2.1.0', '1.0.0')).toBe(false);
    expect(isProtocolCompatible('v2', 'v1')).toBe(false);
  });

  it('treats missing version as backwards-compatible fallback', () => {
    expect(isProtocolCompatible(undefined, '1.0.0')).toBe(true);
    expect(isProtocolCompatible('1.0.0', undefined)).toBe(true);
    expect(isProtocolCompatible(undefined, undefined)).toBe(true);
  });
});

describe('GatewayClient protocol negotiation', () => {
  it('connects successfully and records versions when protocol matches', async () => {
    const server = await startMockGatewayServer();
    const client = makeClient(server.port);

    client.connect();
    await waitFor(() => client.connectionState === 'connected');
    await waitFor(() => client.sessionId === 'test-session');

    expect(client.remoteServerVersion).toBe('0.2.79');
    expect(client.remoteProtocolVersion).toBe(GATEWAY_PROTOCOL_VERSION);
    expect(client.isProtocolIncompatible).toBe(false);
  });

  it('gracefully accepts legacy server ack without protocolVersion', async () => {
    const server = await startMockGatewayServer((ws) => {
      const ack: ServerRegisterAckMessage = {
        type: 'server.register.ack',
        ok: true,
        sessionId: 'legacy-session',
        serverVersion: '0.2.50',
      };
      ws.send(JSON.stringify(ack));
    });
    const client = makeClient(server.port);

    client.connect();
    await waitFor(() => client.sessionId === 'legacy-session');

    expect(client.remoteServerVersion).toBe('0.2.50');
    expect(client.remoteProtocolVersion).toBeUndefined();
    expect(client.isProtocolIncompatible).toBe(false);
  });

  it('rejects connection and stops reconnecting on major protocol mismatch', async () => {
    const server = await startMockGatewayServer((ws) => {
      const ack: ServerRegisterAckMessage = {
        type: 'server.register.ack',
        ok: true,
        sessionId: 'future-session',
        serverVersion: '1.0.0',
        protocolVersion: '2.0.0',
      };
      ws.send(JSON.stringify(ack));
    });
    const client = makeClient(server.port);

    client.connect();
    await waitFor(() => client.isProtocolIncompatible === true);
    await waitFor(() => client.connectionState === 'closed');

    expect(client.remoteProtocolVersion).toBe('2.0.0');
    expect(client.isProtocolIncompatible).toBe(true);
  });
});

describe('RemoteConnectionManager.versionStatus', () => {
  function makeManagerWithProbe(probeVersion: string, installFails = false): {
    manager: RemoteConnectionManager;
    probeVersion: string;
  } {
    const runner: RemoteRunner = async (_alias, cmd) => {
      if (cmd.includes('printf "OS=')) {
        return {
          stdout: `OS=Linux\nARCH=x86_64\nHOME=/home/u\nINSTALLED=1\nVERSION={"version":"${probeVersion}"}\nRUNNING=1\nSOCKET_SUPPORT=1\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('curl') || cmd.includes('wget')) {
        if (installFails) {
          return { stdout: '', stderr: 'HTTP 404 Not Found', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('status --workspace')) {
        return {
          stdout: `{"running":true,"port":7345,"version":"${probeVersion}"}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    const bootstrapper = new RemoteBootstrapper(runner);
    const fakeTunnel = {
      open: async () => ({ localPort: 52000 }),
      close: async () => {},
      kick: () => {},
      tunnelState: 'connected' as const,
      on: () => fakeTunnel,
    };

    const manager = new RemoteConnectionManager({
      bootstrapper,
      tunnel: fakeTunnel as any,
      gatewayClientFactory: () => ({
        connect: () => {},
        close: () => {},
        connectionState: 'connected',
      } as any),
      probeReadyz: async () => {},
    });

    return { manager, probeVersion };
  }

  it('reports synced when versions match', async () => {
    const { manager } = makeManagerWithProbe('0.2.79');
    await manager.connect({
      alias: 'test-vps',
      workspace: '/w',
      daemonTargetVersion: '0.2.79',
    });

    expect(manager.versionStatus).toEqual({
      desktopVersion: '0.2.79',
      remoteVersion: '0.2.79',
      state: 'synced',
    });
  });

  it('reports remote_ahead when remote daemon version is newer than desktop', async () => {
    const { manager } = makeManagerWithProbe('0.2.85');
    await manager.connect({
      alias: 'test-vps',
      workspace: '/w',
      daemonTargetVersion: '0.2.79',
    });

    expect(manager.versionStatus).toEqual({
      desktopVersion: '0.2.79',
      remoteVersion: '0.2.85',
      state: 'remote_ahead',
    });
  });

  it('reports upgrade_failed when opportunistic install fails', async () => {
    const { manager } = makeManagerWithProbe('0.2.70', true);
    await manager.connect({
      alias: 'test-vps',
      workspace: '/w',
      daemonTargetVersion: '0.2.79',
    });

    expect(manager.versionStatus?.state).toBe('upgrade_failed');
    expect(manager.versionStatus?.desktopVersion).toBe('0.2.79');
    expect(manager.versionStatus?.remoteVersion).toBe('0.2.70');
    expect(manager.versionStatus?.upgradeError).toBeDefined();
  });
});

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { isPortFree, pickFreePort, SshTunnelManager } from '../src/remote/tunnel.js';

/**
 * Build an injectable `spawn` that stands up a real TCP listener on the local
 * port encoded in the ssh `-L` argument, so the manager's readiness probe
 * succeeds without a real ssh binary. Each fake child is an EventEmitter a test
 * can drive to simulate the ssh process dying.
 */
function makeSpawnHarness(): {
  spawnFn: typeof spawn;
  children: Array<EventEmitter & { stderr: EventEmitter; kill: () => boolean }>;
  servers: net.Server[];
  spawnCount: () => number;
} {
  const children: Array<EventEmitter & { stderr: EventEmitter; kill: () => boolean }> = [];
  const servers: net.Server[] = [];
  let count = 0;

  const spawnFn = ((_cmd: string, args: string[]) => {
    count += 1;
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: () => boolean;
    };
    child.stderr = new EventEmitter();
    child.kill = () => {
      // Mirror a real child: a kill eventually emits `exit`.
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    };
    children.push(child);

    const li = args.indexOf('-L');
    const localPort = Number((li >= 0 ? args[li + 1] : '').split(':')[0]);
    const server = net.createServer();
    // A restart re-spawns before the previous listener is torn down, so a bind
    // failure here is expected and harmless (the probe still reaches the old one).
    server.on('error', () => {});
    servers.push(server);
    server.listen(localPort, '127.0.0.1');
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;

  return { spawnFn, children, servers, spawnCount: () => count };
}

describe('tunnel', () => {
  it('isPortFree rejects invalid ports including 0', async () => {
    expect(await isPortFree(0)).toBe(false);
    expect(await isPortFree(-1)).toBe(false);
    expect(await isPortFree(65536)).toBe(false);
    expect(await isPortFree(NaN)).toBe(false);
  });

  it('pickFreePort allocates a valid non-zero port', async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});

describe('SshTunnelManager.kick', () => {
  async function openTunnel(): Promise<{
    tunnel: SshTunnelManager;
    h: ReturnType<typeof makeSpawnHarness>;
  }> {
    const h = makeSpawnHarness();
    const tunnel = new SshTunnelManager({
      spawnFn: h.spawnFn,
      readinessPollIntervalMs: 5,
      readinessTimeoutMs: 500,
    });
    await tunnel.open({ alias: 'host', localPort: 0, remotePort: 1234 });
    return { tunnel, h };
  }

  function cleanup(h: ReturnType<typeof makeSpawnHarness>): void {
    for (const server of h.servers) {
      try {
        server.close();
      } catch {
        /* not listening */
      }
    }
  }

  it('clears the pending restart timer and relaunches immediately', async () => {
    const { tunnel, h } = await openTunnel();
    expect(tunnel.tunnelState).toBe('connected');
    expect(h.spawnCount()).toBe(1);

    // Kill the ssh process: the manager parks in `reconnecting` with a backoff
    // timer pending (INITIAL_BACKOFF_MS = 500), and no relaunch has happened yet.
    h.children[h.children.length - 1].emit('exit', 1, null);
    expect(tunnel.tunnelState).toBe('reconnecting');
    expect(h.spawnCount()).toBe(1);

    // kick() must cancel that sleep and launch a new ssh process synchronously.
    tunnel.kick();
    expect(h.spawnCount()).toBe(2);
    await vi.waitFor(() => expect(tunnel.tunnelState).toBe('connected'));

    await tunnel.close();
    cleanup(h);
  });

  it('is a no-op while the tunnel is connected', async () => {
    const { tunnel, h } = await openTunnel();
    const before = h.spawnCount();

    tunnel.kick();

    expect(h.spawnCount()).toBe(before);
    expect(tunnel.tunnelState).toBe('connected');

    await tunnel.close();
    cleanup(h);
  });

  it('is a no-op before open and after close', async () => {
    const h = makeSpawnHarness();
    const tunnel = new SshTunnelManager({
      spawnFn: h.spawnFn,
      readinessPollIntervalMs: 5,
      readinessTimeoutMs: 500,
    });

    tunnel.kick();
    expect(h.spawnCount()).toBe(0);

    await tunnel.open({ alias: 'host', localPort: 0, remotePort: 1234 });
    await tunnel.close();
    const afterClose = h.spawnCount();
    tunnel.kick();
    expect(h.spawnCount()).toBe(afterClose);

    cleanup(h);
  });
});

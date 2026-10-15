/**
 * Unit tests for {@link RemoteConnectionManager}'s transport-health surface:
 * `wake()` (fast-awaken) and the `onTransportState` forwarding that lets the
 * desktop shell push a fresh banner the instant the ssh forward changes state.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { RemoteConnectionManager } from '../src/remote/manager.js';
import type { SshTunnelState } from '../src/remote/tunnel.js';

/** A minimal tunnel stub: an EventEmitter (so `on('state')` works) with `kick`. */
function makeTunnelStub(): {
  tunnel: EventEmitter & { kick: ReturnType<typeof vi.fn>; open: () => Promise<{ localPort: number }>; close: () => Promise<void>; tunnelState: SshTunnelState };
  kick: ReturnType<typeof vi.fn>;
} {
  const kick = vi.fn();
  const tunnel = new EventEmitter() as EventEmitter & {
    kick: ReturnType<typeof vi.fn>;
    open: () => Promise<{ localPort: number }>;
    close: () => Promise<void>;
    tunnelState: SshTunnelState;
  };
  tunnel.kick = kick;
  tunnel.tunnelState = 'reconnecting';
  tunnel.open = async () => ({ localPort: 51234 });
  tunnel.close = async () => {};
  return { tunnel, kick };
}

describe('RemoteConnectionManager.wake', () => {
  it('kicks both the tunnel and the gateway client', () => {
    const { tunnel, kick: tunnelKick } = makeTunnelStub();
    const clientKick = vi.fn();
    const manager = new RemoteConnectionManager({ tunnel: tunnel as never });
    // The client is created during connect(); inject one directly to isolate wake().
    (manager as unknown as { client: { kick: () => void } }).client = { kick: clientKick };

    manager.wake();

    expect(tunnelKick).toHaveBeenCalledTimes(1);
    expect(clientKick).toHaveBeenCalledTimes(1);
  });

  it('kicks only the tunnel when no client exists yet', () => {
    const { tunnel, kick: tunnelKick } = makeTunnelStub();
    const manager = new RemoteConnectionManager({ tunnel: tunnel as never });

    expect(() => manager.wake()).not.toThrow();

    expect(tunnelKick).toHaveBeenCalledTimes(1);
  });
});

describe('RemoteConnectionManager.onTransportState', () => {
  it('forwards tunnel state events to the callback', () => {
    const { tunnel } = makeTunnelStub();
    const states: SshTunnelState[] = [];
    new RemoteConnectionManager({
      tunnel: tunnel as never,
      onTransportState: (state) => states.push(state),
    });

    tunnel.emit('state', 'reconnecting');
    tunnel.emit('state', 'connected');

    expect(states).toEqual(['reconnecting', 'connected']);
  });
});

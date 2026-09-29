/**
 * Connected-client registry for the VPS Gateway.
 *
 * {@link DeviceRegistry} is the gateway's single source of truth for "which
 * clients are connected right now". It owns:
 *
 * - the `deviceId -> connection` map,
 * - liveness bookkeeping driven by ping/pong heartbeats, and
 * - the in-flight RPC bookkeeping that lets a response frame resolve the
 *   promise its request frame is awaiting.
 *
 * A device is considered offline once no `pong` has been observed for
 * {@link DeviceRegistry.OFFLINE_TIMEOUT_MS} (15s, as agreed in the interview).
 * Going offline is terminal for that connection: every pending RPC is rejected
 * with {@link TargetDeviceOfflineError} and the `onDeviceOffline` callback
 * fires exactly once.
 */

import type { WebSocket } from 'ws';
import type { DeviceIdentity } from '@agent/protocol';
import { TargetDeviceOfflineError } from './errors.js';

/** How long an RPC response may take before its promise rejects. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** No pong within this window marks the device offline. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const OFFLINE_TIMEOUT_MS = 15_000;

/** A pending client RPC awaiting its JSON-RPC response. */
export interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** RPC method, retained purely for diagnostics on timeout / disconnect. */
  method?: string;
}

/** A live client connection plus its liveness and RPC state. */
export interface ConnectedClient {
  ws: WebSocket;
  identity: DeviceIdentity;
  /** Unix ms of the last inbound frame (any frame counts as liveness). */
  lastSeen: number;
  /** Timer for the 15s offline watchdog. */
  heartbeatTimer?: NodeJS.Timeout;
  /** In-flight RPCs keyed by JSON-RPC request id. */
  pendingRpc: Map<string, PendingRpc>;
}

export interface DeviceRegistryOptions {
  /** Overrides {@link HEARTBEAT_INTERVAL_MS}; primarily for tests. */
  heartbeatIntervalMs?: number;
  /** Overrides {@link OFFLINE_TIMEOUT_MS}; primarily for tests. */
  offlineTimeoutMs?: number;
  /** Invoked once per device that transitions to offline. */
  onDeviceOffline?: (deviceId: string) => void;
}

export class DeviceRegistry {
  /** Public so tests and the gateway can read the constants without imports. */
  readonly HEARTBEAT_INTERVAL_MS: number;
  readonly OFFLINE_TIMEOUT_MS: number;
  static readonly DEFAULT_RPC_TIMEOUT_MS = DEFAULT_RPC_TIMEOUT_MS;

  private readonly clients = new Map<string, ConnectedClient>();
  private readonly heartbeatMs: number;
  private readonly offlineMs: number;
  private readonly onDeviceOffline?: (deviceId: string) => void;

  constructor(options: DeviceRegistryOptions = {}) {
    this.heartbeatMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.offlineMs = options.offlineTimeoutMs ?? OFFLINE_TIMEOUT_MS;
    this.HEARTBEAT_INTERVAL_MS = this.heartbeatMs;
    this.OFFLINE_TIMEOUT_MS = this.offlineMs;
    this.onDeviceOffline = options.onDeviceOffline;
  }

  /**
   * Record a freshly-registered connection.
   *
   * A device that reconnects while its previous socket lingers (a half-open TCP
   * connection the server has not noticed yet) must not leave two entries: the
   * old one is torn down first, which also rejects any RPC the old socket still
   * owed. The replacement then installs its own offline watchdog.
   */
  register(identity: DeviceIdentity, ws: WebSocket): ConnectedClient {
    const existing = this.clients.get(identity.deviceId);
    if (existing && existing.ws !== ws) {
      // Tear down the stale connection WITHOUT firing `onDeviceOffline`: this
      // device is not going offline, it is being replaced. Rejecting its pending
      // RPCs is correct — that socket can no longer answer.
      this.rejectPending(existing, 'Connection replaced by a newer registration.');
      this.clearTimer(existing);
      this.clients.delete(identity.deviceId);
    }

    const client: ConnectedClient = {
      ws,
      identity,
      lastSeen: Date.now(),
      pendingRpc: new Map()
    };
    this.armWatchdog(client);
    this.clients.set(identity.deviceId, client);
    return client;
  }

  /**
   * Remove a device and reject everything it still owed.
   *
   * Idempotent: an already-removed device returns `false` and does NOT re-fire
   * `onDeviceOffline`. This matters because a close event and the watchdog can
   * race — only the first caller should observe the transition.
   */
  unregister(deviceId: string): boolean {
    const client = this.clients.get(deviceId);
    if (!client) return false;

    this.clearTimer(client);
    this.clients.delete(deviceId);
    this.rejectPending(client, undefined);
    return true;
  }

  /** The live entry for a device, or `undefined` when it is not connected. */
  get(deviceId: string): ConnectedClient | undefined {
    return this.clients.get(deviceId);
  }

  /** Snapshot of every live connection. */
  getAll(): ConnectedClient[] {
    return [...this.clients.values()];
  }

  /** Every connected `deviceId`. */
  deviceIds(): string[] {
    return [...this.clients.keys()];
  }

  /** Whether a device currently has a live connection. */
  isOnline(deviceId: string): boolean {
    return this.clients.has(deviceId);
  }

  /** Number of live connections. */
  get size(): number {
    return this.clients.size;
  }

  /**
   * Record inbound activity for a device.
   *
   * Any frame counts as a liveness signal, not just `pong`: a device streaming
   * tool results is plainly alive even if its pong was delayed. `pong` is still
   * sent by the peer and simply also lands here.
   */
  touch(deviceId: string): void {
    const client = this.clients.get(deviceId);
    if (client) client.lastSeen = Date.now();
  }

  /**
   * Promote a device to offline from OUTSIDE the registry (the gateway calls
   * this when a socket errors or closes). Fires `onDeviceOffline` once, as long
   * as the entry is still present.
   */
  markOffline(deviceId: string, reason?: string): boolean {
    const client = this.clients.get(deviceId);
    if (!client) return false;

    this.clearTimer(client);
    this.clients.delete(deviceId);
    this.rejectPending(client, reason);
    this.fireOffline(deviceId);
    return true;
  }

  /** Store a pending RPC promise, replacing any entry with the same id. */
  addPendingRpc(deviceId: string, id: string, pending: PendingRpc): void {
    const client = this.clients.get(deviceId);
    if (!client) return;
    const prior = client.pendingRpc.get(id);
    if (prior) clearTimeout(prior.timer);
    client.pendingRpc.set(id, pending);
  }

  /** Remove and return a pending RPC, cleared by the response frame. */
  takePendingRpc(deviceId: string, id: string): PendingRpc | undefined {
    const client = this.clients.get(deviceId);
    if (!client) return undefined;
    const pending = client.pendingRpc.get(id);
    if (!pending) return undefined;
    client.pendingRpc.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  /** Tear every connection down; used when the gateway itself shuts down. */
  clearAll(): void {
    for (const deviceId of this.deviceIds()) {
      this.markOffline(deviceId, 'Gateway shutting down.');
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private armWatchdog(client: ConnectedClient): void {
    client.heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - client.lastSeen;
      if (elapsed < this.offlineMs) return;
      // No pong (nor any other frame) for the full window: the device is gone.
      const deviceId = client.identity.deviceId;
      const removed = this.clients.get(deviceId) === client && this.unregister(deviceId);
      if (removed) this.fireOffline(deviceId);
      // Best effort: nudge the peer, then close the half-open socket. `ws` may
      // already have given up here; failures are irrelevant, the entry is gone.
      try {
        client.ws.close(4000, 'heartbeat timeout');
      } catch {
        /* already closed */
      }
    }, this.heartbeatMs);
    client.heartbeatTimer.unref?.();
  }

  private clearTimer(client: ConnectedClient): void {
    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
      client.heartbeatTimer = undefined;
    }
  }

  /**
   * Reject every in-flight RPC for a client.
   *
   * Called on disconnect and on replacement. `reason` is only used when the
   * caller can offer a more specific sentence than the generic offline error.
   */
  private rejectPending(client: ConnectedClient, reason?: string): void {
    for (const [, pending] of client.pendingRpc) {
      clearTimeout(pending.timer);
      pending.reject(
        new TargetDeviceOfflineError(
          client.identity.deviceId,
          pending.method,
          reason
        )
      );
    }
    client.pendingRpc.clear();
  }

  private fireOffline(deviceId: string): void {
    try {
      this.onDeviceOffline?.(deviceId);
    } catch {
      // A subscriber throwing must not break registry bookkeeping.
    }
  }
}

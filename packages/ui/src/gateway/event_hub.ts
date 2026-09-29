/**
 * Session event fan-out and replay buffer for the VPS Gateway.
 *
 * {@link EventHub} is the gateway's in-memory event log. Every event an agent
 * turn produces is assigned a monotonically increasing `seqId` scoped to its
 * session, appended to a bounded ring buffer, and broadcast to whichever clients
 * are observing that session.
 *
 * The ring buffer is what makes reconnection cheap: a client that was offline
 * for a few seconds sends a {@link ClientCatchUpRequest} naming the last
 * `seqId` it saw, and the hub replays the gap from memory instead of asking the
 * runner to regenerate anything. It is intentionally bounded (default
 * {@link DEFAULT_BUFFER_SIZE} events per session) — this is a fast catch-up
 * cache, not durable storage; the session log on disk remains the record of
 * truth.
 */

import type {
  ClientCatchUpRequest,
  ServerCatchUpResponse,
  StreamEvent
} from '@agent/protocol';
import type { ConnectedClient } from './registry.js';

/** Events retained per session for catch-up. */
export const DEFAULT_BUFFER_SIZE = 1000;

/** A minimal sink for delivering a serialized frame to one client. */
export type EventSink = (client: ConnectedClient, event: StreamEvent) => void;

export interface EventHubOptions {
  /** Ring buffer capacity per session. Defaults to {@link DEFAULT_BUFFER_SIZE}. */
  bufferSize?: number;
  /**
   * Observers per session, keyed by `deviceId`.
   *
   * The hub does not own connection lifecycles — the registry does — so the
   * membership map is supplied here and read through {@link EventHub.clientsFor}.
   */
  subscribers?: Map<string, Set<string>>;
}

interface SessionLog {
  /** Next `seqId` to hand out; starts at 1 so `seqId` 0 means "nothing yet". */
  nextSeqId: number;
  /** Bounded, ascending-by-`seqId` event buffer. */
  buffer: StreamEvent[];
}

/** A session's buffered log, exposed for diagnostics / tests. */
export interface SessionBufferSnapshot {
  sessionId: string;
  nextSeqId: number;
  oldestSeqId: number;
  newestSeqId: number;
  size: number;
  events: StreamEvent[];
}

export class EventHub {
  private readonly bufferSize: number;
  private readonly sessions = new Map<string, SessionLog>();
  private readonly observers: Map<string, Set<string>>;

  constructor(options: EventHubOptions = {}) {
    this.bufferSize = Math.max(1, options.bufferSize ?? DEFAULT_BUFFER_SIZE);
    this.observers = options.subscribers ?? new Map<string, Set<string>>();
  }

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  /** Begin delivering a session's events to a device (idempotent). */
  subscribe(sessionId: string, deviceId: string): void {
    let set = this.observers.get(sessionId);
    if (!set) {
      set = new Set();
      this.observers.set(sessionId, set);
    }
    set.add(deviceId);
  }

  /** Stop delivering a session's events to a device. */
  unsubscribe(sessionId: string, deviceId: string): void {
    const set = this.observers.get(sessionId);
    if (!set) return;
    set.delete(deviceId);
    if (set.size === 0) this.observers.delete(sessionId);
  }

  /** Drop every subscription held by a device (called on disconnect). */
  unsubscribeAll(deviceId: string): void {
    for (const [sessionId, set] of this.observers) {
      set.delete(deviceId);
      if (set.size === 0) this.observers.delete(sessionId);
    }
  }

  /** Devices currently observing a session. */
  subscribersFor(sessionId: string): Set<string> {
    return this.observers.get(sessionId) ?? new Set();
  }

  /** Sessions a device is observing. */
  sessionsFor(deviceId: string): string[] {
    const result: string[] = [];
    for (const [sessionId, set] of this.observers) {
      if (set.has(deviceId)) result.push(sessionId);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  /**
   * Assign a `seqId`, buffer, and broadcast an event.
   *
   * `event` may omit `seqId` (the hub assigns it) or carry a provisional one,
   * which is overwritten: the hub is the sole authority on ordering, so a
   * producer cannot accidentally reuse or rewind a sequence number. `timestamp`
   * defaults to now when absent.
   */
  publish<T extends Omit<StreamEvent, 'seqId'> & { seqId?: number }>(
    event: T,
    clients: readonly ConnectedClient[] = [],
    sink?: EventSink
  ): StreamEvent {
    const log = this.logFor(event.sessionId);
    const seqId = log.nextSeqId++;
    const stamped = {
      ...event,
      seqId,
      timestamp: event.timestamp ?? Date.now()
    } as unknown as StreamEvent;

    this.append(log, stamped);
    this.dispatch(stamped, clients, sink);
    return stamped;
  }

  /** Alias for {@link publish} that reads more naturally at call sites. */
  emit<T extends Omit<StreamEvent, 'seqId'> & { seqId?: number }>(
    event: T,
    clients: readonly ConnectedClient[] = [],
    sink?: EventSink
  ): StreamEvent {
    return this.publish(event, clients, sink);
  }

  /** Re-send an already-stamped event without consuming a new `seqId`. */
  dispatch(event: StreamEvent, clients: readonly ConnectedClient[], sink?: EventSink): void {
    const deliver = sink ?? defaultSink;
    for (const client of clients) {
      if (!this.observers.get(event.sessionId)?.has(client.identity.deviceId)) continue;
      deliver(client, event);
    }
  }

  // -------------------------------------------------------------------------
  // Catch-up
  // -------------------------------------------------------------------------

  /**
   * Every buffered event for a session with `seqId > fromSeqId`.
   *
   * Returns an empty array when the session is unknown, or when the client is
   * already current. A client whose `fromSeqId` predates the oldest retained
   * event receives only what is still buffered — the caller is responsible for
   * detecting a gap (by comparing its own `fromSeqId` against the first returned
   * event's `seqId`) and reloading history if it matters.
   */
  eventsSince(sessionId: string, fromSeqId: number): StreamEvent[] {
    const log = this.sessions.get(sessionId);
    if (!log) return [];
    // The buffer is ascending by `seqId`, so a linear filter is clear and the
    // buffer is at most `bufferSize` long.
    return log.buffer.filter((event) => event.seqId > fromSeqId);
  }

  /**
   * Answer a {@link ClientCatchUpRequest}.
   *
   * Pure: the caller sends the returned message over the requesting socket and
   * (in the gateway server) subscribes it to future events.
   */
  handleCatchUp(request: ClientCatchUpRequest): ServerCatchUpResponse {
    return {
      type: 'server.catch_up',
      sessionId: request.sessionId,
      events: this.eventsSince(request.sessionId, request.fromSeqId)
    };
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** Current next `seqId` for a session (1 when nothing has been published). */
  nextSeqId(sessionId: string): number {
    return this.sessions.get(sessionId)?.nextSeqId ?? 1;
  }

  /** Buffered events for a session, oldest first. */
  buffered(sessionId: string): StreamEvent[] {
    return [...(this.sessions.get(sessionId)?.buffer ?? [])];
  }

  /** Buffer metadata for a session, or `undefined` if it has none yet. */
  snapshot(sessionId: string): SessionBufferSnapshot | undefined {
    const log = this.sessions.get(sessionId);
    if (!log) return undefined;
    const oldest = log.buffer[0]?.seqId ?? 0;
    const newest = log.buffer[log.buffer.length - 1]?.seqId ?? 0;
    return {
      sessionId,
      nextSeqId: log.nextSeqId,
      oldestSeqId: oldest,
      newestSeqId: newest,
      size: log.buffer.length,
      events: [...log.buffer]
    };
  }

  /** Forget a session entirely (buffer + subscriptions). */
  drop(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.observers.delete(sessionId);
  }

  /** Forget every session's buffer. */
  clear(): void {
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private logFor(sessionId: string): SessionLog {
    let log = this.sessions.get(sessionId);
    if (!log) {
      log = { nextSeqId: 1, buffer: [] };
      this.sessions.set(sessionId, log);
    }
    return log;
  }

  /** Append to the ring buffer, evicting the oldest entries past capacity. */
  private append(log: SessionLog, event: StreamEvent): void {
    log.buffer.push(event);
    const overflow = log.buffer.length - this.bufferSize;
    if (overflow > 0) log.buffer.splice(0, overflow);
  }
}

/**
 * Default delivery: JSON-encode and send, silently ignoring a socket that is
 * no longer writable. `ws` exposes a numeric `readyState`; the open state is 1.
 */
function defaultSink(client: ConnectedClient, event: StreamEvent): void {
  if (client.ws.readyState !== 1) return;
  try {
    client.ws.send(JSON.stringify(event));
  } catch {
    // A dead socket is the registry's problem; it will be reaped by heartbeat.
  }
}

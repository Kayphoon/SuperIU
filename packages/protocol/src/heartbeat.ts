/**
 * Heartbeat contracts.
 *
 * Either side may send a `ping`; the peer must reply with a matching `pong`
 * echoing the original timestamp so latency / liveness can be measured.
 */

/** Sent by either side to check liveness of the peer. */
export interface PingMessage {
  type: 'ping';
  /** Unix timestamp in milliseconds when the ping was sent. */
  timestamp: number;
}

/** Reply to a {@link PingMessage}. */
export interface PongMessage {
  type: 'pong';
  /** Unix timestamp echoed from the originating ping. */
  timestamp: number;
  /** Unix timestamp in milliseconds when the pong was sent. */
  receivedAt?: number;
}

/** Union of heartbeat messages. */
export type HeartbeatMessage = PingMessage | PongMessage;

/** Creates a {@link PingMessage} stamped with the current time. */
export function createPing(now: number = Date.now()): PingMessage {
  return { type: 'ping', timestamp: now };
}

/** Creates a {@link PongMessage} echoing `ping`. */
export function createPong(
  ping: PingMessage,
  now: number = Date.now(),
): PongMessage {
  return { type: 'pong', timestamp: ping.timestamp, receivedAt: now };
}

/** Type guard for {@link PingMessage}. */
export function isPingMessage(value: unknown): value is PingMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'ping'
  );
}

/** Type guard for {@link PongMessage}. */
export function isPongMessage(value: unknown): value is PongMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'pong'
  );
}

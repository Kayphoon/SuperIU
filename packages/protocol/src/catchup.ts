/**
 * Reconnect / catch-up contracts.
 *
 * When a client reconnects after being offline it asks for all events that
 * occurred after the last `seqId` it observed. The gateway replays the buffered
 * events for that session.
 */

import type { StreamEvent } from './events.js';

/** Sent by a reconnecting client to replay missed events. */
export interface ClientCatchUpRequest {
  type: 'client.catch_up';
  sessionId: string;
  /** Last sequence id the client has already processed. */
  fromSeqId: number;
}

/** Returned by the gateway with every event after `fromSeqId`. */
export interface ServerCatchUpResponse {
  type: 'server.catch_up';
  sessionId: string;
  /** Replayed events, ordered ascending by `seqId`. */
  events: StreamEvent[];
}

/** Type guard for {@link ClientCatchUpRequest}. */
export function isClientCatchUpRequest(
  value: unknown,
): value is ClientCatchUpRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'client.catch_up'
  );
}

/** Type guard for {@link ServerCatchUpResponse}. */
export function isServerCatchUpResponse(
  value: unknown,
): value is ServerCatchUpResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'server.catch_up'
  );
}

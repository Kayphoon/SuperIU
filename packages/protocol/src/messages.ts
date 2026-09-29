/**
 * Wire envelope unions for the VPS Gateway <-> Client WebSocket protocol.
 */

import type { HandshakeMessage } from './device.js';
import type { RpcRequest, RpcResponse } from './rpc.js';
import type { StreamEvent } from './events.js';
import type {
  ClientCatchUpRequest,
  ServerCatchUpResponse,
} from './catchup.js';
import type { HeartbeatMessage } from './heartbeat.js';

/** Every message a client may send to the gateway. */
export type ClientMessage =
  | HandshakeMessage
  | RpcRequest
  | RpcResponse
  | ClientCatchUpRequest
  | HeartbeatMessage;

/** Every message the gateway may send to a client. */
export type ServerMessage =
  | HandshakeMessage
  | RpcRequest
  | RpcResponse
  | StreamEvent
  | ServerCatchUpResponse
  | HeartbeatMessage;

/** Any message that can travel over the wire in either direction. */
export type WireMessage = ClientMessage | ServerMessage;

/** Discriminates envelope families for switch-based handling. */
export type MessageKind = 'handshake' | 'rpc' | 'event' | 'catchup' | 'heartbeat';

/**
 * Device identification and handshake contracts.
 *
 * A client (desktop or web) connects to the VPS Gateway over WebSocket and
 * identifies itself with a {@link ClientRegisterMessage}. The gateway responds
 * with a {@link ServerRegisterAckMessage} once the identity has been accepted.
 */

/** The kind of client connecting to the gateway. */
export type ClientType = 'desktop' | 'web';

/** Identity of a connected client device. */
export interface DeviceIdentity {
  /** Stable unique identifier for the device. */
  deviceId: string;
  /** Human readable device name (e.g. hostname). */
  deviceName: string;
  /** Whether this is a desktop app or a browser client. */
  clientType: ClientType;
  /** Authentication token issued to the device. */
  token: string;
}

/** Sent by a client immediately after the WebSocket connection opens. */
export interface ClientRegisterMessage extends DeviceIdentity {
  type: 'client.register';
}

/** Acknowledgement sent by the gateway for a successful registration. */
export interface ServerRegisterAckMessage {
  type: 'server.register.ack';
  /** Whether registration succeeded. */
  ok: boolean;
  /** Session identifier assigned by the gateway. */
  sessionId: string;
  /** Gateway server version, for compatibility checks. */
  serverVersion?: string;
  /** Present when `ok` is false. */
  error?: string;
}

/** Handshake messages exchanged during connection setup. */
export type HandshakeMessage = ClientRegisterMessage | ServerRegisterAckMessage;

/** Type guard for {@link ClientRegisterMessage}. */
export function isClientRegisterMessage(
  value: unknown,
): value is ClientRegisterMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'client.register'
  );
}

/** Type guard for {@link ServerRegisterAckMessage}. */
export function isServerRegisterAckMessage(
  value: unknown,
): value is ServerRegisterAckMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'server.register.ack'
  );
}

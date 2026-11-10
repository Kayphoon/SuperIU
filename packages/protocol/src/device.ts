/**
 * Device identification and handshake contracts.
 *
 * A client (desktop or web) connects to the VPS Gateway over WebSocket and
 * identifies itself with a {@link ClientRegisterMessage}. The gateway responds
 * with a {@link ServerRegisterAckMessage} once the identity has been accepted.
 */

/** The kind of client connecting to the gateway. */
export type ClientType = 'desktop' | 'web';

/** Canonical gateway protocol version exchanged during handshake. */
export const GATEWAY_PROTOCOL_VERSION = '1.0.0';

/** Parse major version integer from a semver-like string. */
export function parseMajorVersion(version: string | undefined | null): number | null {
  if (typeof version !== 'string') return null;
  const cleaned = version.trim().replace(/^v/i, '');
  const match = /^(\d+)/.exec(cleaned);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Checks whether client and server protocol versions are mutually compatible.
 *
 * Missing/unparseable versions are treated as compatible (v1.0.0 fallback) to
 * preserve zero-downtime backwards compatibility with older nodes.
 *
 * Incompatibility is strictly defined as different major versions (e.g. 1.x vs 2.x).
 */
export function isProtocolCompatible(
  clientVersion?: string | null,
  serverVersion?: string | null,
): boolean {
  if (!clientVersion || !serverVersion) return true;
  const clientMajor = parseMajorVersion(clientVersion);
  const serverMajor = parseMajorVersion(serverVersion);
  if (clientMajor === null || serverMajor === null) return true;
  return clientMajor === serverMajor;
}

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
  /** Gateway protocol version supported by the client. */
  protocolVersion?: string;
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
  /** Gateway protocol version, for breaking protocol checks. */
  protocolVersion?: string;
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

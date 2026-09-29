/**
 * Gateway client.
 *
 * Maintains the desktop client's persistent WebSocket connection to the VPS
 * Gateway. On top of the transport it:
 *
 *   - performs the {@link ClientRegisterMessage} handshake,
 *   - answers `ping` with `pong`,
 *   - serves JSON-RPC requests from the gateway by delegating to a
 *     {@link WorkspaceSandboxWorker} (`fs.readFile`, `fs.writeFile`,
 *     `bash.execute`),
 *   - reconnects with exponential backoff after a drop and replays missed
 *     events via {@link ClientCatchUpRequest}.
 *
 * The Electron `dialog` module is imported lazily so this module remains usable
 * (and unit-testable) outside the Electron main process.
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

import {
  isClientRegisterMessage,
  isPingMessage,
  isRpcRequest,
  isServerRegisterAckMessage,
  JSON_RPC_VERSION,
  RpcErrorCode,
  type ClientCatchUpRequest,
  type ClientRegisterMessage,
  type RpcErrorResponse,
  type RpcSuccessResponse,
  type ServerMessage,
  type ServerRegisterAckMessage,
  type PongMessage,
  type StreamEvent,
} from '@agent/protocol';

import { WorkspaceSandboxWorker } from './sandbox/worker.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Static identity + connection settings for a {@link GatewayClient}. */
export interface GatewayClientOptions {
  /** WebSocket endpoint, e.g. `ws://vps:3000/ws`. */
  url: string;
  /** Local workspace directory the sandbox is anchored to. */
  workspaceRoot: string;
  /** Stable device id; a UUID is generated when omitted. */
  deviceId?: string;
  /** Human readable device name; defaults to the OS hostname. */
  deviceName?: string;
  /** Authentication token issued to this device. */
  token: string;
  /**
   * Shows a native approval prompt for dangerous commands. Injected so the
   * Electron main process can wire up `dialog.showMessageBox`; without it any
   * dangerous command is rejected.
   */
  onApprovalRequired?: (command: string) => Promise<boolean>;
  /** Receives stream events and catch-up replays from the gateway. */
  onEvent?: (event: StreamEvent) => void;
  /** Observes connection state transitions (logging / UI). */
  onStateChange?: (state: GatewayClientState) => void;
}

/** Connection lifecycle state exposed for logging and UI. */
export type GatewayClientState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

/** An active gateway session the client must catch up on after a reconnect. */
interface ActiveSession {
  sessionId: string;
  lastSeqId: number;
}

// ---------------------------------------------------------------------------
// Reconnect tuning
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_FACTOR = 2;

// ---------------------------------------------------------------------------
// GatewayClient
// ---------------------------------------------------------------------------

export class GatewayClient {
  readonly url: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly clientType = 'desktop' as const;

  private readonly token: string;
  private readonly worker: WorkspaceSandboxWorker;
  private readonly opts: GatewayClientOptions;

  private socket: WebSocket | null = null;
  private state: GatewayClientState = 'idle';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Session assigned by the gateway on a successful register ack. */
  private session: ActiveSession | null = null;
  /** Set while the client intends to stay connected (false after `close`). */
  private shouldReconnect = false;

  constructor(options: GatewayClientOptions) {
    if (!options.url) throw new Error('GatewayClient requires a url');
    if (!options.workspaceRoot) throw new Error('GatewayClient requires a workspaceRoot');

    this.opts = options;
    this.url = options.url;
    this.deviceId = options.deviceId ?? randomUUID();
    this.deviceName = options.deviceName ?? hostname();
    this.token = options.token;
    this.worker = new WorkspaceSandboxWorker(options.workspaceRoot);
  }

  /** Current connection state. */
  get connectionState(): GatewayClientState {
    return this.state;
  }

  /** Session id assigned by the gateway, or `null` before registration. */
  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Open the connection and keep it alive with automatic reconnects. */
  connect(): void {
    this.shouldReconnect = true;
    this.openSocket();
  }

  /** Permanently close the connection and stop reconnecting. */
  close(code = 1000, reason = 'client shutting down'): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.setState('closed');
    if (this.socket) {
      try {
        this.socket.close(code, reason);
      } catch {
        /* already closing */
      }
      this.socket = null;
    }
  }

  /** Send a typed wire message if the socket is open. */
  private send(message: unknown): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  // -------------------------------------------------------------------------
  // Socket handling
  // -------------------------------------------------------------------------

  private openSocket(): void {
    this.clearReconnectTimer();
    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on('open', () => this.onOpen());
    socket.on('message', (data) => void this.onMessage(data));
    socket.on('close', () => this.onClose());
    socket.on('error', (err) => {
      // `close` always follows `error`; reconnect is handled there.
      console.error('[gateway] socket error:', err.message);
    });
  }

  private onOpen(): void {
    this.reconnectAttempts = 0;
    this.setState('connected');

    const register: ClientRegisterMessage = {
      type: 'client.register',
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      clientType: this.clientType,
      token: this.token,
    };
    this.send(register);
  }

  private onClose(): void {
    this.socket = null;
    if (!this.shouldReconnect) {
      this.setState('closed');
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    const delay = Math.min(
      INITIAL_BACKOFF_MS * BACKOFF_FACTOR ** this.reconnectAttempts,
      MAX_BACKOFF_MS,
    );
    this.reconnectAttempts += 1;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: GatewayClientState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state);
  }

  // -------------------------------------------------------------------------
  // Incoming messages
  // -------------------------------------------------------------------------

  private async onMessage(data: WebSocket.RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      console.warn('[gateway] dropped non-JSON message');
      return;
    }

    if (isPingMessage(parsed)) {
      const pong: PongMessage = {
        type: 'pong',
        timestamp: parsed.timestamp,
        receivedAt: Date.now(),
      };
      this.send(pong);
      return;
    }

    if (isServerRegisterAckMessage(parsed)) {
      this.handleRegisterAck(parsed);
      return;
    }

    if (isClientRegisterMessage(parsed)) {
      // Client-bound register frames are not expected here.
      return;
    }

    if (isRpcRequest(parsed)) {
      await this.handleRpcRequest(parsed);
      return;
    }

    // Events and catch-up replays are surfaced to the host application.
    if (isStreamEventEnvelope(parsed)) {
      if (typeof parsed.seqId === 'number' && this.session) {
        this.session.lastSeqId = parsed.seqId;
      }
      this.opts.onEvent?.(parsed);
      return;
    }

    if (isServerCatchUp(parsed)) {
      for (const event of parsed.events) {
        this.opts.onEvent?.(event);
        if (typeof event.seqId === 'number' && this.session) {
          this.session.lastSeqId = event.seqId;
        }
      }
      return;
    }
  }

  private handleRegisterAck(ack: ServerRegisterAckMessage): void {
    if (!ack.ok) {
      console.error('[gateway] registration rejected:', ack.error ?? 'unknown');
      this.shouldReconnect = false;
      return;
    }

    const previous = this.session;
    this.session = { sessionId: ack.sessionId, lastSeqId: previous?.lastSeqId ?? 0 };

    // Reconnect with an active session: replay everything we missed.
    if (previous && previous.sessionId === ack.sessionId && previous.lastSeqId > 0) {
      const catchUp: ClientCatchUpRequest = {
        type: 'client.catch_up',
        sessionId: ack.sessionId,
        fromSeqId: previous.lastSeqId,
      };
      this.send(catchUp);
    }
  }

  // -------------------------------------------------------------------------
  // RPC dispatch
  // -------------------------------------------------------------------------

  private async handleRpcRequest(request: ReturnType<typeof asRpcRequest>): Promise<void> {
    const { id, method, params } = request;
    try {
      switch (method) {
        case 'fs.readFile': {
          const result = await this.worker.handleReadFile(params);
          this.sendSuccess(id, result);
          return;
        }
        case 'fs.writeFile': {
          const result = await this.worker.handleWriteFile(params);
          this.sendSuccess(id, result);
          return;
        }
        case 'bash.execute': {
          const result = await this.worker.handleExecuteBash(
            params,
            this.opts.onApprovalRequired,
          );
          this.sendSuccess(id, result);
          return;
        }
        default:
          this.sendError(id, RpcErrorCode.MethodNotFound, `Unknown method: ${String(method)}`);
          return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.startsWith('AccessDenied')
        ? RpcErrorCode.InvalidParams
        : RpcErrorCode.InternalError;
      this.sendError(id, code, message);
    }
  }

  private sendSuccess<M extends RpcRequestId>(id: M, result: unknown): void {
    const response: RpcSuccessResponse = {
      jsonrpc: JSON_RPC_VERSION,
      id,
      result: result as RpcSuccessResponse['result'],
    };
    this.send(response);
  }

  private sendError(id: RpcRequestId, code: number, message: string): void {
    const response: RpcErrorResponse = {
      jsonrpc: JSON_RPC_VERSION,
      id,
      error: { code, message },
    };
    this.send(response);
  }
}

/** JSON-RPC id type (kept local to avoid importing the whole protocol surface). */
type RpcRequestId = string | number;

/** Narrow a request caught by `isRpcRequest` to a statically-typed envelope. */
function asRpcRequest(value: unknown) {
  return value as {
    jsonrpc: typeof JSON_RPC_VERSION;
    id: RpcRequestId;
    method: string;
    params: any;
  };
}

/** Loose check for a `server.catch_up` envelope. */
function isServerCatchUp(value: unknown): value is { type: 'server.catch_up'; events: StreamEvent[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'server.catch_up' &&
    Array.isArray((value as { events?: unknown }).events)
  );
}

/** Loose check for an event envelope carrying a numeric `seqId`. */
function isStreamEventEnvelope(value: unknown): value is StreamEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown; seqId?: unknown };
  return typeof v.type === 'string' && typeof v.seqId === 'number';
}

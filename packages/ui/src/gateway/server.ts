/**
 * VPS Gateway WebSocket server.
 *
 * {@link GatewayServer} terminates the `/ws` endpoint, authenticates each
 * connecting client with a pre-shared token, keeps its liveness current with
 * ping/pong heartbeats, and provides the two directions of traffic the product
 * needs:
 *
 * - **outbound RPC** — {@link GatewayServer.callClientRpc} invokes a method on a
 *   registered desktop and awaits its JSON-RPC response, so a server-side agent
 *   session can borrow that machine's filesystem or shell.
 * - **inbound control** — a client may start a session, submit a prompt, or
 *   interrupt a run, and receives the resulting {@link StreamEvent}s (with
 *   catch-up after a reconnect).
 *
 * The gateway is transport-only. It never imports the SPA and it does not own
 * the HTTP server: {@link GatewayServer.attach} binds to whichever server the
 * embedder already has, which is what lets `@agent/ui` serve the web shell and
 * the gateway from one port.
 */

import type * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  AgentStatus,
  ClientCatchUpRequest,
  ClientRegisterMessage,
  RpcErrorResponse,
  RpcMethod,
  RpcParamsMap,
  RpcResultMap,
  ServerCatchUpResponse,
  ServerRegisterAckMessage,
  StreamEvent
} from '@agent/protocol';
import {
  JSON_RPC_VERSION,
  RpcErrorCode,
  createPing,
  createPong,
  isClientCatchUpRequest,
  isClientRegisterMessage,
  isPingMessage,
  isRpcRequest
} from '@agent/protocol';
import { DeviceRegistry, type ConnectedClient } from './registry.js';
import { EventHub } from './event_hub.js';
import { RemoteRpcError, RpcTimeoutError, TargetDeviceOfflineError } from './errors.js';

/** Wire shape of a successful/failed JSON-RPC response as it arrives. */
type IncomingRpcResponse =
  | { jsonrpc: string; id: string | number; result: unknown; error?: never }
  | { jsonrpc: string; id: string | number | null; error: RpcErrorResponse['error']; result?: never };

function isRpcResponse(value: unknown): value is IncomingRpcResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== JSON_RPC_VERSION) return false;
  const hasId = typeof v.id === 'string' || typeof v.id === 'number';
  const hasResult = 'result' in v;
  const hasError = 'error' in v && typeof v.error === 'object' && v.error !== null;
  return (hasId && (hasResult || hasError)) || (v.id === null && hasError);
}

/** A session start request a client may send. */
export interface ClientSessionStartMessage {
  type: 'client.session_start';
  /** Session to open; omit for a fresh one. */
  sessionId?: string;
}

/** A prompt request a client may send. */
export interface ClientPromptMessage {
  type: 'client.prompt';
  sessionId: string;
  prompt: string;
  /** Per-turn model pin, never persisted. */
  model?: string;
  /** Client-generated id echoed on the resulting events, when supplied. */
  requestId?: string;
}

/** An interrupt request a client may send. */
export interface ClientInterruptMessage {
  type: 'client.interrupt';
  sessionId?: string;
}

/** Acknowledgement that a control request was accepted. */
export interface ServerCommandAckMessage {
  type: 'server.ack';
  ok: boolean;
  /** Echo of the client's `requestId`, when it supplied one. */
  requestId?: string;
  sessionId?: string;
  error?: string;
}

/** The subset of `AgentRunner` the gateway actually drives. */
export interface GatewayRunner {
  readonly status: string;
  run(
    prompt: string,
    callbacks?: unknown,
    options?: { model?: string }
  ): Promise<string>;
  abort(): void;
  createSession(): unknown;
  getSessionId(): string;
  getSessionFile(): string | null;
}

/** Runner callbacks the gateway builds each turn; structurally `RunnerCallbacks`. */
interface GatewayRunnerCallbacks {
  onStatusChange?: (status: string) => void;
  onStepStart?: (stepIndex: number) => void;
  onChunk?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCall?: (toolName: string, args: unknown) => void;
  onToolResult?: (toolName: string, result: unknown, isError?: boolean) => void;
  onError?: (error: Error) => void;
}

export interface GatewayServerOptions {
  /** HTTP server to bind to. Omit to run standalone via {@link GatewayServer.listen}. */
  server?: http.Server;
  /** Path the WebSocket upgrade is accepted on. Defaults to `/ws`. */
  path?: string;
  /**
   * Pre-shared token every client must present. Falls back to
   * `SUPERIU_GATEWAY_TOKEN`. When neither is set the gateway runs in OPEN mode
   * (development convenience) and accepts any token.
   */
  token?: string;
  /**
   * Explicitly allow an unauthenticated gateway. Defaults to `true` when no
   * token is configured, and `false` otherwise.
   */
  allowAnonymous?: boolean;
  /** Heartbeat ping cadence. Defaults to 5000ms. */
  heartbeatIntervalMs?: number;
  /** No-pong window before a device is marked offline. Defaults to 15000ms. */
  offlineTimeoutMs?: number;
  /** Default per-RPC timeout. Defaults to 30000ms. */
  rpcTimeoutMs?: number;
  /** Event buffer capacity per session. Defaults to 1000. */
  bufferSize?: number;
  /** Version reported in the registration ack. */
  serverVersion?: string;
  /** The agent runner control requests are dispatched to. */
  runner?: GatewayRunner;
}

/** Handlers the gateway needs to build a turn's `RunnerCallbacks`. */
export interface GatewayRunnerBridge {
  run(
    prompt: string,
    callbacks: GatewayRunnerCallbacks,
    options: { model?: string }
  ): Promise<void>;
}

/**
 * Everything the gateway emits for one session is funneled through
 * {@link GatewayServer.emitEvent}, which stamps a `seqId` and broadcasts.
 */
export class GatewayServer {
  public readonly registry: DeviceRegistry;
  public readonly hub: EventHub;
  public readonly path: string;

  private readonly token: string | undefined;
  private readonly allowAnonymous: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly serverVersion: string;
  private readonly runner?: GatewayRunner;
  private wss: WebSocketServer | undefined;
  private attachedServer: http.Server | undefined;
  private ownsServer = false;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private closed = false;

  /**
   * Set while the host is draining for a self-update: every new prompt is
   * refused so an in-flight turn can finish and nothing new starts. Read and
   * written by the host through {@link isIdle}; the gateway only enforces it.
   */
  private draining = false;

  /** Prompt turns currently running. The gateway is idle at zero. */
  private activeTurns = 0;

  /**
   * Track the session a socket has registered against. A connection is bound to
   * exactly one session id it names in its prompts; the ack contains the runner's
   * current session id so the client knows what it is observing.
   */
  private readonly connectionSessions = new Map<WebSocket, string>();

  constructor(options: GatewayServerOptions = {}) {
    this.path = options.path ?? '/ws';
    this.token = options.token ?? process.env.SUPERIU_GATEWAY_TOKEN;
    this.allowAnonymous = options.allowAnonymous ?? !this.token;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 30_000;
    this.serverVersion = options.serverVersion ?? '0.1.0';
    this.runner = options.runner;

    this.registry = new DeviceRegistry({
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      offlineTimeoutMs: options.offlineTimeoutMs,
      onDeviceOffline: (deviceId) => {
        // Future events for a session the device observed would never be
        // delivered, so drop every subscription as soon as it is known offline.
        this.hub.unsubscribeAll(deviceId);
      }
    });

    this.hub = new EventHub({ bufferSize: options.bufferSize });

    this.heartbeatTimer = setInterval(() => this.sendHeartbeats(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();

    if (options.server) this.attach(options.server);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Whether the gateway is idle: no prompt turn is currently running. The host
   * gates a self-update on this, so an upgrade never interrupts a live turn.
   */
  isIdle(): boolean {
    return this.activeTurns === 0;
  }

  /** Stop accepting new prompt turns; in-flight turns are left to finish. */
  setDraining(draining: boolean): void {
    this.draining = draining;
  }

  /** Bind to an existing HTTP server, upgrading requests on {@link path}. */
  attach(server: http.Server): void {
    if (this.wss) {
      throw new Error('GatewayServer is already attached to a server.');
    }
    this.attachedServer = server;
    this.wss = this.createSocketServer(server);
  }

  /**
   * Run standalone on an ephemeral (or fixed) port. Returns the bound port.
   * Used by `node dist/gateway/server.js` style invocations and tests.
   */
  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    if (this.wss) throw new Error('GatewayServer is already attached to a server.');

    const server = (await import('node:http')).createServer((_req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Upgrade Required');
    });
    this.ownsServer = true;
    this.attachedServer = server;
    this.wss = this.createSocketServer(server);

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    const address = server.address();
    return typeof address === 'object' && address ? address.port : port;
  }

  /** Stop accepting connections and tear every live client down. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);

    this.registry.clearAll();

    const wss = this.wss;
    if (wss) {
      for (const ws of wss.clients) {
        try {
          ws.close(1001, 'gateway shutting down');
        } catch {
          /* already closing */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      this.wss = undefined;
    }

    if (this.ownsServer && this.attachedServer) {
      const server = this.attachedServer;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      this.attachedServer = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Outbound RPC
  // -------------------------------------------------------------------------

  /**
   * Invoke `method` on a registered client and resolve with its result.
   *
   * Rejects with {@link TargetDeviceOfflineError} when the device is unknown or
   * drops mid-flight, and {@link RpcTimeoutError} when no response arrives in
   * `timeoutMs`. A JSON-RPC `error` object becomes {@link RemoteRpcError}.
   */
  callClientRpc<M extends RpcMethod>(
    deviceId: string,
    method: M,
    params: RpcParamsMap[M],
    timeoutMs: number = this.rpcTimeoutMs
  ): Promise<RpcResultMap[M]> {
    const client = this.registry.get(deviceId);
    if (!client) {
      return Promise.reject(new TargetDeviceOfflineError(deviceId, method));
    }

    const id = randomUUID();
    return new Promise<RpcResultMap[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.registry.takePendingRpc(deviceId, id);
        reject(new RpcTimeoutError(deviceId, method, timeoutMs));
      }, timeoutMs);
      timer.unref?.();

      this.registry.addPendingRpc(deviceId, id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method
      });

      const frame = JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, params });
      try {
        client.ws.send(frame, (err?: Error) => {
          if (!err) return;
          // The socket rejected the write; treat it as an offline device rather
          // than leaving the promise to rot until the timeout.
          const pending = this.registry.takePendingRpc(deviceId, id);
          pending?.reject(new TargetDeviceOfflineError(deviceId, method, `Failed to send RPC: ${err.message}`));
        });
      } catch (err) {
        const pending = this.registry.takePendingRpc(deviceId, id);
        pending?.reject(
          new TargetDeviceOfflineError(
            deviceId,
            method,
            `Failed to send RPC: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // Broadcasting
  // -------------------------------------------------------------------------

  /**
   * Stamp a `seqId` onto an event and broadcast it to the session's observers.
   *
   * This is the single funnel every producer (a runner callback, the gateway
   * itself) goes through, which is what keeps `seqId` monotonic per session.
   */
  emitEvent(event: Omit<StreamEvent, 'seqId'> & { seqId?: number }): StreamEvent {
    return this.hub.publish(event, this.registry.getAll());
  }

  /** Subscribe a device to a session's live events. */
  subscribe(sessionId: string, deviceId: string): void {
    this.hub.subscribe(sessionId, deviceId);
  }

  /** Replay buffered events after `fromSeqId` as a catch-up response. */
  handleCatchUp(request: ClientCatchUpRequest): ServerCatchUpResponse {
    return this.hub.handleCatchUp(request);
  }

  // -------------------------------------------------------------------------
  // Wire handling
  // -------------------------------------------------------------------------

  private createSocketServer(server: http.Server): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });

    // Auth and routing happen on the raw upgrade; a rejected upgrade gets an
    // HTTP status rather than an immediately-closed socket, which a browser
    // surfaces as a failed connection instead of an opaque close code.
    server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== this.path) return; // Another listener may own it.
      if (this.closed) {
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (ws: WebSocket) => this.onConnection(ws));
    return wss;
  }

  private onConnection(ws: WebSocket): void {
    let client: ConnectedClient | undefined;
    let registered = false;

    ws.on('message', (data: Buffer) => {
      if (client) this.registry.touch(client.identity.deviceId);

      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        this.sendRpcError(ws, null, RpcErrorCode.ParseError, 'Invalid JSON frame');
        return;
      }

      // The first frame MUST be the registration handshake; anything else is a
      // protocol violation that closes the connection.
      if (!registered) {
        if (!isClientRegisterMessage(parsed)) {
          this.sendRegisterAck(ws, { ok: false, error: 'Expected client.register as the first message.' });
          ws.close(4001, 'handshake required');
          return;
        }
        const accepted = this.authenticate(parsed);
        if (!accepted.ok) {
          this.sendRegisterAck(ws, { ok: false, error: accepted.error });
          ws.close(4003, 'unauthorized');
          return;
        }

        client = this.registry.register(accepted.identity, ws);
        registered = true;
        const sessionId = this.runner?.getSessionId() ?? '';
        this.connectionSessions.set(ws, sessionId);
        // The device becomes an observer of the session the gateway is running;
        // a client may add more via catch-up or its own prompt requests.
        if (sessionId) this.subscribe(sessionId, accepted.identity.deviceId);
        this.sendRegisterAck(ws, { ok: true, sessionId });
        return;
      }

      this.handleFrame(ws, client, parsed);
    });

    const teardown = (): void => {
      if (client) this.registry.markOffline(client.identity.deviceId);
      this.connectionSessions.delete(ws);
      client = undefined;
      registered = false;
    };

    ws.on('close', teardown);
    ws.on('error', teardown);
  }

  private handleFrame(ws: WebSocket, client: ConnectedClient | undefined, parsed: unknown): void {
    if (!client) return;

    // Heartbeat: reply to a ping, absorb a pong (liveness already recorded).
    if (isPingMessage(parsed)) {
      this.send(ws, createPong(parsed));
      return;
    }
    if (typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'pong') {
      return;
    }

    // JSON-RPC response to an outbound request.
    if (isRpcResponse(parsed)) {
      const id = String(parsed.id);
      const pending = this.registry.takePendingRpc(client.identity.deviceId, id);
      if (!pending) return; // Late / duplicate / unknown response.

      if ('error' in parsed && parsed.error) {
        pending.reject(new RemoteRpcError(parsed.error.code, parsed.error.message, parsed.error.data));
      } else {
        pending.resolve((parsed as { result: unknown }).result);
      }
      return;
    }

    // Catch-up request.
    if (isClientCatchUpRequest(parsed)) {
      this.subscribe(parsed.sessionId, client.identity.deviceId);
      this.send(ws, this.handleCatchUp(parsed));
      return;
    }

    // Inbound JSON-RPC request from the client (e.g. gateway-side capability).
    if (isRpcRequest(parsed)) {
      void this.handleClientRpcRequest(ws, client, parsed);
      return;
    }

    // Control messages.
    const type = typeof parsed === 'object' && parsed !== null ? (parsed as { type?: unknown }).type : undefined;
    switch (type) {
      case 'client.session_start':
        this.handleSessionStart(ws, parsed as { sessionId?: string });
        return;
      case 'client.prompt':
        this.handlePrompt(ws, client, parsed as { sessionId: string; prompt: string; model?: string; requestId?: string });
        return;
      case 'client.interrupt':
        this.handleInterrupt(ws, parsed as { sessionId?: string });
        return;
      default:
        // Unknown frames are ignored rather than fatal, so a newer client can
        // send message kinds this gateway build does not understand yet.
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Control dispatch
  // -------------------------------------------------------------------------

  private handleSessionStart(ws: WebSocket, message: { sessionId?: string }): void {
    if (!this.runner) {
      this.send(ws, this.ack(false, 'No agent runner is attached to the gateway.'));
      return;
    }
    try {
      if (message.sessionId) {
        // The runner exposes loadSession; a missing one is surfaced as a nack.
        const maybeLoad = (this.runner as unknown as { loadSession?: (ref: string) => unknown }).loadSession;
        if (maybeLoad) maybeLoad.call(this.runner, message.sessionId);
      } else {
        this.runner.createSession();
      }
    } catch (err) {
      this.send(ws, this.ack(false, err instanceof Error ? err.message : String(err)));
      return;
    }
    const sessionId = this.runner.getSessionId();
    this.connectionSessions.set(ws, sessionId);
    this.send(ws, { type: 'server.ack', ok: true, sessionId });
  }

  private handleInterrupt(ws: WebSocket, _message: { sessionId?: string }): void {
    if (!this.runner) {
      this.send(ws, this.ack(false, 'No agent runner is attached to the gateway.'));
      return;
    }
    this.runner.abort();
    this.send(ws, { type: 'server.ack', ok: true, sessionId: this.runner.getSessionId() });
  }

  /**
   * Run one agent turn, streaming its callbacks as {@link StreamEvent}s.
   *
   * The turn runs in the background: the client is acknowledged immediately and
   * receives the run through the event stream, so a slow model call never blocks
   * the socket's frame handling.
   */
  private handlePrompt(
    ws: WebSocket,
    client: ConnectedClient,
    message: { sessionId: string; prompt: string; model?: string; requestId?: string }
  ): void {
    // Draining for a self-update: refuse the turn outright so nothing new
    // starts while the process is being replaced.
    if (this.draining) {
      this.send(
        ws,
        this.ack(false, 'Gateway is updating, please retry shortly.', message.requestId)
      );
      return;
    }
    if (!this.runner) {
      this.send(ws, this.ack(false, 'No agent runner is attached to the gateway.', message.requestId));
      return;
    }
    const prompt = typeof message.prompt === 'string' ? message.prompt.trim() : '';
    if (!prompt) {
      this.send(ws, this.ack(false, 'Missing required field: prompt', message.requestId));
      return;
    }
    const sessionId = message.sessionId || this.runner.getSessionId();
    this.subscribe(sessionId, client.identity.deviceId);
    this.connectionSessions.set(ws, sessionId);

    this.send(ws, { type: 'server.ack', ok: true, sessionId, requestId: message.requestId });

    this.activeTurns += 1;
    const callbacks = this.runnerCallbacks(sessionId);
    void this.runner
      .run(prompt, callbacks, message.model ? { model: message.model } : {})
      .catch((err: unknown) => {
        // `onError` normally reports this; a rejection outside the model call
        // (e.g. a busy runner) still needs to reach the client.
        this.emitEvent({
          type: 'agent.error',
          sessionId,
          timestamp: Date.now(),
          message: err instanceof Error ? err.message : String(err)
        } as Omit<StreamEvent, 'seqId'>);
      })
      .finally(() => {
        this.activeTurns -= 1;
      });
  }

  /** Translate core `RunnerCallbacks` into protocol {@link StreamEvent}s. */
  private runnerCallbacks(sessionId: string): GatewayRunnerCallbacks {
    const emit = (event: Omit<StreamEvent, 'seqId'>): void => {
      this.emitEvent(event);
    };
    return {
      onStatusChange: (status) =>
        emit({ type: 'agent.status', sessionId, status: normalizeStatus(status), timestamp: Date.now() } as Omit<StreamEvent, 'seqId'>),
      onStepStart: (step) => emit({ type: 'agent.step', sessionId, step, timestamp: Date.now() } as Omit<StreamEvent, 'seqId'>),
      onChunk: (delta) => emit({ type: 'agent.chunk', sessionId, delta, timestamp: Date.now() } as Omit<StreamEvent, 'seqId'>),
      onReasoning: (delta) =>
        emit({ type: 'agent.reasoning', sessionId, delta, timestamp: Date.now() } as Omit<StreamEvent, 'seqId'>),
      onToolCall: (toolName, args) =>
        emit({
          type: 'agent.tool_call',
          sessionId,
          toolCallId: toolName,
          toolName,
          args,
          timestamp: Date.now()
        } as Omit<StreamEvent, 'seqId'>),
      onToolResult: (toolName, result, isError) =>
        emit({
          type: 'agent.tool_result',
          sessionId,
          toolCallId: toolName,
          toolName,
          result,
          isError: isError === true,
          timestamp: Date.now()
        } as Omit<StreamEvent, 'seqId'>),
      onError: (error) =>
        emit({
          type: 'agent.error',
          sessionId,
          message: error.message,
          timestamp: Date.now()
        } as Omit<StreamEvent, 'seqId'>)
    };
  }

  /**
   * Answer an inbound JSON-RPC request from a client.
   *
   * The gateway exposes no device-facing methods of its own yet, so every method
   * is answered with `MethodNotFound` — but the envelope is handled here so the
   * surface exists and is symmetric with {@link callClientRpc}.
   */
  private async handleClientRpcRequest(
    ws: WebSocket,
    _client: ConnectedClient,
    request: { id: string | number; method: string }
  ): Promise<void> {
    this.sendRpcError(ws, request.id, RpcErrorCode.MethodNotFound, `Unknown gateway method '${request.method}'.`);
  }

  // -------------------------------------------------------------------------
  // Heartbeats
  // -------------------------------------------------------------------------

  private sendHeartbeats(): void {
    const ping = createPing();
    const frame = JSON.stringify(ping);
    for (const client of this.registry.getAll()) {
      if (client.ws.readyState !== 1) continue;
      try {
        client.ws.send(frame);
      } catch {
        /* reaped by the registry watchdog */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Token verification
  // -------------------------------------------------------------------------

  private authenticate(
    message: ClientRegisterMessage
  ): { ok: true; identity: ClientRegisterMessage } | { ok: false; error: string } {
    if (!message.deviceId || typeof message.deviceId !== 'string') {
      return { ok: false, error: 'Missing deviceId.' };
    }
    if (this.allowAnonymous && !this.token) {
      return { ok: true, identity: message };
    }
    if (!this.token) {
      return { ok: true, identity: message };
    }
    if (message.token !== this.token) {
      return { ok: false, error: 'Invalid gateway token.' };
    }
    return { ok: true, identity: message };
  }

  // -------------------------------------------------------------------------
  // Frame helpers
  // -------------------------------------------------------------------------

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* socket is being torn down */
    }
  }

  private sendRegisterAck(
    ws: WebSocket,
    body: { ok: boolean; sessionId?: string; error?: string }
  ): void {
    const ack: ServerRegisterAckMessage = {
      type: 'server.register.ack',
      ok: body.ok,
      sessionId: body.sessionId ?? '',
      serverVersion: this.serverVersion,
      ...(body.error ? { error: body.error } : {})
    };
    this.send(ws, ack);
  }

  private sendRpcError(ws: WebSocket, id: string | number | null, code: number, message: string): void {
    this.send(ws, { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } });
  }

  private ack(ok: boolean, error?: string, requestId?: string): ServerCommandAckMessage {
    return { type: 'server.ack', ok, ...(requestId ? { requestId } : {}), ...(error ? { error } : {}) };
  }
}

/**
 * Map the core runner's `AgentStatus` onto the protocol's narrower set.
 *
 * The core distinguishes `tool_calling` / `streaming` / `aborted` / `error`,
 * which the wire protocol collapses into `running` / `failed`; a client only
 * needs to know whether a turn is live, done, or broken.
 */
function normalizeStatus(status: string): AgentStatus {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'thinking':
      return 'thinking';
    case 'running':
    case 'streaming':
    case 'tool_calling':
      return 'running';
    case 'completed':
      return 'completed';
    case 'error':
      return 'failed';
    case 'aborted':
      return 'failed';
    case 'paused':
      return 'paused';
    default:
      return 'running';
  }
}

/** Reject a WebSocket upgrade with a plain HTTP response and close the socket. */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const body = `${status} ${reason}`;
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body
  );
  socket.destroy();
}

/**
 * Event stream contracts.
 *
 * Every {@link StreamEvent} carries a monotonic `seqId` scoped to a
 * `sessionId`, which allows a reconnecting client to request all events it
 * missed via a catch-up request.
 */

/** Discriminator for the kinds of events a session can emit. */
export type StreamEventType =
  | 'agent.status'
  | 'agent.chunk'
  | 'agent.reasoning'
  | 'agent.step'
  | 'agent.tool_call'
  | 'agent.tool_result'
  | 'agent.error'
  | 'agent.paused';

/** Fields shared by every stream event. */
export interface StreamEventBase {
  /** Monotonically increasing sequence id, unique within a session. */
  seqId: number;
  /** Session this event belongs to. */
  sessionId: string;
  /** Unix timestamp in milliseconds when the event was emitted. */
  timestamp: number;
}

/** Overall agent lifecycle status. */
export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed';

export interface AgentStatusEvent extends StreamEventBase {
  type: 'agent.status';
  status: AgentStatus;
  /** Optional human readable detail. */
  message?: string;
}

export interface AgentChunkEvent extends StreamEventBase {
  type: 'agent.chunk';
  /** Incremental text emitted by the model. */
  delta: string;
}

export interface AgentReasoningEvent extends StreamEventBase {
  type: 'agent.reasoning';
  /** Incremental reasoning / chain-of-thought text. */
  delta: string;
}

export interface AgentStepEvent extends StreamEventBase {
  type: 'agent.step';
  /** Zero-based step index within the run. */
  step: number;
  /** Optional label describing the step. */
  title?: string;
}

export interface AgentToolCallEvent extends StreamEventBase {
  type: 'agent.tool_call';
  /** Tool call identifier, used to correlate with a later result. */
  toolCallId: string;
  /** Name of the tool being invoked (e.g. `bash.execute`). */
  toolName: string;
  /** JSON-serializable arguments passed to the tool. */
  args: unknown;
}

export interface AgentToolResultEvent extends StreamEventBase {
  type: 'agent.tool_result';
  /** Identifier of the originating {@link AgentToolCallEvent}. */
  toolCallId: string;
  toolName: string;
  /** JSON-serializable result payload. */
  result: unknown;
  /** Whether the tool invocation failed. */
  isError?: boolean;
}

export interface AgentErrorEvent extends StreamEventBase {
  type: 'agent.error';
  code?: string;
  message: string;
  /** Optional JSON-serializable error details. */
  details?: unknown;
  /** Whether the session may recover from this error. */
  recoverable?: boolean;
}

/** Reasons an agent run may be paused. */
export type AgentPauseReason = 'client_offline' | 'waiting_approval';

export interface AgentPausedEvent extends StreamEventBase {
  type: 'agent.paused';
  reason: AgentPauseReason;
  message?: string;
}

/** Discriminated union of all stream events. */
export type StreamEvent =
  | AgentStatusEvent
  | AgentChunkEvent
  | AgentReasoningEvent
  | AgentStepEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentErrorEvent
  | AgentPausedEvent;

/** Extracts the event type carried by a {@link StreamEvent}. */
export type StreamEventOf<T extends StreamEventType> = Extract<
  StreamEvent,
  { type: T }
>;

/** Type guard for any stream event envelope. */
export function isStreamEvent(value: unknown): value is StreamEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<StreamEvent>;
  return (
    typeof v.type === 'string' &&
    typeof v.seqId === 'number' &&
    typeof v.sessionId === 'string'
  );
}

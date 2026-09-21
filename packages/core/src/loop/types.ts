import type { CoreMessage } from 'ai';
import type { ToolCallItem } from '../context/types.js';
import type { PermissionGate } from '../review/types.js';
import type { ModelRoute } from '../model/router.js';

export interface StepCallParams {
  system: string;
  messages: CoreMessage[];
  tools?: Record<string, unknown>;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  onToolCall?: (name: string, args: unknown) => void;
}

export interface StepUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface StepExecutionResult {
  text: string;
  toolCalls: ToolCallItem[];
  finishReason?: string;
  usage?: StepUsage;
}

export interface StepModelCaller {
  callStep(params: StepCallParams): Promise<StepExecutionResult>;
}

export interface LoopExecutionCallbacks {
  onStepStart?: (stepIndex: number) => void;
  onChunk?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCall?: (toolName: string, args: unknown) => void;
  onToolResult?: (toolName: string, result: unknown, isError?: boolean) => void;
  onError?: (error: Error) => void;
}

export interface LoopExecutionOptions {
  maxSteps?: number; // default Infinity
  signal?: AbortSignal;
  callbacks?: LoopExecutionCallbacks;
  stepTimeoutMs?: number;
  /** Interactive resolver for AutoReview `ask_user` verdicts. */
  permissionGate?: PermissionGate;
  /**
   * Pin this turn to a specific model, merged over the router's `main` route.
   * Applies to this run only and never mutates the router.
   */
  model?: string;
  /** Pin this turn to a partial route merged over the router's `main` route. */
  modelRoute?: Partial<ModelRoute>;
}

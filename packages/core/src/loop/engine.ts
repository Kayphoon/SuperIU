import type { SessionManager } from '../session/manager.js';
import type { ContextAssembler } from '../context/assembler.js';
import type { ContextCompactor } from '../context/compactor.js';
import type { ToolCallItem, ToolResultItem } from '../context/types.js';
import type {
  StepModelCaller,
  LoopExecutionOptions,
  StepExecutionResult,
  StepUsage
} from './types.js';
import type { IAutoReviewer, PermissionGate, ReviewResult } from '../review/types.js';
import { type ModelRoute, type ModelRouter } from '../model/router.js';

/**
 * Structural view of a tool: the AI SDK `Tool` object is assignable to this
 * because the executor is treated opaquely and invoked with a runtime cast.
 */
export interface ToolDefinition {
  description?: string;
  parameters?: unknown;
  execute?: unknown;
}

export interface AgentLoopEngineOptions {
  session: SessionManager;
  assembler: ContextAssembler;
  stepCaller: StepModelCaller;
  compactor?: ContextCompactor;
  tools?: Record<string, ToolDefinition>;
  /** Optional automatic approval gate consulted before every tool execution. */
  reviewer?: IAutoReviewer;
  /** Interactive resolver for AutoReview `ask_user` verdicts. */
  permissionGate?: PermissionGate;
  /** Workspace root handed to the reviewer for path-escape checks. */
  workspaceDir?: string;
  /** Router used to resolve a per-turn `model` / `modelRoute` override. */
  modelRouter?: ModelRouter;
  /** Builds a step caller for an ad-hoc route, used only for per-turn overrides. */
  createStepCaller?: (route: ModelRoute) => StepModelCaller;
}

export interface AgentLoopRunResult {
  sessionId: string;
  finalText: string;
  stepCount: number;
  totalToolCalls: number;
  aborted: boolean;
  /**
   * Usage of the LAST step that reported any, so a caller gets the context size
   * of the turn it just ran without reaching into the engine.
   */
  usage?: StepUsage;
  error?: Error;
}

export interface ToolExecutionRecord {
  toolCallId: string;
  name: string;
  result: string;
  isError: boolean;
  durationMs: number;
}

/**
 * Unbounded autonomous loop.
 *
 * Owns the single tool-execution authority: `AiSdkStepAdapter` only declares tool
 * schemas, so every tool call lands here exactly once, is timed, self-heals on
 * error, and is appended to the JSONL session as a `toolResult` message.
 */
export class AgentLoopEngine {
  public session: SessionManager;
  public assembler: ContextAssembler;
  public stepCaller: StepModelCaller;
  public compactor: ContextCompactor;
  public tools: Record<string, ToolDefinition>;
  public reviewer?: IAutoReviewer;
  public permissionGate?: PermissionGate;
  public workspaceDir: string;
  public modelRouter?: ModelRouter;
  public createStepCaller?: (route: ModelRoute) => StepModelCaller;
  /**
   * Usage reported by the most recent step, or `undefined` before any step has
   * run in this engine's lifetime. Held on the engine (rather than returned only
   * from `run`) because a shell polls it while the turn is still streaming —
   * `run` has not resolved yet, but the meter must already move.
   */
  public latestUsage?: StepUsage;

  constructor(options: AgentLoopEngineOptions) {
    this.session = options.session;
    this.assembler = options.assembler;
    this.stepCaller = options.stepCaller;
    this.compactor = options.compactor || options.assembler.compactor;
    this.tools = options.tools || {};
    this.reviewer = options.reviewer;
    this.permissionGate = options.permissionGate;
    this.workspaceDir = options.workspaceDir ?? process.cwd();
    this.modelRouter = options.modelRouter;
    this.createStepCaller = options.createStepCaller;
  }

  /**
   * Step caller for one turn.
   *
   * A per-turn `model` / `modelRoute` override is resolved here, per run, and
   * never written back to the router: pinning one turn must not change what the
   * next turn uses, and an in-flight turn must not be disturbed by `setModel`.
   */
  private stepCallerFor(options: LoopExecutionOptions): StepModelCaller {
    const hasOverride = Boolean(options.model || options.modelRoute);
    if (!hasOverride || !this.modelRouter || !this.createStepCaller) {
      return this.stepCaller;
    }

    // Merge the override onto the UNSCALED base, then let the router finalize
    // once. Resolving `main` first would hand over an already effort-scaled
    // budget, and finalizing that again multiplies the effort twice — a medium
    // route would silently ask for 8192 instead of 4096.
    const merged: ModelRoute = {
      ...this.modelRouter.resolveBase('main'),
      ...(options.modelRoute ?? {}),
      ...(options.model ? { model: options.model } : {})
    };

    return this.createStepCaller(this.modelRouter.finalize(merged));
  }

  public async run(
    prompt?: string,
    options: LoopExecutionOptions = {}
  ): Promise<AgentLoopRunResult> {
    const signal = options.signal;
    const callbacks = options.callbacks || {};
    const maxSteps = options.maxSteps ?? Infinity;
    const sessionId = this.session.getSessionId();
    // Resolved once per turn: a mid-turn setModel must not swap the model
    // underneath a turn that is already running.
    const turnStepCaller = this.stepCallerFor(options);

    if (prompt && prompt.trim()) {
      this.session.appendMessage({ role: 'user', content: prompt.trim() });
    }

    let stepIndex = 0;
    let totalToolCalls = 0;
    let lastAssistantText = '';

    while (stepIndex < maxSteps) {
      if (signal?.aborted) {
        return {
          sessionId,
          finalText: lastAssistantText || '[Task aborted by user]',
          stepCount: stepIndex,
          totalToolCalls,
          aborted: true,
          usage: this.latestUsage
        };
      }

      stepIndex++;
      callbacks.onStepStart?.(stepIndex);

      // 1. Dynamic context assembly: workstation + layered memory + active branch.
      const assembled = await this.assembler.assemble();

      // 2. Single model step (tool schemas only — no execution on the SDK side).
      let stepResult: StepExecutionResult;
      try {
        stepResult = await turnStepCaller.callStep({
          system: assembled.systemPrompt,
          messages: assembled.coreMessages,
          tools: this.tools as unknown as Record<string, unknown>,
          signal,
          onChunk: (chunk) => callbacks.onChunk?.(chunk),
          onReasoning: (chunk) => callbacks.onReasoning?.(chunk),
          onToolCall: (name, args) => callbacks.onToolCall?.(name, args)
        });
      } catch (err: unknown) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        const isAbort =
          signal?.aborted || errorObj.name === 'AbortError' || errorObj.message.includes('aborted');

        if (isAbort) {
          return {
            sessionId,
            finalText: lastAssistantText || '[Task aborted by user]',
            stepCount: stepIndex,
            totalToolCalls,
            aborted: true,
            usage: this.latestUsage
          };
        }

        callbacks.onError?.(errorObj);
        throw errorObj;
      }

      lastAssistantText = stepResult.text;
      // Kept for the whole engine, not just this turn: a shell polls it mid-turn
      // (before `run` resolves) and after a reload, when the resumed branch has
      // no usage of its own to report.
      if (stepResult.usage) {
        this.latestUsage = stepResult.usage;
      }

      // 3. Persist the assistant turn (with its tool calls) into the JSONL tree.
      this.session.appendMessage({
        role: 'assistant',
        content: stepResult.text || undefined,
        toolCalls: stepResult.toolCalls.length > 0 ? stepResult.toolCalls : undefined
      });

      // 4. Convergence: no tool calls means the autonomous loop has settled.
      if (stepResult.toolCalls.length === 0) {
        return {
          sessionId,
          finalText: stepResult.text,
          stepCount: stepIndex,
          totalToolCalls,
          aborted: false,
          usage: this.latestUsage
        };
      }

      // 5. Exclusive tool execution with self-healing error capture.
      const toolResults: ToolResultItem[] = [];

      for (const toolCall of stepResult.toolCalls) {
        totalToolCalls++;

        if (signal?.aborted) {
          toolResults.push({
            toolCallId: toolCall.id,
            name: toolCall.name,
            result: 'Tool execution cancelled: Aborted by user',
            isError: true
          });
          continue;
        }

        const review = await this.reviewToolCall(toolCall, signal);

        if (review?.decision === 'deny') {
          const deniedMessage =
            `[AutoReview Denied] ${review.reason} ` +
            `(Risk: ${review.riskLevel}, Reviewed by: ${review.reviewedBy})`;
          toolResults.push({
            toolCallId: toolCall.id,
            name: toolCall.name,
            result: deniedMessage,
            isError: true
          });
          callbacks.onToolResult?.(toolCall.name, deniedMessage, true);
          continue;
        }

        // `ask_user` means "a human should decide": hand the call to the
        // interactive gate when one is wired, otherwise surface it as pending.
        if (review?.decision === 'ask_user') {
          const gate = options.permissionGate ?? this.permissionGate;

          if (!gate) {
            const pendingMessage =
              '[AutoReview Pending Approval]: Tool requires user confirmation. ' +
              `(Risk: ${review.riskLevel}, Reason: ${review.reason})`;
            toolResults.push({
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: pendingMessage,
              isError: true
            });
            callbacks.onToolResult?.(toolCall.name, pendingMessage, true);
            continue;
          }

          let approved = false;
          try {
            approved = await gate(toolCall, review);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            const gateError =
              `[AutoReview Pending Approval]: Approval channel failed: ${message}. ` +
              'Tool not executed.';
            toolResults.push({
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: gateError,
              isError: true
            });
            callbacks.onToolResult?.(toolCall.name, gateError, true);
            continue;
          }

          if (!approved) {
            const userDenied = '[User Denied]: Execution rejected by user.';
            toolResults.push({
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: userDenied,
              isError: true
            });
            callbacks.onToolResult?.(toolCall.name, userDenied, true);
            continue;
          }
          // Approved: fall through and execute the tool as requested.
        }

        const record = await this.executeTool(toolCall, assembled.coreMessages);
        toolResults.push({
          toolCallId: record.toolCallId,
          name: record.name,
          result: record.result,
          isError: record.isError
        });
        callbacks.onToolResult?.(record.name, record.result, record.isError);
      }

      // 6. Persist tool results as a `toolResult` message.
      this.session.appendMessage({
        role: 'tool',
        toolResults
      });
    }

    return {
      sessionId,
      finalText: lastAssistantText || '[Loop reached maximum step limit]',
      stepCount: stepIndex,
      totalToolCalls,
      aborted: false,
      usage: this.latestUsage
    };
  }

  /**
   * Consult the automatic approval gate. Returns `null` when no reviewer is
   * configured. A reviewer that throws is escalated rather than allowed, so an
   * infrastructure fault can never silently widen permissions.
   */
  private async reviewToolCall(
    toolCall: ToolCallItem,
    signal?: AbortSignal
  ): Promise<ReviewResult | null> {
    if (!this.reviewer) {
      return null;
    }
    try {
      return await this.reviewer.review({
        toolCall,
        workspaceDir: this.workspaceDir,
        signal
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        decision: 'ask_user',
        riskLevel: 'high',
        reason: `AutoReview could not evaluate this call: ${message}`,
        reviewedBy: 'rule'
      };
    }
  }

  /** Execute exactly one tool call, timing it and converting failures into feedback. */
  public async executeTool(
    toolCall: ToolCallItem,
    messages: unknown[] = []
  ): Promise<ToolExecutionRecord> {
    const startedAt = Date.now();
    const tool = this.tools[toolCall.name];

    if (!tool) {
      const available = Object.keys(this.tools).join(', ') || 'none';
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: `[Tool Error in ${toolCall.name}]: Tool not found. Available: ${available}`,
        isError: true,
        durationMs: Date.now() - startedAt
      };
    }

    if (typeof tool.execute !== 'function') {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: `[Tool Error in ${toolCall.name}]: Tool does not provide an execute handler.`,
        isError: true,
        durationMs: Date.now() - startedAt
      };
    }

    try {
      const rawResult = await (tool.execute as (args: unknown, context?: unknown) => unknown)(
        toolCall.args,
        { toolCallId: toolCall.id, messages }
      );

      // 2000-char spillover circuit breaker; oversized output goes to disk.
      const compacted = await this.compactor.compactToolResult(rawResult);

      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: compacted.text,
        isError: false,
        durationMs: Date.now() - startedAt
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: `[Tool Error in ${toolCall.name}]: ${errorMsg}`,
        isError: true,
        durationMs: Date.now() - startedAt
      };
    }
  }
}

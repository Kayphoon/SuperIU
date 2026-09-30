import type { CoreMessage } from 'ai';
import type { StepModelCaller } from '../loop/types.js';
import type { ToolDefinition } from '../loop/engine.js';
import type { SubagentDefinition, SubagentRunOptions, SubagentRunResult } from './types.js';
import type { SubagentRegistry } from './registry.js';

/**
 * Minimal tool-execution surface used by the child loop.
 *
 * Defined structurally (rather than importing `AgentLoopEngine`) so the runner
 * can either drive a real engine or be exercised with a stub in tests, and so it
 * carries no dependency on a concrete session implementation.
 */
export interface SubagentToolExecutor {
  executeTool(
    toolCall: { id: string; name: string; args: Record<string, unknown> },
    messages?: unknown[]
  ): Promise<{ toolCallId: string; name: string; result: string; isError: boolean }>;
}

export interface SubagentRunnerOptions {
  /** Resolves a persona for a role. Defaults to a built-in registry. */
  registry: SubagentRegistry;
  /**
   * Builds a step caller for a persona. The runner calls this per invocation so
   * a child can run on its own model/route independently of the parent turn.
   */
  stepCaller: StepModelCaller | ((definition: SubagentDefinition) => StepModelCaller);
  /** Executes the child's tool calls. */
  toolExecutor: SubagentToolExecutor;
  /** Every tool the parent can offer; filtered per persona via `allowedTools`. */
  tools?: Record<string, ToolDefinition>;
  /** Fallback step budget when a persona does not set `maxSteps`. */
  defaultMaxSteps?: number;
  /** Appended to every persona's system prompt (e.g. shared engineering directives). */
  baseSystemPrompt?: string;
  /** Working directory handed to tool executors that need context. */
  workspaceDir?: string;
}

const DEFAULT_MAX_STEPS = 20;

/**
 * Executes one isolated child agent turn.
 *
 * Isolation is deliberate and total: the child gets a freshly assembled message
 * list on every step, never a reference to the parent's session. Nothing it does
 * is written back to the parent's message log — only the final text crosses the
 * boundary — so a deep child loop cannot pollute or bloat the parent's context.
 */
export class SubagentRunner {
  private readonly registry: SubagentRegistry;
  private readonly stepCaller: SubagentRunnerOptions['stepCaller'];
  private readonly toolExecutor: SubagentToolExecutor;
  private readonly tools: Record<string, ToolDefinition>;
  private readonly defaultMaxSteps: number;
  private readonly baseSystemPrompt: string;
  private readonly workspaceDir?: string;

  constructor(options: SubagentRunnerOptions) {
    this.registry = options.registry;
    this.stepCaller = options.stepCaller;
    this.toolExecutor = options.toolExecutor;
    this.tools = options.tools ?? {};
    this.defaultMaxSteps = options.defaultMaxSteps ?? DEFAULT_MAX_STEPS;
    this.baseSystemPrompt = options.baseSystemPrompt ?? '';
    this.workspaceDir = options.workspaceDir;
  }

  private resolveStepCaller(definition: SubagentDefinition): StepModelCaller {
    return typeof this.stepCaller === 'function' ? this.stepCaller(definition) : this.stepCaller;
  }

  /** Tools visible to a persona, filtered by its allowlist when it declares one. */
  public toolsFor(definition: SubagentDefinition): Record<string, ToolDefinition> {
    if (!definition.allowedTools || definition.allowedTools.length === 0) {
      return this.tools;
    }
    const allow = new Set(definition.allowedTools);
    const filtered: Record<string, ToolDefinition> = {};
    for (const [name, tool] of Object.entries(this.tools)) {
      if (allow.has(name)) filtered[name] = tool;
    }
    return filtered;
  }

  private buildSystemPrompt(definition: SubagentDefinition, options: SubagentRunOptions): string {
    const sections = [this.baseSystemPrompt.trim(), definition.systemPrompt.trim()].filter(Boolean);

    if (options.context && Object.keys(options.context).length > 0) {
      sections.push(
        '<context>\n' +
          `${JSON.stringify(options.context, null, 2)}\n` +
          '</context>'
      );
    }

    sections.push(
      'When you have completed the task, reply with your final synthesized ' +
        'result as plain text. The caller sees only that final message, so it must ' +
        'be self-contained and concise.'
    );

    return sections.join('\n\n');
  }

  public async run(options: SubagentRunOptions): Promise<SubagentRunResult> {
    const definition = this.registry.get(options.agent);

    if (!definition) {
      return {
        success: false,
        result: `Unknown subagent role '${options.agent}'.`,
        toolCallsCount: 0,
        stepsCount: 0,
        error: `Unknown subagent role '${options.agent}'. Available: ${this.registry
          .list()
          .map((d) => d.role)
          .join(', ')}`
      };
    }

    const system = this.buildSystemPrompt(definition, options);
    const tools = this.toolsFor(definition);
    const maxSteps = definition.maxSteps ?? this.defaultMaxSteps;
    // Isolated conversation history: local to this run, discarded on return.
    const messages: CoreMessage[] = [
      { role: 'user', content: options.prompt }
    ];

    let stepCaller: StepModelCaller;
    try {
      stepCaller = this.resolveStepCaller(definition);
    } catch (err: unknown) {
      return this.failure(err, 0, 0);
    }

    let stepsCount = 0;
    let toolCallsCount = 0;
    let lastText = '';

    try {
      while (stepsCount < maxSteps) {
        stepsCount++;

        const stepResult = await stepCaller.callStep({
          system,
          messages,
          tools: tools as unknown as Record<string, unknown>
        });

        lastText = stepResult.text;

        if (!stepResult.toolCalls || stepResult.toolCalls.length === 0) {
          return {
            success: true,
            result: lastText.trim() || '[Subagent produced no output]',
            toolCallsCount,
            stepsCount
          };
        }

        // Persist the child's assistant turn, including its tool calls, into the
        // child-local history so the next step sees what it requested.
        messages.push({
          role: 'assistant',
          content: stepResult.text
            ? [
                { type: 'text', text: stepResult.text },
                ...stepResult.toolCalls.map((tc) => ({
                  type: 'tool-call' as const,
                  toolCallId: tc.id,
                  toolName: tc.name,
                  args: tc.args
                }))
              ]
            : stepResult.toolCalls.map((tc) => ({
                type: 'tool-call' as const,
                toolCallId: tc.id,
                toolName: tc.name,
                args: tc.args
              }))
        });

        const toolResults: Array<{
          type: 'tool-result';
          toolCallId: string;
          toolName: string;
          result: string;
          isError: boolean;
        }> = [];

        for (const toolCall of stepResult.toolCalls) {
          toolCallsCount++;
          const record = await this.toolExecutor.executeTool(toolCall, messages);
          toolResults.push({
            type: 'tool-result',
            toolCallId: record.toolCallId,
            toolName: record.name,
            result: record.result,
            isError: record.isError
          });
        }

        messages.push({ role: 'tool', content: toolResults });
      }

      return {
        success: true,
        result: lastText.trim() || '[Subagent reached its step limit]',
        toolCallsCount,
        stepsCount
      };
    } catch (err: unknown) {
      return this.failure(err, stepsCount, toolCallsCount);
    }
  }

  private failure(err: unknown, stepsCount: number, toolCallsCount: number): SubagentRunResult {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      result: `[Subagent error]: ${message}`,
      toolCallsCount,
      stepsCount,
      error: message
    };
  }
}

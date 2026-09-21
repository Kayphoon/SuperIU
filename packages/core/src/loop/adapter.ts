import { streamText, type LanguageModelV1 } from 'ai';
import type {
  StepCallParams,
  StepExecutionResult,
  StepModelCaller,
  StepUsage
} from './types.js';
import type { ToolCallItem } from '../context/types.js';

export interface AiSdkStepAdapterOptions {
  /** Output budget for this route. See `effectiveMaxTokens` for why effort scales it. */
  maxTokens?: number;
  /** Provider reasoning effort, forwarded so thinking models can be budgeted correctly. */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export class AiSdkStepAdapter implements StepModelCaller {
  private model: LanguageModelV1;
  private options: AiSdkStepAdapterOptions;

  constructor(model: LanguageModelV1, options: AiSdkStepAdapterOptions = {}) {
    this.model = model;
    this.options = options;
  }

  public async callStep(params: StepCallParams): Promise<StepExecutionResult> {
    // Strip execute functions so AI SDK only declares tool schemas to the model
    // and never triggers automated execution. Execution authority belongs exclusively to AgentLoopEngine.
    const declarativeTools: Record<string, unknown> = {};
    if (params.tools) {
      for (const [name, def] of Object.entries(params.tools)) {
        if (def && typeof def === 'object') {
          const { execute: _omitted, ...declarativeDef } = def as Record<string, unknown>;
          declarativeTools[name] = declarativeDef;
        } else {
          declarativeTools[name] = def;
        }
      }
    }

    const stream = streamText({
      model: this.model,
      system: params.system,
      messages: params.messages,
      tools: declarativeTools as unknown as Parameters<typeof streamText>[0]['tools'],
      maxSteps: 1,
      abortSignal: params.signal,
      // A reasoning route spends output tokens on thinking before it emits an
      // answer; without the scaled budget the call can finish on `max-tokens`
      // with empty text. `maxTokens` is only sent when the route sets one.
      ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
      ...(this.options.reasoningEffort
        ? { providerOptions: { openai: { reasoningEffort: this.options.reasoningEffort } } }
        : {})
    });
    let fullText = '';
    const toolCalls: ToolCallItem[] = [];

    for await (const part of stream.fullStream) {
      if (params.signal?.aborted) {
        break;
      }

      switch (part.type) {
        case 'text-delta': {
          fullText += part.textDelta;
          params.onChunk?.(part.textDelta);
          break;
        }
        case 'reasoning': {
          if (part.textDelta) params.onReasoning?.(part.textDelta);
          break;
        }
        case 'tool-call': {
          const item: ToolCallItem = {
            id: part.toolCallId,
            name: part.toolName,
            args: (part.args as Record<string, unknown>) || {}
          };
          toolCalls.push(item);
          params.onToolCall?.(part.toolName, part.args);
          break;
        }
        case 'error': {
          const errorObj = part.error instanceof Error ? part.error : new Error(String(part.error));
          throw errorObj;
        }
      }
    }

    let finishReason: string | undefined;
    let usage: StepUsage | undefined;

    try {
      finishReason = await stream.finishReason;
      const rawUsage = await stream.usage;
      if (rawUsage) {
        usage = {
          promptTokens: rawUsage.promptTokens,
          completionTokens: rawUsage.completionTokens,
          totalTokens: rawUsage.totalTokens
        };
      }
    } catch {
      // Ignored if stream was aborted or usage not supported
    }

    return {
      text: fullText,
      toolCalls,
      finishReason,
      usage
    };
  }
}

export interface MockStepDefinition {
  text?: string;
  toolCalls?: ToolCallItem[];
  delayMs?: number;
  throwError?: Error;
}

export class MockStepAdapter implements StepModelCaller {
  private steps: MockStepDefinition[];
  private currentStepIndex = 0;

  constructor(steps: MockStepDefinition[] = []) {
    this.steps = [...steps];
  }

  public addStep(step: MockStepDefinition): void {
    this.steps.push(step);
  }

  public reset(): void {
    this.currentStepIndex = 0;
  }

  public async callStep(params: StepCallParams): Promise<StepExecutionResult> {
    if (params.signal?.aborted) {
      throw new Error('AbortError: The operation was aborted');
    }

    const step = this.steps[this.currentStepIndex] || {
      text: 'Mock response complete.',
      toolCalls: []
    };
    this.currentStepIndex++;

    if (step.delayMs && step.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, step.delayMs);
        params.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('AbortError: The operation was aborted'));
        }, { once: true });
      });
    }

    if (step.throwError) {
      throw step.throwError;
    }

    const text = step.text || '';
    if (text) {
      params.onChunk?.(text);
    }

    const toolCalls = step.toolCalls || [];
    for (const tc of toolCalls) {
      params.onToolCall?.(tc.name, tc.args);
    }

    return {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
    };
  }
}

import { streamText, type CoreMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import * as dotenv from 'dotenv';
import type {
  AgentStatus,
  EmotionState,
  RunnerCallbacks,
  RunnerConfig
} from './types.js';
import { createTools } from './tools/index.js';
import { loadLayeredMemory } from './memory/manager.js';
import {
  createInitialEmotion,
  decayEmotion,
  getEmotionPromptModifier,
  updateEmotionOnInteraction
} from './emotion/engine.js';

export class AgentRunner {
  public status: AgentStatus = 'idle';
  public emotion: EmotionState;
  public messages: CoreMessage[] = [];
  public config: RunnerConfig;
  private currentAbortController: AbortController | null = null;

  constructor(config: RunnerConfig = {}) {
    dotenv.config();
    this.config = {
      workspaceDir: process.cwd(),
      ...config
    };
    this.emotion = createInitialEmotion();
  }

  private setStatus(newStatus: AgentStatus, callbacks?: RunnerCallbacks) {
    if (this.status !== newStatus) {
      this.status = newStatus;
      callbacks?.onStatusChange?.(newStatus);
    }
  }

  public abort(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    this.status = 'idle';
  }

  public reset(): void {
    this.abort();
    this.messages = [];
    this.emotion = createInitialEmotion();
    this.status = 'idle';
  }

  public async run(prompt: string, callbacks?: RunnerCallbacks): Promise<string> {
    if (this.status !== 'idle') {
      this.abort();
    }

    this.setStatus('running', callbacks);
    this.currentAbortController = new AbortController();
    const signal = this.currentAbortController.signal;

    try {
      // 1. Refresh emotion decay & layered memory
      this.emotion = decayEmotion(this.emotion);
      const memoryContext = await loadLayeredMemory(this.config.memoryDir);
      const postureModifier = getEmotionPromptModifier(this.emotion);

      const systemPrompt = [
        memoryContext,
        postureModifier,
        '\n# INSTRUCTIONS',
        '- You are a competent, pragmatic autonomous software engineer.',
        '- Solve problems using available bash and file tools.',
        '- Keep responses evidence-based and grounded in actual tool outputs.'
      ]
        .filter(Boolean)
        .join('\n\n');

      // 2. Append user prompt to history
      this.messages.push({ role: 'user', content: prompt });

      // 3. Resolve model client
      const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY || 'placeholder-key';
      const baseURL = this.config.baseURL || process.env.OPENAI_BASE_URL;
      const modelName = this.config.modelName || process.env.OPENAI_MODEL_NAME || 'gpt-4o';

      const openai = createOpenAI({
        apiKey,
        baseURL
      });

      const model = openai(modelName);

      // 4. Create tools with current signal
      const tools = createTools({
        workspaceDir: this.config.workspaceDir,
        spilloverDir: this.config.spilloverDir,
        getSignal: () => this.currentAbortController?.signal
      });

      this.setStatus('thinking', callbacks);

      const stream = streamText({
        model,
        system: systemPrompt,
        messages: this.messages,
        tools,
        maxSteps: this.config.maxSteps ?? 10,
        abortSignal: signal
      });

      let fullResponseText = '';

      for await (const part of stream.fullStream) {
        if (signal.aborted) {
          break;
        }

        switch (part.type) {
          case 'text-delta': {
            this.setStatus('streaming', callbacks);
            fullResponseText += part.textDelta;
            callbacks?.onChunk?.(part.textDelta);
            break;
          }
          case 'tool-call': {
            this.setStatus('tool_calling', callbacks);
            callbacks?.onToolCall?.(part.toolName, part.args);
            break;
          }
          case 'tool-result': {
            callbacks?.onToolResult?.(part.toolName, part.result);
            this.emotion = updateEmotionOnInteraction(this.emotion, {
              fatigueDelta: 0.05,
              arousalDelta: 0.02
            });
            break;
          }
          case 'error': {
            const errorObj = part.error instanceof Error ? part.error : new Error(String(part.error));
            callbacks?.onError?.(errorObj);
            break;
          }
        }
      }

      if (signal.aborted) {
        this.setStatus('aborted', callbacks);
        this.setStatus('idle', callbacks);
        return '[Task aborted by user]';
      }

      // 5. Append response to history
      const response = await stream.response;
      if (response && Array.isArray(response.messages) && response.messages.length > 0) {
        this.messages.push(...response.messages);
      } else if (fullResponseText) {
        this.messages.push({ role: 'assistant', content: fullResponseText });
      }

      this.setStatus('completed', callbacks);
      this.setStatus('idle', callbacks);
      return fullResponseText;
    } catch (err: unknown) {
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') || Boolean(signal.aborted);

      if (isAbort) {
        this.setStatus('aborted', callbacks);
        this.setStatus('idle', callbacks);
        return '[Task aborted by user]';
      }

      this.setStatus('error', callbacks);
      this.setStatus('idle', callbacks);

      const errorObj = err instanceof Error ? err : new Error(String(err));
      callbacks?.onError?.(errorObj);
      throw errorObj;
    } finally {
      this.currentAbortController = null;
    }
  }
}

import type { CoreMessage, CoreAssistantMessage, CoreToolMessage, CoreUserMessage, CoreSystemMessage } from 'ai';
import type { SessionManager } from '../session/manager.js';
import type { ContextMessage, AssembledContext, ToolCallItem, ToolResultItem } from './types.js';
import { SystemPromptBuilder } from './builder.js';
import { ContextCompactor } from './compactor.js';

export interface ContextAssemblerOptions {
  session: SessionManager;
  promptBuilder?: SystemPromptBuilder;
  compactor?: ContextCompactor;
  workspaceDir?: string;
  memoryDir?: string;
  customInstructions?: string;
  /** Optional posture modifier (e.g. emotion state) appended to the system prompt. */
  getPostureModifier?: () => string;
}

export interface AssembleOptions {
  leafId?: string | null;
  limit?: number;
}

export class ContextAssembler {
  public session: SessionManager;
  public promptBuilder: SystemPromptBuilder;
  public compactor: ContextCompactor;
  public getPostureModifier?: () => string;

  constructor(options: ContextAssemblerOptions) {
    this.session = options.session;
    this.getPostureModifier = options.getPostureModifier;
    this.promptBuilder =
      options.promptBuilder ||
      new SystemPromptBuilder({
        workspaceDir: options.workspaceDir,
        memoryDir: options.memoryDir,
        customInstructions: options.customInstructions
      });
    this.compactor = options.compactor || new ContextCompactor();
  }

  /**
   * Assemble one model step: dynamic system prompt + the active branch's linear
   * message history reconstructed from the JSONL session tree.
   */
  public async assemble(
    options: AssembleOptions = {}
  ): Promise<AssembledContext & { coreMessages: CoreMessage[] }> {
    const workstation = this.promptBuilder.workstationInfo();
    const basePrompt = await this.promptBuilder.build();
    const posture = this.getPostureModifier?.() ?? '';
    const systemPrompt = posture ? `${basePrompt}\n${posture}` : basePrompt;

    const branchMessages = this.session.buildSessionContext(options.leafId);
    const windowed =
      options.limit && options.limit > 0 && options.limit < branchMessages.length
        ? branchMessages.slice(branchMessages.length - options.limit)
        : branchMessages;

    const compactedMessages = this.compactor.pruneHistory(windowed);
    const coreMessages = this.toCoreMessages(compactedMessages);

    return {
      systemPrompt,
      workstation,
      messages: compactedMessages,
      coreMessages
    };
  }

  public toCoreMessages(messages: ContextMessage[]): CoreMessage[] {
    const coreMessages: CoreMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        coreMessages.push({
          role: 'user',
          content: msg.content ?? ''
        } as CoreUserMessage);
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const parts: Array<
            | { type: 'text'; text: string }
            | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
          > = [];

          if (msg.content) {
            parts.push({ type: 'text', text: msg.content });
          }

          for (const tc of msg.toolCalls) {
            parts.push({
              type: 'tool-call',
              toolCallId: tc.id,
              toolName: tc.name,
              args: tc.args
            });
          }

          coreMessages.push({
            role: 'assistant',
            content: parts
          } as CoreAssistantMessage);
        } else {
          coreMessages.push({
            role: 'assistant',
            content: msg.content ?? ''
          } as CoreAssistantMessage);
        }
      } else if (msg.role === 'tool') {
        if (msg.toolResults && msg.toolResults.length > 0) {
          coreMessages.push({
            role: 'tool',
            content: msg.toolResults.map((tr) => ({
              type: 'tool-result',
              toolCallId: tr.toolCallId,
              toolName: tr.name,
              result: tr.result,
              isError: tr.isError
            }))
          } as CoreToolMessage);
        }
      } else if (msg.role === 'system') {
        coreMessages.push({
          role: 'system',
          content: msg.content ?? ''
        } as CoreSystemMessage);
      }
    }

    return coreMessages;
  }

  public fromCoreMessage(msg: CoreMessage): Omit<ContextMessage, 'id' | 'createdAt'> {
    if (msg.role === 'user') {
      return {
        role: 'user',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      };
    }

    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        return {
          role: 'assistant',
          content: msg.content
        };
      }

      let text = '';
      const toolCalls: ToolCallItem[] = [];

      for (const part of msg.content) {
        if (part.type === 'text') {
          text += part.text;
        } else if (part.type === 'tool-call') {
          toolCalls.push({
            id: part.toolCallId,
            name: part.toolName,
            args: (part.args as Record<string, unknown>) || {}
          });
        }
      }

      return {
        role: 'assistant',
        content: text || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined
      };
    }

    if (msg.role === 'tool') {
      const toolResults: ToolResultItem[] = [];
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          toolResults.push({
            toolCallId: part.toolCallId,
            name: part.toolName,
            result: part.result,
            isError: part.isError
          });
        }
      }

      return {
        role: 'tool',
        toolResults
      };
    }

    return {
      role: 'system',
      content: msg.content
    };
  }
}

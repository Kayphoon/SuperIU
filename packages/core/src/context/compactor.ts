import { handleSpillover } from '../spillover.js';
import type { ContextMessage, ToolResultItem } from './types.js';

export interface CompactorOptions {
  maxCharsPerToolResult?: number;
  spilloverDir?: string;
  maxRetainedMessages?: number;
  compactOldToolResultsThreshold?: number;
}

export class ContextCompactor {
  private maxCharsPerToolResult: number;
  private spilloverDir?: string;
  private maxRetainedMessages: number;
  private compactOldToolResultsThreshold: number;

  constructor(options: CompactorOptions = {}) {
    this.maxCharsPerToolResult = options.maxCharsPerToolResult ?? 2000;
    this.spilloverDir = options.spilloverDir;
    this.maxRetainedMessages = options.maxRetainedMessages ?? 60;
    this.compactOldToolResultsThreshold = options.compactOldToolResultsThreshold ?? 20;
  }

  public async compactToolResult(
    rawResult: unknown,
    overrideSpillDir?: string
  ): Promise<{ text: string; spilled: boolean; filePath?: string }> {
    let strValue: string;
    if (typeof rawResult === 'string') {
      strValue = rawResult;
    } else if (rawResult === null || rawResult === undefined) {
      strValue = '';
    } else {
      try {
        strValue = JSON.stringify(rawResult, null, 2);
      } catch {
        strValue = String(rawResult);
      }
    }

    const spillDir = overrideSpillDir || this.spilloverDir;
    const spillResult = await handleSpillover(strValue, spillDir, this.maxCharsPerToolResult);

    return {
      text: spillResult.content,
      spilled: spillResult.spilled,
      filePath: spillResult.filePath
    };
  }

  public pruneHistory(messages: ContextMessage[]): ContextMessage[] {
    if (messages.length <= this.compactOldToolResultsThreshold) {
      return messages;
    }

    // Retain initial 2 messages (e.g. system/initial task prompt) and last N messages
    const recentWindowStart = Math.max(2, messages.length - this.maxRetainedMessages);

    return messages.map((msg, idx) => {
      // Don't compact messages in the recent window or the very first messages
      if (idx < 2 || idx >= recentWindowStart) {
        return msg;
      }

      // In older middle messages, compact bulky tool results
      if (msg.role === 'tool' && msg.toolResults && msg.toolResults.length > 0) {
        const compactedResults: ToolResultItem[] = msg.toolResults.map((tr) => {
          const resStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
          if (resStr && resStr.length > 300) {
            return {
              ...tr,
              result: `${resStr.slice(0, 150)}... [Omitted ${resStr.length - 150} chars of older step output]`
            };
          }
          return tr;
        });

        return {
          ...msg,
          toolResults: compactedResults
        };
      }

      return msg;
    });
  }
}

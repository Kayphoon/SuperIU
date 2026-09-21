import type { AutoReviewMode } from './review/types.js';

export type AgentStatus =
  | 'idle'
  | 'running'
  | 'thinking'
  | 'tool_calling'
  | 'streaming'
  | 'completed'
  | 'aborted'
  | 'error';

export interface RunnerCallbacks {
  onStatusChange?: (status: AgentStatus) => void;
  onStepStart?: (stepIndex: number) => void;
  onChunk?: (text: string) => void;
  /** Model reasoning/thinking deltas, when the provider streams them. */
  onReasoning?: (text: string) => void;
  onToolCall?: (toolName: string, args: unknown) => void;
  onToolResult?: (toolName: string, result: unknown, isError?: boolean) => void;
  onError?: (error: Error) => void;
}

export interface RunnerConfig {
  apiKey?: string;
  baseURL?: string;
  /** Main agent model. Defaults to `OPENAI_MODEL_NAME` then `gpt-4o`. */
  modelName?: string;
  /** Review/tool model used by AutoReview. Defaults to `OPENAI_REVIEW_MODEL_NAME`, then the main model. */
  reviewModelName?: string;
  /** Enable the automatic approval gate. Defaults to true. */
  autoReview?: boolean;
  /** Posture for tool calls the rule engine cannot classify. Defaults to `lenient`. */
  autoReviewMode?: AutoReviewMode;
  workspaceDir?: string;
  spilloverDir?: string;
  memoryDir?: string;
  maxSteps?: number;
  /** Session file path or session id to resume; newest workspace session when omitted. */
  sessionId?: string;
  /** Prompt history database path. Defaults to `<cwd>/.myagent/history.db`. */
  historyDbPath?: string;
  /** Force a fresh session instead of resuming the newest one. */
  newSession?: boolean;
  customInstructions?: string;
}

export interface SpilloverResult {
  content: string;
  spilled: boolean;
  filePath?: string;
}

export interface MemoryPaths {
  soulPath: string;
  userPath: string;
  memoryPath: string;
}

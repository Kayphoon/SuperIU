export type AgentStatus =
  | 'idle'
  | 'running'
  | 'thinking'
  | 'tool_calling'
  | 'streaming'
  | 'completed'
  | 'aborted'
  | 'error';

export interface EmotionState {
  valence: number; // [-1.0, 1.0], negative to positive
  arousal: number; // [0.0, 1.0], calm to excited/agitated
  fatigue: number; // [0.0, 1.0], energetic to exhausted
  lastUpdate: number; // millisecond timestamp
}

export interface RunnerCallbacks {
  onStatusChange?: (status: AgentStatus) => void;
  onChunk?: (text: string) => void;
  onToolCall?: (toolName: string, args: unknown) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
  onError?: (error: Error) => void;
}

export interface RunnerConfig {
  apiKey?: string;
  baseURL?: string;
  modelName?: string;
  workspaceDir?: string;
  spilloverDir?: string;
  memoryDir?: string;
  maxSteps?: number;
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

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallItem {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultItem {
  toolCallId: string;
  name: string;
  result: unknown;
  isError?: boolean;
}

export interface ContextMessage {
  id: string;
  role: MessageRole;
  content?: string;
  toolCalls?: ToolCallItem[];
  toolResults?: ToolResultItem[];
  createdAt: number;
}

export interface WorkstationInfo {
  os: string;
  arch: string;
  nodeVersion: string;
  cwd: string;
  gitBranch?: string;
  timestamp: string;
}

export interface LayeredDirectives {
  soul?: string;
  memory?: string;
  user?: string;
  customInstructions?: string;
}

export interface AssembledContext {
  systemPrompt: string;
  messages: ContextMessage[];
  workstation: WorkstationInfo;
}

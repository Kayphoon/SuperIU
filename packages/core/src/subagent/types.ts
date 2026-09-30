/**
 * Subagent dispatch types.
 *
 * A subagent is a specialized child agent persona invoked by the main agent
 * through a single `subagent` tool call. It runs an isolated loop turn with its
 * own conversation history so its chatter never lands in the parent session.
 */

/**
 * Well-known specialist roles. The union is intentionally open (`| string`) so
 * embedders can register custom personas without editing this file, while the
 * built-in names still autocomplete.
 */
export type SubagentRole =
  | 'explorer'
  | 'fixer'
  | 'designer'
  | 'librarian'
  | 'oracle'
  | (string & {});

/** A persona definition: who the child is and which tools it may use. */
export interface SubagentDefinition {
  role: SubagentRole;
  /** Short display label, e.g. `Explorer`. */
  name: string;
  /** One-line description used to advertise the role to the parent model. */
  description: string;
  /** The child agent's system prompt. */
  systemPrompt: string;
  /**
   * Optional allowlist of tool names the child may use. `undefined` means the
   * child inherits every tool the parent exposes.
   */
  allowedTools?: string[];
  /** Step budget for the child loop. Defaults to a bounded, small value. */
  maxSteps?: number;
}

/** A single dispatch request. */
export interface SubagentRunOptions {
  /** Target specialist role. */
  agent: SubagentRole;
  /** The specific, bounded task or question for the child. */
  prompt: string;
  /** Optional structured context handed to the child alongside the prompt. */
  context?: Record<string, unknown>;
}

/** Outcome of one subagent turn. */
export interface SubagentRunResult {
  success: boolean;
  /** Concise synthesized result text for the parent agent to consume. */
  result: string;
  toolCallsCount: number;
  stepsCount: number;
  error?: string;
}

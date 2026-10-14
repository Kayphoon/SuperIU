import type { ToolCallItem } from '../context/types.js';

export type ReviewDecision = 'allow' | 'deny' | 'ask_user';
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/** Review posture applied when the rule engine cannot decide on its own. */
export type AutoReviewMode = 'lenient' | 'strict';

export interface ReviewResult {
  decision: ReviewDecision;
  riskLevel: RiskLevel;
  reason: string;
  reviewedBy: 'rule' | 'model';
  suggestedPattern?: string;
}

export interface ToolReviewContext {
  toolCall: ToolCallItem;
  workspaceDir: string;
  signal?: AbortSignal;
}

export interface IAutoReviewer {
  review(ctx: ToolReviewContext): Promise<ReviewResult>;
  rememberSessionRule?(tool: string, pattern: string): void;
  matchesSessionRule?(toolCall: ToolCallItem): boolean;
  clearSessionRules?(): void;
}

export type PermissionVerdict =
  | { approved: boolean; remember?: 'session' }
  | boolean;

/**
 * Interactive resolution channel for `ask_user` verdicts.
 *
 * Invoked only when AutoReview escalates a call. Resolve `true` (or `{ approved: true }`)
 * to execute the tool as-is, `false` to reject it; `{ approved: true, remember: 'session' }`
 * records the session pattern rule to skip subsequent prompts.
 */
export type PermissionGate = (
  toolCall: ToolCallItem,
  review: ReviewResult
) => Promise<PermissionVerdict>;

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
}

export interface ToolReviewContext {
  toolCall: ToolCallItem;
  workspaceDir: string;
  signal?: AbortSignal;
}

export interface IAutoReviewer {
  review(ctx: ToolReviewContext): Promise<ReviewResult>;
}

/**
 * Interactive resolution channel for `ask_user` verdicts.
 *
 * Invoked only when AutoReview escalates a call. Resolve `true` to execute the
 * tool as-is, `false` to reject it; the loop records the rejection and keeps
 * running so the agent can adapt. A host (UI, CLI prompt) implements this by
 * parking the promise until the human answers — it MUST also resolve `false`
 * when the turn is aborted or the client disconnects, or the loop will wait
 * forever.
 */
export type PermissionGate = (
  toolCall: ToolCallItem,
  review: ReviewResult
) => Promise<boolean>;

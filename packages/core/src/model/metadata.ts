/**
 * Model capability metadata: context window, modality, and tool support.
 *
 * The context window is what a shell's usage meter divides against, so the
 * stakes are real: a meter that understates the window shows a false "nearly
 * full" warning, and one that overstates it hides the truncation that is about
 * to happen. These rows are the best current reading of each vendor's
 * documentation rather than a certified figure — a minority carry an inline
 * citation to the publisher, and a row without one is a working number to
 * re-check against the vendor before treating it as authoritative.
 */

import type { ContextMessage } from '../context/types.js';

export interface ModelMetadata {
  /** Whether the model accepts image input. */
  vision: boolean;
  /** Whether the model accepts a tool/function schema. */
  tools: boolean;
  /** Published context window, in tokens. */
  contextLimit: number;
  /** `contextLimit` in the short form a shell prints (`256K`, `1M`, `2M`). */
  formattedContext: string;
}

interface ModelMetadataRow {
  /** Tested against the normalized model id; first match wins. */
  pattern: RegExp;
  contextLimit: number;
  vision: boolean;
  tools: boolean;
}

/**
 * A model that matches no row gets {@link DEFAULT_MODEL_METADATA} — 128K with
 * tools and no vision. `qwen-max` is the clearest example of a model that needs
 * no row: 128K, tool-capable, text-only is exactly what it is (Alibaba lists it
 * under Legacy with thinking mode unsupported), so a row would restate the
 * default and read as though it were load-bearing.
 *
 * First match wins, so a family row sits BELOW the tiers that deviate from it.
 * Every Gemini tier is 1M except `gemini-1.5-pro` (2M) — Google publishes the
 * exact 1,048,576 for those tiers, and the table deliberately carries the
 * rounded 1M for all of them alike, so no Gemini tier needs its own row. The
 * Anthropic 5-series is 1M except Haiku, which is why the family row alone
 * cannot express that table.
 */
const MODEL_METADATA_ROWS: readonly ModelMetadataRow[] = [
  { pattern: /^gemini-1\.5-pro/, contextLimit: 2_000_000, vision: true, tools: true },
  // Covers gemini-1.5-flash, gemini-2.0-*, gemini-2.5-*, gemini-3.5-flash-lite.
  { pattern: /^gemini/, contextLimit: 1_000_000, vision: true, tools: true },
  // The Claude 5 generation moved to 1M (Fable 5.1, Opus 5.5, Sonnet 5); Haiku
  // 4.5 stayed on the 200K row below, and every retired 3.x tier did too.
  { pattern: /^claude-(fable|opus|sonnet)-5/, contextLimit: 1_000_000, vision: true, tools: true },
  // Covers claude-3, claude-3-5, claude-3-7, claude-4, and claude-haiku-4-5.
  { pattern: /^claude/, contextLimit: 200_000, vision: true, tools: true },
  { pattern: /^gpt-4o/, contextLimit: 128_000, vision: true, tools: true },
  { pattern: /^gpt-4\.1/, contextLimit: 128_000, vision: true, tools: true },
  // GPT-5.6 and GPT-6 widened the window to 1.05M. Earlier GPT-5 tiers are
  // deliberately unpinned: their published windows were not re-verified here,
  // and guessing one would move a model off the 128K default on no evidence.
  { pattern: /^gpt-5\.6/, contextLimit: 1_050_000, vision: true, tools: true },
  { pattern: /^gpt-6/, contextLimit: 1_050_000, vision: true, tools: true },
  // o1-mini / o1-preview are the o-series that accept neither images nor tools.
  { pattern: /^o1-(mini|preview)/, contextLimit: 200_000, vision: false, tools: false },
  { pattern: /^o1/, contextLimit: 200_000, vision: true, tools: true },
  { pattern: /^o3-mini/, contextLimit: 200_000, vision: false, tools: true },
  // Any other o-series tier (o3, o4, ...) reasons on a 200K window.
  { pattern: /^o[1-9]/, contextLimit: 200_000, vision: false, tools: true },
  // Both current DeepSeek ids are 1M; only the Flash tier takes images, per the
  // vendor's vision guide ("The `deepseek-flash` model accepts images") against
  // the pricing table's "Not supported" for V4-Pro.
  { pattern: /^deepseek-flash/, contextLimit: 1_000_000, vision: true, tools: true },
  { pattern: /^deepseek-v4-pro/, contextLimit: 1_000_000, vision: false, tools: true },
  // Qwen 3.8/3.7 (max, plus, flash) are 1M and take images/video (qwen3.8-max
  // model page lists input modality "Image Text Video"); legacy `qwen-max` is
  // 128K text-only and falls through to the default below.
  { pattern: /^qwen3\.[78]/, contextLimit: 1_000_000, vision: true, tools: true },
  // Kimi K3 is 1M (1,048,576); the K2.x coding tiers are 256K.
  { pattern: /^kimi-k3/, contextLimit: 1_000_000, vision: true, tools: true },
  { pattern: /^kimi-k2/, contextLimit: 256_000, vision: true, tools: true }
];

const DEFAULT_MODEL_METADATA = {
  contextLimit: 128_000,
  vision: false,
  tools: true
} as const;

/**
 * Strip the decoration a provider adds to the id it was asked for — an
 * OpenAI-compatible endpoint answers `models/gemini-2.5-flash` or
 * `openai/gpt-4o` depending on the gateway in front of it — so the table below
 * matches on the model's own name and never on the routing prefix.
 */
function normalizeModelId(model: string): string {
  const lastSegment = model.trim().toLowerCase().split('/').pop() ?? '';
  return lastSegment.trim();
}

/** Capability metadata for `model`; an unknown model gets the documented default. */
export function modelMetadataFor(model: string): ModelMetadata {
  const id = normalizeModelId(model);
  const row = MODEL_METADATA_ROWS.find((candidate) => candidate.pattern.test(id));
  const contextLimit = row?.contextLimit ?? DEFAULT_MODEL_METADATA.contextLimit;
  return {
    vision: row?.vision ?? DEFAULT_MODEL_METADATA.vision,
    tools: row?.tools ?? DEFAULT_MODEL_METADATA.tools,
    contextLimit,
    formattedContext: formatContextLimit(contextLimit)
  };
}

/** `256000` → `256K`, `1000000` → `1M`, `2000000` → `2M`. */
export function formatContextLimit(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/**
 * Rough token cost of a message list, for the window between resuming a session
 * and its first step — no provider usage exists yet, but the branch does, and a
 * meter showing an empty context for a loaded conversation is worse than one
 * showing a coarse estimate. English prose runs about 3.5 characters per token
 * across these providers' tokenizers.
 */
export function estimateContextTokens(messages: readonly ContextMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content?.length ?? 0;
    if (message.toolCalls) chars += JSON.stringify(message.toolCalls).length;
    if (message.toolResults) chars += JSON.stringify(message.toolResults).length;
  }
  return Math.round(chars / 3.5);
}

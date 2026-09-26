/**
 * Role-based model routing.
 *
 * The agent runs several distinct jobs — the main loop, the AutoReview gate, and
 * any auxiliary work such as titling or memory synthesis — and they should not
 * all share one model. A model must never approve its own actions, and an
 * auxiliary job should be able to run on something cheaper than the main loop.
 *
 * `ModelRouter` maps a `ModelRole` to a `ModelRoute`, with a default route as the
 * fallback for any role that has no explicit route.
 *
 * @module model/router
 */

export type ModelRole = 'main' | 'review' | 'title' | 'memory';

export const MODEL_ROLES: readonly ModelRole[] = ['main', 'review', 'title', 'memory'];

/** Provider reasoning effort. Higher effort reasons for longer and needs more output budget. */
export type ReasoningEffort = 'low' | 'medium' | 'high';

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

export interface ModelRoute {
  provider?: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
}

export interface ModelRouterOptions {
  defaultRoute: ModelRoute;
  routes?: Partial<Record<ModelRole, ModelRoute>>;
  /**
   * Effort a route inherits when it names none — typically
   * {@link DEFAULT_REASONING_EFFORT}. It lives here rather than inside
   * `defaultRoute` so it stays distinguishable from an effort the operator
   * explicitly configured, and so per-turn overrides can re-resolve it.
   */
  defaultReasoningEffort?: ReasoningEffort;
}

/**
 * Effort a reasoning-capable route gets when nothing names one.
 *
 * `medium` is the middle of the ladder the provider documents, so a thinking
 * model reasons meaningfully without paying the `high` budget on every turn.
 * Non-reasoning models never see it — see {@link supportsReasoningEffort}.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';

/**
 * Reasoning model families that accept a `reasoning_effort` parameter.
 *
 * Each entry is a family whose own documentation states that it takes the
 * parameter, because the guard is an allowlist and a missing family only costs
 * the default effort, while a wrong one costs the turn:
 *
 *   - OpenAI `o`-series and `gpt-5` and later. GPT-6 is covered explicitly:
 *     `gpt-6-astra`'s own model page lists `reasoning.effort` support, and the
 *     reasoning guide documents the `reasoning_effort` form on Chat Completions
 *     (only `none` is rejected, with HTTP 400), so a catalog that offers it
 *     would otherwise show an empty effort pill for its flagship.
 *   - Gemini's 3 and 2.5 series. Its OpenAI-compatibility endpoint maps
 *     `reasoning_effort` onto `thinking_level` / `thinking_budget`
 *     (<https://ai.google.dev/gemini-api/docs/openai>). The 1.5 and 2.0 series
 *     predate thinking entirely — the thinking guide scopes itself to "the
 *     Gemini 3 and 2.5 series models" — so they are deliberately absent rather
 *     than merely unmatched.
 *   - DeepSeek's current ids, which document `reasoning_effort` on their
 *     OpenAI-format surface (<https://api-docs.deepseek.com/guides/thinking_mode>).
 *     The retired `deepseek-chat` / `deepseek-reasoner` names are absent: they
 *     stopped being valid `model` values in July 2026, so there is no request
 *     left for the parameter to control.
 */
const REASONING_MODEL_PATTERNS: readonly RegExp[] = [
  /^o[1-9]/,
  /^gpt-5/,
  /^gpt-6/,
  /^gemini-3/,
  /^gemini-2\.5/,
  /^deepseek-flash/,
  /^deepseek-v4-pro/
];

/**
 * Reasoning models that predate `reasoning_effort` and reject the parameter.
 *
 * `o1-mini` / `o1-preview` are reasoning models, but they shipped before the
 * control existed and answer a request carrying it with an unknown-parameter
 * error, so they must not be sent one. They are the only family that both
 * matches an accepting pattern and refuses the parameter; every other tier this
 * module excludes is excluded by not being in the allowlist above.
 */
const EFFORT_INCAPABLE_PATTERNS: readonly RegExp[] = [/^o1-(mini|preview)/];

/**
 * Whether `model` accepts a `reasoning_effort` request parameter.
 *
 * The parameter is not a harmless hint: a model that does not reason rejects it
 * with HTTP 400 (`Unsupported value: 'reasoning_effort' ... with this model`).
 * So the default effort is only ever attached to a model this returns true for,
 * which is what keeps a non-reasoning main or review model working unchanged.
 * An unrecognized model is treated as incapable — the conservative direction,
 * since omitting the parameter merely means no reasoning, while sending it to
 * the wrong model fails the whole turn.
 *
 * A vendor prefix (`openai/o3-mini`, `openrouter/gpt-5`) is ignored.
 */
export function supportsReasoningEffort(model: string): boolean {
  const modelId = model.trim().toLowerCase().split('/').pop() ?? '';
  if (EFFORT_INCAPABLE_PATTERNS.some((pattern) => pattern.test(modelId))) {
    return false;
  }
  return REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

/**
 * Parse a configured effort value.
 *
 * Surrounding whitespace and case are tolerated; anything that is not one of
 * the three supported levels is ignored (`undefined`) rather than rejected, so
 * a typo in `.env` degrades to the derived default instead of failing startup.
 */
export function parseReasoningEffort(value: string | undefined | null): ReasoningEffort | undefined {
  const normalized = value?.trim().toLowerCase();
  return REASONING_EFFORTS.find((effort) => effort === normalized);
}

/**
 * Output budget for a route that does not name one.
 *
 * Reasoning models spend output tokens on chain-of-thought BEFORE emitting the
 * answer. With a tight cap the budget is exhausted mid-reasoning, the response
 * finishes with `max-tokens`, and the caller receives an empty string — for the
 * review role that means a missing verdict that looks like a silent failure.
 */
export const DEFAULT_MAX_TOKENS = 2048;

/** Ceiling for effort-scaled budgets, so a high-effort route cannot request an absurd cap. */
export const MAX_TOKENS_CAP = 16_384;

/**
 * Output budget multiplier per reasoning effort.
 *
 * `low` is the base budget; higher effort reasons for longer, so it needs
 * proportionally more room. With the 2048 base this reproduces the familiar
 * 2048 / 4096 / 8192 ladder.
 */
const EFFORT_MULTIPLIER: Record<NonNullable<ModelRoute['reasoningEffort']>, number> = {
  low: 1,
  medium: 2,
  high: 4
};

/**
 * Effective output budget for a route: its own `maxTokens` (or the default base)
 * scaled by reasoning effort, clamped to {@link MAX_TOKENS_CAP}.
 *
 * An explicit `maxTokens` is treated as the base for the multiplier rather than
 * a final value, so a route can raise its ceiling and still scale with effort.
 *
 * Expects an UNSCALED route. Feeding it an already-resolved route multiplies the
 * effort twice; {@link ModelRouter.finalize} is the single place that scales.
 */
export function effectiveMaxTokens(route: Pick<ModelRoute, 'reasoningEffort' | 'maxTokens'>): number {
  const base = route.maxTokens && route.maxTokens > 0 ? route.maxTokens : DEFAULT_MAX_TOKENS;
  const multiplier = route.reasoningEffort ? EFFORT_MULTIPLIER[route.reasoningEffort] : 1;
  return Math.min(Math.round(base * multiplier), MAX_TOKENS_CAP);
}

/**
 * Merge a partial route over a base, field by field.
 *
 * Spreading a `Partial<ModelRoute>` widens every field to `T | undefined`, which
 * loses the `model: string` guarantee. Merging explicitly keeps the required
 * field required and makes the inheritance rule (patch wins, otherwise base)
 * obvious at a glance.
 */
function mergeRoute(base: ModelRoute, patch?: Partial<ModelRoute>): ModelRoute {
  return {
    provider: patch?.provider ?? base.provider,
    model: patch?.model ?? base.model,
    apiKey: patch?.apiKey ?? base.apiKey,
    baseURL: patch?.baseURL ?? base.baseURL,
    reasoningEffort: patch?.reasoningEffort ?? base.reasoningEffort,
    maxTokens: patch?.maxTokens ?? base.maxTokens
  };
}

/**
 * Resolve model roles to concrete routes.
 *
 * Unspecified fields on a role route are inherited from the default route, so a
 * role only has to name what differs (usually just the model).
 */
export class ModelRouter {
  private defaultRoute: ModelRoute;
  /** Per-role overlays: only explicitly-set fields, inherited fields stay unset. */
  private readonly routes: Partial<Record<ModelRole, Partial<ModelRoute>>>;
  private readonly defaultReasoningEffort?: ReasoningEffort;

  constructor(options: ModelRouterOptions) {
    this.defaultRoute = { ...options.defaultRoute };
    this.routes = { ...(options.routes ?? {}) };
    this.defaultReasoningEffort = options.defaultReasoningEffort;
  }

  /**
   * Merge a role's route over the default WITHOUT scaling the budget.
   *
   * `maxTokens` here is the unscaled base, and `reasoningEffort` is the raw
   * configured value. Callers that need a sendable route go through
   * {@link finalize}; the split exists so a per-turn override can be merged onto
   * an unscaled base and still be scaled exactly once.
   */
  public resolveBase(role: ModelRole): ModelRoute {
    return mergeRoute(this.defaultRoute, this.routes[role]);
  }

  /**
   * Turn an unscaled route into a sendable one: apply the default effort where
   * the model supports it, then scale the budget for that effort exactly once.
   *
   * This is the ONLY place `effectiveMaxTokens` is applied. Scaling anywhere
   * else — in particular over an already-resolved route — multiplies the effort
   * a second time and silently inflates the budget (medium 4096 becomes 8192).
   */
  public finalize(route: ModelRoute): ModelRoute {
    const reasoningEffort =
      route.reasoningEffort ??
      (supportsReasoningEffort(route.model) ? this.defaultReasoningEffort : undefined);
    const withEffort = { ...route, reasoningEffort };
    return { ...withEffort, maxTokens: effectiveMaxTokens(withEffort) };
  }

  /**
   * Resolve a role to a concrete route. The returned object is a fresh copy with
   * `maxTokens` already scaled for `reasoningEffort`, so callers can pass it
   * straight to a provider without further adjustment.
   */
  public resolve(role: ModelRole): ModelRoute {
    return this.finalize(this.resolveBase(role));
  }

  /**
   * Merge a partial route into one role, leaving every other field intact.
   *
   * Only the explicitly-set fields are stored. Anything not set keeps tracking
   * the default route, so changing the default (for example when the user picks
   * a different main model) propagates to every role that did not override it.
   * Storing the resolved route instead would snapshot the default and also
   * re-apply the effort scaling on the next resolve.
   */
  public setRoute(role: ModelRole, route: Partial<ModelRoute>): void {
    this.routes[role] = { ...this.routes[role], ...route };
  }

  /** Merge a partial route into the default used by roles without an explicit route. */
  public setDefaultRoute(route: Partial<ModelRoute>): void {
    this.defaultRoute = mergeRoute(this.defaultRoute, route);
  }

  /** Every role's effective route, including the effort-scaled budget. */
  public listRoutes(): Record<ModelRole, ModelRoute> {
    const entries = MODEL_ROLES.map((role) => [role, this.resolve(role)] as const);
    return Object.fromEntries(entries) as Record<ModelRole, ModelRoute>;
  }
}

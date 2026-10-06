/**
 * Pure decision logic for recovering the remote-mode SPA navigation.
 *
 * Lives outside `main.ts` (which imports `electron`) so the policy is
 * unit-testable without an Electron runtime, following the same convention as
 * `settings.ts` / `tunnel.ts`.
 *
 * The retry budget is deliberately far larger than the naive "a few hundred ms"
 * one: the ssh tunnel in front of the SPA restarts on capped exponential
 * backoff (`tunnel.ts`), which is measured in seconds — and after a burst of
 * failures in tens of seconds. A short budget would give up while the tunnel is
 * still coming back and paint a permanent failure page for a transient blip.
 */

/** First retry delay after a failed SPA navigation. */
export const NAV_RETRY_BASE_DELAY_MS = 500;
/** Cap on the exponential retry backoff. */
export const NAV_RETRY_MAX_DELAY_MS = 5_000;
/** How long the SPA navigation keeps retrying before the failure page is shown. */
export const NAV_RETRY_DEADLINE_MS = 60_000;
/** Renderer revivals allowed before giving up on a crash loop. */
export const MAX_RENDERER_REVIVALS = 3;

/** Chromium's ERR_ABORTED: a superseded navigation, not a failure. */
const ERR_ABORTED = -3;

/**
 * Canonicalize a URL for comparison.
 *
 * Chromium always reports the parsed form of a main-frame URL — `http://127.0.0.1:58992`
 * comes back as `http://127.0.0.1:58992/` in `did-fail-load`'s `validatedURL` and in
 * `did-navigate` — while the connection result yields the origin with no path.
 * Comparing the two strings verbatim therefore never matches, which silently disables
 * every recovery branch. Trailing slashes on an empty path are the only difference that
 * matters here; an unparseable URL is returned as-is so it can only match itself.
 */
export function normalizeNavUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  // `data:` / `file:` / `blob:` have an opaque ("null") origin — comparing them
  // structurally would compare the string "null". Keep them verbatim.
  if (parsed.origin === 'null') return url;
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${parsed.origin}${pathname}${parsed.search}`;
}

export type NavigationDecision =
  | { kind: 'ignore' }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'failed'; message: string };

export interface NavigationFailure {
  errorCode: number;
  errorDescription: string;
  isMainFrame: boolean;
  /** The URL that failed to load (Chromium's `validatedURL`). */
  url: string;
  /** The SPA URL remote mode is trying to reach; null when no remote session is active. */
  targetUrl: string | null;
  /** Retries already spent for this target. */
  attempts: number;
  /** Milliseconds since the first retry for this target. */
  elapsedMs: number;
}

/** Decide what to do about one `did-fail-load` event. */
export function decideNavigationFailure(f: NavigationFailure): NavigationDecision {
  if (!f.isMainFrame) return { kind: 'ignore' };
  if (f.errorCode === ERR_ABORTED) return { kind: 'ignore' };
  if (!f.targetUrl || normalizeNavUrl(f.url) !== normalizeNavUrl(f.targetUrl)) {
    return { kind: 'ignore' };
  }
  if (f.elapsedMs >= NAV_RETRY_DEADLINE_MS) {
    return { kind: 'failed', message: `${f.errorDescription} (${f.errorCode})` };
  }
  return {
    kind: 'retry',
    delayMs: Math.min(NAV_RETRY_BASE_DELAY_MS * 2 ** f.attempts, NAV_RETRY_MAX_DELAY_MS),
  };
}

/** Decide whether a dead renderer should be revived by reloading the SPA. */
export function decideRenderProcessGone(
  reason: string,
  targetUrl: string | null
): 'reload' | 'ignore' {
  if (!targetUrl) return 'ignore';
  if (reason === 'clean-exit') return 'ignore';
  return 'reload';
}

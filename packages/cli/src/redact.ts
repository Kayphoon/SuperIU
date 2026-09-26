/**
 * Terminal-shell credential redaction.
 *
 * The console shell has had this since its first provider 401 (`redactSecrets`
 * in `packages/ui/src/server.ts`); the CLI had none, so a failed model call
 * printed the provider's own envelope — which echoes the rejected credential —
 * straight into the terminal. Terminal scrollback is routinely pasted into bug
 * reports, CI logs and screen shares, so this is the same defect class the
 * console fixed, not a new one.
 *
 * Deliberately a mirror of the console's layered approach rather than a second
 * convention: the two shells must agree on what counts as a credential.
 * `blankSecrets` below is the console's `blankConfiguredSecrets`, `SECRET_PATTERNS`
 * is copied verbatim, and the two passes run in the same order.
 *
 * The one structural difference: the console reads `settings` and augments it
 * with `resolvedCredentials(runner)`; the CLI has no settings surface at all
 * (its runner resolves the key from `OPENAI_API_KEY` and a `.env` file), so the
 * runner IS the source. `getModelRoutes()` is the same public accessor the
 * console uses, for the same reason — a role may name its own credential, and
 * the environment fallback is applied by the runner, not by the embedder.
 */

import type { AgentRunner } from '@agent/core';

/**
 * Upstream text reaches a terminal the user copies out of, so anything that
 * could carry a credential is blanked first: a provider's error envelope echoes
 * the rejected key back (`Invalid key supplied: Bearer sk-live-…`), and V8's
 * `JSON.parse` message embeds a prefix of the offending body.
 *
 * Copied from `packages/ui/src/server.ts` — the two shells must not drift on
 * what they consider a credential.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{6,}/gi, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/gi, '[redacted]'],
  [/("(?:api[_-]?key|token|secret|password)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2']
];

/**
 * Shortest credential worth blanking by literal value. Nothing this short is a
 * real key, and matching one would shred ordinary prose — a two-character key is
 * a substring of half the English language.
 */
const MIN_LITERAL_SECRET_CHARS = 8;

/**
 * Query-string names whose value is a credential. Same vocabulary as the JSON
 * key alternation in `SECRET_PATTERNS`, so the two agree on what counts as one.
 */
const URL_CREDENTIAL_PARAM = /^(?:api[_-]?key|key|token|access_token|auth|secret|password)$/i;

/** `decodeURIComponent` throws on a malformed `%` escape; a base URL is user input. */
function credentialsInUrl(url: unknown): string[] {
  if (typeof url !== 'string' || url.length === 0) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  const found: string[] = [];
  // Userinfo is percent-encoded by the URL parser while the upstream sees the
  // decoded form, so both spellings are matched; `URLSearchParams` values are
  // already decoded. A malformed `%` escape is not decodable at all, so its raw
  // form stands in.
  for (const part of [parsed.username, parsed.password]) {
    if (!part) continue;
    found.push(part);
    try {
      const decoded = decodeURIComponent(part);
      if (decoded !== part) found.push(decoded);
    } catch {
      // Not decodable — the raw form above is the only candidate.
    }
  }
  for (const [name, value] of parsed.searchParams) {
    if (URL_CREDENTIAL_PARAM.test(name)) found.push(value);
  }
  return found;
}

/**
 * Blank the credentials the runner actually resolved, BY LITERAL VALUE, before
 * the pattern pass.
 *
 * `SECRET_PATTERNS` above is prefix-based, so it only covers vendors whose keys
 * carry a recognizable shape (`sk-…`, `ghp_…`). The app also ships presets for
 * Groq (`gsk_…`), Google (`AIza…`) and xAI (`xai-…`), and the custom slot takes
 * whatever a relay issued — none of which any pattern matches, so a rejected key
 * from any of them used to travel to the terminal verbatim.
 *
 * The credential a provider echoes back on a 401 is by definition one the runner
 * resolved, so matching those literals covers every provider — present, future
 * and unlisted — without knowing its key format. This strengthens the pattern
 * pass rather than replacing it: a literal that never appears (a leaked key the
 * user has not configured here) is still caught by shape alone.
 *
 * A route's `baseURL` is scanned too: it may embed a key (`?api_key=…`,
 * `token@host`) that no other field carries. The endpoint itself is never
 * blanked — replacing it would destroy the part of the message that names the
 * host that failed.
 */
function blankSecrets(out: string, runner?: AgentRunner): string {
  const configured: unknown[] = [];
  // A redaction helper must never be the reason an error message disappears, so
  // a runner that cannot answer costs the literal pass, not the pattern pass.
  try {
    for (const route of Object.values(runner?.getModelRoutes() ?? {})) {
      if (route?.apiKey) configured.push(route.apiKey);
      configured.push(...credentialsInUrl(route?.baseURL));
    }
  } catch {
    // No routes readable — fall through to the pattern pass with nothing added.
  }

  for (const value of configured) {
    if (typeof value !== 'string' || value.length < MIN_LITERAL_SECRET_CHARS) continue;
    // An issued key is opaque text, so escape it before it becomes a pattern:
    // `+`, `.`, `$`, `(` are all legitimate characters in one.
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '[redacted]');
  }
  return out;
}

/**
 * Blank credentials in text bound for the terminal.
 *
 * Layered exactly like the console's: literal values first (prefix-agnostic, so
 * a custom relay's key is covered), then credential shapes (so a key this
 * process never resolved is still covered).
 *
 * There is no `maxChars` bound here, unlike the console's SSE frame. That bound
 * exists to stop a hostile upstream body becoming an unbounded desktop
 * notification; the terminal has no length budget and the message is the point,
 * so truncating would only destroy the diagnostic the user needs.
 *
 * `runner` is optional because the fatal handler can run before a runner exists
 * (a setup failure). There the literal pass has no source and the pattern pass
 * stands alone — that path is only reachable before any model call, so it cannot
 * carry a provider envelope.
 */
export function redactSecrets(text: string, runner?: AgentRunner): string {
  let out = blankSecrets(text, runner);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

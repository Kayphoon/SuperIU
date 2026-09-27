/**
 * Session titles are DATA, not copy.
 *
 * A header stores whatever string was last written to `title`, and older builds
 * stamped the English placeholder `'Initial Session'` on every session they
 * created. No shell can tell that placeholder apart from a title a user really
 * chose, and rendering it verbatim leaks English into a non-English interface,
 * so "no title" is the only honest reading of it — the shell supplies its own
 * localized label instead.
 *
 * Normalization happens on READ; the file is never rewritten. Sessions already
 * on disk are fixed without touching user data, and a title the user supplied
 * round-trips verbatim.
 *
 * A session SUMMARY (`summary`) is data too. It is a model- or user-supplied
 * string stored on the same header, and it is normalized on read for the same
 * reason: the shell owns rendering, so a blank or non-string value reads as
 * "no summary" rather than being passed on to leak an empty row into the UI.
 */

/**
 * The placeholder older builds wrote into every session header.
 *
 * This is data, not copy: it is indistinguishable from a title a user really
 * chose, so it must never be rendered.
 */
export const LEGACY_DEFAULT_TITLE = 'Initial Session';

/**
 * The session's title, or `undefined` when it has none.
 *
 * A title that is absent, blank, or the legacy placeholder reads as "no
 * title". Anything else is returned unchanged, byte for byte: the caller owns
 * the rendering, and a title the user supplied must survive untouched.
 */
export function sessionTitle(header: { title?: string }): string | undefined {
  const title = header.title;
  if (typeof title !== 'string') return undefined;
  if (title.trim() === '' || title === LEGACY_DEFAULT_TITLE) return undefined;
  return title;
}

/**
 * Upper bound on a stored session summary, in characters.
 *
 * The metadata generator clamps a model reply to this length before it can
 * reach a header, so a runaway reply cannot bloat the session file or push the
 * list row past a readable width. Read-side normalization does not clamp:
 * anything narrower than the original would corrupt a value that was already
 * stored legitimately.
 */
export const SESSION_SUMMARY_MAX_CHARS = 240;

/**
 * The session's rolling summary, or `undefined` when it has none.
 *
 * Unlike `sessionTitle` there is no legacy placeholder to filter: `summary` is
 * a new field, so any value present was written by this code and must not be
 * second-guessed. A summary that is absent, non-string, or blank reads as "no
 * summary"; anything else is returned unchanged, byte for byte, because the
 * shell owns the rendering.
 */
export function sessionSummary(header: { summary?: string }): string | undefined {
  const summary = header.summary;
  if (typeof summary !== 'string') return undefined;
  if (summary.trim() === '') return undefined;
  return summary;
}

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

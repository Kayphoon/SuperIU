/**
 * Pure semver parsing and precedence, with no Electron / fs / network imports.
 *
 * Extracted from `updater.ts` so non-updater callers can compare versions
 * without pulling in `electron`: `remote/manager.ts` decides whether an
 * already-installed VPS daemon is stale by comparing its self-reported version
 * against the desktop app's own, and that module must stay runnable (and
 * unit-testable) outside a live Electron runtime.
 */

/** A parsed `major.minor.patch` (with optional pre-release/build) tuple. */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers, e.g. `['beta', '2']`; empty for a stable release. */
  prerelease: string[];
}

/**
 * Parse a semver-ish string, tolerating a leading `v` and a missing
 * minor/patch (e.g. `1` → `1.0.0`). Returns `null` for anything without a
 * leading numeric component.
 */
export function parseVersion(raw: string | undefined | null): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^v/i, '');
  if (!trimmed) return null;

  // Split off build metadata (`+…`), which does not participate in precedence.
  const withoutBuild = trimmed.split('+', 1)[0] ?? '';
  const [core = '', ...preParts] = withoutBuild.split('-');
  const segments = core.split('.');

  if (segments.length === 0 || !/^\d+$/.test(segments[0] ?? '')) return null;

  const major = Number.parseInt(segments[0] ?? '0', 10);
  const minor = /^\d+$/.test(segments[1] ?? '') ? Number.parseInt(segments[1] as string, 10) : 0;
  const patch = /^\d+$/.test(segments[2] ?? '') ? Number.parseInt(segments[2] as string, 10) : 0;

  const prerelease = preParts.length > 0 && preParts[0] ? preParts[0].split('.') : [];

  return { major, minor, patch, prerelease };
}

/** Compare two dot-separated pre-release identifier lists per semver §11. */
function comparePrerelease(a: string[], b: string[]): number {
  // A version WITHOUT a pre-release is HIGHER than one with (1.0.0 > 1.0.0-rc.1).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1; // shorter list is lower (1.0.0-alpha < 1.0.0-alpha.1)
    if (right === undefined) return 1;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);

    if (leftNumeric && rightNumeric) {
      const diff = Number.parseInt(left, 10) - Number.parseInt(right, 10);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (leftNumeric) {
      return -1; // numeric identifiers are lower than alphanumeric
    } else if (rightNumeric) {
      return 1;
    } else if (left !== right) {
      return left > right ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Standard semver precedence: `true` when `remote` is strictly newer than
 * `current`. Unparseable inputs compare as not-newer, so a malformed tag can
 * never trigger an update.
 */
export function semverGt(remote: string | undefined | null, current: string | undefined | null): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(current);
  if (!a || !b) return false;

  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  return comparePrerelease(a.prerelease, b.prerelease) > 0;
}

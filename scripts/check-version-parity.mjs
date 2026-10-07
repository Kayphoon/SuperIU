/**
 * Version-parity guard for the release pipeline.
 *
 * WHY THIS FILE EXISTS — a defect that shipped, twice, undetected.
 *
 * The repository publishes TWO GitHub release channels from one workflow
 * (`.github/workflows/release.yml`):
 *
 *   * `push: branches: [master]` → the rolling `latest` PRERELEASE.
 *   * `push: tags: [v*]`         → the stable `vX.Y.Z` release, which is what
 *                                  `api.github.com/repos/.../releases/latest`
 *                                  (and therefore the in-app updater and
 *                                  `scripts/install-mac.sh`) actually resolves.
 *
 * The macOS app version comes from `packages/desktop/package.json`. The LINUX
 * server binary's version is baked at build time by
 * `scripts/build-server-binary.mjs`: a tagged build bakes the tag, but the
 * rolling master build passes an empty `SUPERIU_VERSION` and falls back to the
 * **root** `package.json`. The root manifest is also the version
 * `packages/ui/src/daemon.ts` resolves at runtime via its `package.json` walk.
 *
 * Only `packages/desktop/package.json` was ever bumped. So the root stayed at
 * `0.1.0` while the app reached `0.2.17`, and every rolling-channel server
 * binary shipped claiming `0.1.0` — verified by extracting the baked string
 * from the published assets:
 *
 *     releases/download/latest/superiu-server-linux-arm64  → 0.1.0   (wrong)
 *     releases/download/v0.2.17/superiu-server-linux-arm64 → 0.2.17  (right)
 *
 * `packages/ui/package.json` matters for the same reason at runtime: the
 * `resolveVersion()` walk from `dist/daemon.js` hits `packages/ui/package.json`
 * before it can reach the root.
 *
 * A single bump therefore has to move SIX manifests together, and nothing
 * enforced that. This guard does.
 *
 * Run: node scripts/check-version-parity.mjs
 * Exit 0 = every manifest agrees; 1 = a divergence, a missing manifest, or a
 *          version that is not a bare semver.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every manifest whose `version` is load-bearing for a release. Keep this list
 * in sync with the comment above: adding a workspace package that bakes or
 * reports a version means adding it here.
 */
const MANIFESTS = [
  'package.json',
  'packages/ui/package.json',
  'packages/core/package.json',
  'packages/cli/package.json',
  'packages/protocol/package.json',
  'packages/desktop/package.json'
];

/** A bare `X.Y.Z`, optionally with a prerelease suffix — no leading `v`. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const failures = [];

function check(name, ok, detail) {
  if (!ok) failures.push(`${name} — ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${detail}`);
}

const versions = new Map();

for (const relative of MANIFESTS) {
  const absolute = path.join(REPO_ROOT, relative);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(absolute, 'utf-8'));
  } catch (err) {
    check(`read ${relative}`, false, `unreadable: ${err instanceof Error ? err.message : err}`);
    continue;
  }
  const version = manifest.version;
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    check(`version shape in ${relative}`, false, `not a bare semver: ${JSON.stringify(version)}`);
    continue;
  }
  versions.set(relative, version);
}

// The guard must not pass vacuously if the manifest list is ever emptied or the
// parser silently stops finding versions.
check(
  'every manifest declares a version',
  versions.size === MANIFESTS.length,
  `${versions.size} / ${MANIFESTS.length} parsed`
);

const distinct = [...new Set(versions.values())];
check(
  'all manifests agree on one version',
  distinct.length === 1,
  distinct.length === 1
    ? `all ${versions.size} at ${distinct[0]}`
    : distinct.map((v) => `${v} (${[...versions].filter(([, x]) => x === v).map(([f]) => f).join(', ')})`).join(' | ')
);

// A divergence here is what let a rolling server binary ship as `0.1.0`.
const root = versions.get('package.json');
const desktop = versions.get('packages/desktop/package.json');
check(
  'root and desktop agree (root is the rolling server-binary fallback)',
  root !== undefined && root === desktop,
  `root=${root ?? '?'} desktop=${desktop ?? '?'}`
);

console.log(failures.length === 0 ? '\nVersion parity guard passed.' : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);

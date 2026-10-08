#!/usr/bin/env node
/**
 * Builds the delta patch published beside a `superiu-server` release binary.
 *
 * The patch lets an installed daemon fetch a few MB instead of the whole ~80 MB
 * binary when it upgrades. It is generated against the most recently published
 * binary for the same asset name — the daemon can only apply a patch whose
 * recorded source is the exact binary it is currently running.
 *
 * A patch is never allowed to block a release: when there is no such binary
 * (the first ever release) or the previous binary cannot be fetched, this script
 * writes nothing and exits 0, and clients simply fall back to a full download.
 * Any other failure is reported on stderr and also exits 0.
 *
 * Usage:
 *   node scripts/build-server-patch.mjs --asset superiu-server-linux-x64 \
 *     --binary dist/superiu-server-linux-x64 --out dist/superiu-server-linux-x64.patch \
 *     --repo Kayphoon/SuperIU [--exclude-tag v0.2.7]
 *
 * `--exclude-tag` is the tag being published right now, so the patch is built
 * against the previous release rather than against itself.
 *
 * Requires `GH_TOKEN` for a private repository (or to avoid the anonymous rate
 * limit); it is sent as a bearer token when present.
 */
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDelta } from "../packages/ui/dist/delta.js";

const USAGE =
  "Usage: node scripts/build-server-patch.mjs --asset <name> --binary <path> --out <path> --repo <owner/name> [--exclude-tag <tag>]";

/** Read `--name <value>` or `--name=<value>` from argv; `undefined` when absent. */
function flagValue(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

/** Download `url` into `destination`; throws on a non-2xx response. */
async function downloadTo(url, destination) {
  const response = await fetch(url, {
    headers: { "User-Agent": "superiu-server-patch-builder", Accept: "application/octet-stream" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

/**
 * Build the patch, returning the process exit code. Nothing here throws: a
 * failure to produce a patch must not fail the release that is publishing the
 * binary, so every error is reported and swallowed.
 */
async function main() {
  const argv = process.argv.slice(2);
  const asset = flagValue(argv, "asset");
  const binary = flagValue(argv, "binary");
  const out = flagValue(argv, "out");
  const repo = flagValue(argv, "repo");
  const excludeTag = flagValue(argv, "exclude-tag");
  if (!asset || !binary || !out || !repo) {
    console.error(USAGE);
    return 2;
  }

  // Newest-first. Drafts are skipped, and so is the release being published
  // right now — a patch against the very binary it ships would be empty.
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "superiu-server-patch-builder"
  };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers });
  if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
  const releases = await response.json();

  const previous = releases.find(
    (release) =>
      !release.draft &&
      release.tag_name !== excludeTag &&
      release.assets?.some((candidate) => candidate.name === asset)
  );
  if (!previous) {
    console.log(`superiu-server patch: no previous release ships '${asset}'; writing no patch`);
    return 0;
  }

  // Next to `--out`, so the delta's temporary file lands on the same filesystem
  // as the patch itself.
  const previousPath = path.join(path.dirname(out), `.${path.basename(out)}.prev.${process.pid}`);
  try {
    await downloadTo(previous.assets.find((candidate) => candidate.name === asset).browser_download_url, previousPath);
    const stats = await createDelta(previousPath, binary, out);
    console.log(
      JSON.stringify({
        asset,
        previousTag: previous.tag_name,
        patchSize: stats.patchSize,
        targetSize: stats.targetSize,
        ratio: Number((stats.patchSize / stats.targetSize).toFixed(4)),
        copyBytes: stats.copyBytes,
        insertBytes: stats.insertBytes
      })
    );
  } finally {
    await rm(previousPath, { force: true });
  }
  return 0;
}

let code = 0;
try {
  code = await main();
} catch (err) {
  console.error(`superiu-server patch: ${err instanceof Error ? err.message : String(err)}`);
}
process.exitCode = code;

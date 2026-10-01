/**
 * In-app update checker and one-click updater.
 *
 * The desktop shell ships as a macOS `.app` bundle built from GitHub Releases,
 * so the updater speaks the GitHub Releases API directly rather than pulling in
 * an auto-update framework: the payload is a plain `.zip` of `SuperIU.app`, and
 * the whole flow is "compare versions, download the zip, `ditto` it over the
 * running bundle, relaunch".
 *
 * Two pieces are deliberately kept pure and exported so they can be unit-tested
 * without a live Electron runtime:
 *   - {@link parseVersion} / {@link semverGt} — version parsing and comparison.
 *   - {@link selectMacAsset} — picking the right `.zip` for the running arch.
 * Everything that touches `electron`, `fs` or the network lives behind those.
 */

import { app, dialog } from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** The GitHub repository that publishes released desktop builds. */
export const DEFAULT_REPO = 'Kayphoon/SuperIU';

/** The bundle name produced by `scripts/bundle-mac.ts`. */
const APP_BUNDLE_NAME = 'SuperIU.app';

/** Result of an update check. `downloadUrl`/`assetName` are absent when no update exists. */
export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  downloadUrl?: string;
  assetName?: string;
}

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

/** Minimal shape of a GitHub release asset needed to pick the macOS download. */
export interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

/**
 * Pick the macOS `.zip` asset for the running architecture.
 *
 * GitHub exposes every platform's artifacts on one release, so the arch suffix
 * (`arm64` / `x64`) has to be matched explicitly or an Apple-Silicon Mac would
 * download the Intel build. Falls back to the running `process.arch` when no
 * `arch` argument is supplied, and returns `null` when nothing matches.
 */
export function selectMacAsset(
  assets: ReleaseAsset[] | undefined,
  arch: string = process.arch
): ReleaseAsset | null {
  if (!Array.isArray(assets) || assets.length === 0) return null;

  const wantedArch = arch === 'arm64' ? 'arm64' : 'x64';

  const zips = assets.filter(
    (asset) => typeof asset?.name === 'string' && asset.name.toLowerCase().endsWith('.zip')
  );

  // Prefer a `.zip` naming both `mac` and the exact architecture.
  const macArch = zips.find((asset) => {
    const name = asset.name?.toLowerCase() ?? '';
    return name.includes('mac') && name.includes(wantedArch);
  });
  if (macArch?.browser_download_url) return macArch;

  // Fall back to any macOS zip (e.g. a universal build that omits the arch).
  const macAny = zips.find((asset) => (asset.name ?? '').toLowerCase().includes('mac'));
  if (macAny?.browser_download_url) return macAny;

  return null;
}

/**
 * Extract a semver version from a release asset name.
 *
 * The rolling release channel tags every master build as `latest`, which is not
 * a parseable version. The asset names, however, always embed the package
 * version (`SuperIU-0.2.0-mac-arm64.zip`), so the asset name is the version
 * source of truth for the rolling channel.
 */
export function versionFromAssetName(name: string | undefined | null): string | null {
  if (typeof name !== 'string') return null;
  // Pre-release segments may contain dots/hyphen words (`1.0.0-beta.3`) but must
  // not swallow the platform/arch suffixes that follow the version.
  const match = name.match(/(\d+\.\d+\.\d+(?:-(?!mac\b|linux\b|windows\b|arm64\b|x64\b)[\w.]+)*)/);
  return match ? (match[1] as string) : null;
}

/** Shape of the GitHub `/releases/latest` payload fields we consume. */
interface GithubLatestRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  assets?: ReleaseAsset[];
  draft?: boolean;
  prerelease?: boolean;
}

/** Resolve the version the app is currently running at. */
function resolveCurrentVersion(explicit?: string): string {
  if (explicit) return explicit;
  try {
    return app.getVersion();
  } catch {
    // `app.getVersion()` is unavailable when this module is imported outside a
    // running Electron app (e.g. a unit test); fall back to the package version.
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')
      ) as { version?: string };
      return pkg.version ?? '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}

/**
 * Query the GitHub Releases API for the latest release and compare it with the
 * running version.
 *
 * Network and API failures resolve to `hasUpdate: false` rather than throwing:
 * an update check is a convenience, and a silent background check must never
 * surface a stack trace for an offline laptop.
 */
export async function checkForUpdates(
  options: { currentVersion?: string; repo?: string; silent?: boolean } = {}
): Promise<UpdateCheckResult> {
  const repo = options.repo ?? DEFAULT_REPO;
  const currentVersion = resolveCurrentVersion(options.currentVersion);

  const headers = {
    // GitHub rejects requests without a User-Agent.
    'User-Agent': 'SuperIU-Desktop',
    Accept: 'application/vnd.github+json'
  };

  async function fetchJson(url: string): Promise<Response> {
    return fetch(url, { headers });
  }

  /**
   * Resolve the release to compare against.
   *
   * `/releases/latest` is tried first (the cheap, canonical path), but it never
   * returns pre-releases — and the rolling `latest` channel publishes every
   * master build as a prerelease, leaving that endpoint 404ing forever. When it
   * does, fall back to the release list (ordered newest-first by GitHub) and
   * take the first entry that carries a mac asset.
   */
  async function fetchLatestRelease(): Promise<GithubLatestRelease | null> {
    const direct = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
    if (direct.ok) return (await direct.json()) as GithubLatestRelease;
    if (direct.status !== 404) throw new Error(`GitHub API responded ${direct.status}`);

    const list = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=20`);
    if (!list.ok) throw new Error(`GitHub API responded ${list.status}`);
    const releases = (await list.json()) as GithubLatestRelease[];
    return releases.find((release) => selectMacAsset(release.assets) !== null) ?? null;
  }

  try {
    const release = await fetchLatestRelease();
    if (!release) throw new Error('no release with a macOS asset found');

    // Prefer the version embedded in the asset name (rolling channel tags are
    // `latest`, not semver); fall back to the tag for classic tagged releases.
    const asset = selectMacAsset(release.assets);
    const tagVersion = (release.tag_name ?? release.name ?? '').replace(/^v/i, '').trim();
    const latestVersion = versionFromAssetName(asset?.name) ?? tagVersion;

    if (!latestVersion || !semverGt(latestVersion, currentVersion)) {
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion: latestVersion || currentVersion,
        releaseNotes: release.body ?? undefined
      };
    }

    const releaseNotes = release.body?.trim() || undefined;

    return {
      hasUpdate: true,
      currentVersion,
      latestVersion,
      ...(releaseNotes ? { releaseNotes } : {}),
      ...(asset?.browser_download_url ? { downloadUrl: asset.browser_download_url } : {}),
      ...(asset?.name ? { assetName: asset.name } : {})
    };
  } catch (err) {
    if (!options.silent) {
      console.warn('[superiu] update check failed:', err instanceof Error ? err.message : err);
    }
    return { hasUpdate: false, currentVersion, latestVersion: currentVersion };
  }
}

/** Run a command to completion, rejecting on a non-zero exit. */
function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

/** Download a URL to a file, reporting integer progress percentages. */
async function downloadFile(
  url: string,
  destination: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'SuperIU-Desktop', Accept: 'application/octet-stream' }
  });
  if (!response.ok) throw new Error(`download failed with status ${response.status}`);

  const total = Number(response.headers.get('content-length') ?? 0);
  const body = response.body;
  if (!body) throw new Error('download response had no body');

  const out = fs.createWriteStream(destination);
  let received = 0;
  let lastPercent = -1;

  try {
    // Node's fetch returns a web ReadableStream; iterate it as an async source.
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      if (!out.write(chunk)) {
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      }
      if (typeof onProgress === 'function' && total > 0) {
        const percent = Math.min(100, Math.round((received / total) * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.on('error', reject);
    });
  } catch (err) {
    out.destroy();
    throw err;
  }
}

/** Locate the running `SuperIU.app` bundle from `process.execPath`. */
function runningBundlePath(execPath: string = process.execPath): string {
  // Packaged exec path: `/…/SuperIU.app/Contents/MacOS/SuperIU`.
  const macOsDir = path.dirname(execPath);
  const contentsDir = path.dirname(macOsDir);
  return path.dirname(contentsDir);
}

/**
 * Download and install the requested update, then relaunch into the new build.
 *
 * Flow: download the zip into the app's temp directory, extract it with
 * `/usr/bin/ditto -x -k`, and — when packaged — replace the running
 * `SuperIU.app` before relaunching. In development (`!app.isPackaged`) the
 * bundle on disk is a source checkout, not an app, so the download is kept and
 * the user is told it cannot be installed.
 */
export async function downloadAndInstallUpdate(
  updateInfo: UpdateCheckResult,
  onProgress?: (percent: number) => void
): Promise<void> {
  if (!updateInfo.downloadUrl) {
    throw new Error('no download URL in update info');
  }

  const tempRoot = app.getPath('temp');
  const zipPath = path.join(tempRoot, 'superiu-update.zip');
  const extractDir = path.join(tempRoot, 'superiu-update');

  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });

  await downloadFile(updateInfo.downloadUrl, zipPath, onProgress);

  // `ditto -x -k` is the macOS-native way to unpack a zip while preserving the
  // bundle's symlinks, extended attributes and code signature.
  await runCommand('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);

  const extractedApp = path.join(extractDir, APP_BUNDLE_NAME);
  if (!fs.existsSync(extractedApp)) {
    throw new Error(`extracted archive did not contain ${APP_BUNDLE_NAME}`);
  }

  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'SuperIU',
      message: '更新已下载（开发模式，无法覆盖正在运行的源码）',
      detail: `新版本 ${updateInfo.latestVersion} 已保存至 ${extractedApp}`
    });
    return;
  }

  // Replace the running bundle. The destination is cleared first so a renamed
  // or removed bundle in the new version cannot leave stale files behind;
  // `ditto` then writes a byte-faithful copy of the extracted app.
  const target = runningBundlePath();
  await fsp.rm(target, { recursive: true, force: true });
  await runCommand('/usr/bin/ditto', [extractedApp, target]);

  // Clean up the download before relaunching so the temp dir does not grow.
  await fsp.rm(zipPath, { force: true }).catch(() => undefined);

  app.relaunch();
  app.exit(0);
}

/**
 * Check for an update and, when interactive, walk the user through installing
 * it with native dialogs.
 *
 * `interactive` is `true` for the menu item (a click deserves feedback, even
 * when there is nothing to install) and `false` for the silent background probe
 * at startup (which stays completely quiet unless an update is found).
 */
export async function triggerUpdateCheck(interactive = true): Promise<void> {
  const result = await checkForUpdates({ silent: !interactive });

  if (!result.hasUpdate) {
    if (interactive) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'SuperIU',
        message: '已是最新版本',
        detail: `当前版本 ${result.currentVersion} 是最新版本。`
      });
    }
    return;
  }

  const detail = [result.releaseNotes, '', '是否立即下载并更新？']
    .filter((part): part is string => part !== undefined)
    .join('\n');

  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: '发现新版本',
    message: `SuperIU ${result.latestVersion} 已发布`,
    detail,
    buttons: ['立即更新并重启', '稍后'],
    defaultId: 0,
    cancelId: 1
  });

  if (response !== 0) return;

  try {
    await downloadAndInstallUpdate(result, (percent) => {
      console.log(`[superiu] update download ${percent}%`);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[superiu] update failed:', message);
    await dialog.showMessageBox({
      type: 'error',
      title: 'SuperIU',
      message: '更新失败',
      detail: message
    });
  }
}

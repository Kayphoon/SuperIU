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
 *
 * Updates follow the VS Code / Chrome model rather than the "block the user
 * with a modal progress window" one: a check may start a download that runs
 * quietly in the background while the app stays fully usable, and the finished
 * download is *staged* beside the temp directory until the user asks to
 * restart. State is published through {@link onUpdateState} and rendered by the
 * caller; nothing in this file opens a window of its own.
 */

import { app, dialog } from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { REPO_SLUG } from './constants.js';

/** The GitHub repository that publishes released desktop builds. */
export const DEFAULT_REPO = REPO_SLUG;

/** The bundle name produced by `scripts/bundle-mac.ts`. */
const APP_BUNDLE_NAME = 'SuperIU.app';

/** App-temp directory where a downloaded update is unpacked and left staged. */
const UPDATE_STAGE_DIR_NAME = 'superiu-update';

/** The zip is downloaded beside the staging directory, never inside it. */
const UPDATE_ZIP_NAME = 'superiu-update.zip';

/**
 * Records which version the staging directory currently holds.
 *
 * Without it, a build the user downloaded and then declined to install would be
 * silently thrown away and re-fetched on the next launch — a second 100+ MB
 * download for a decision the user already made. The marker is written once the
 * staged bundle is validated and is what makes reuse across sessions truthful.
 */
const UPDATE_STAGED_VERSION_FILE = 'staged-version';

/**
 * The version currently staged on disk, or `null` when nothing usable is.
 *
 * A staged directory is only trusted when its marker, its bundle and its bundle
 * version all agree — a half-extracted or hand-tampered directory must never be
 * offered as an installable update.
 */
function stagedVersion(extractDir: string): string | null {
  try {
    const marker = fs.readFileSync(path.join(extractDir, UPDATE_STAGED_VERSION_FILE), 'utf-8').trim();
    if (!marker) return null;
    const bundle = path.join(extractDir, APP_BUNDLE_NAME);
    if (!fs.existsSync(bundle)) return null;
    return marker;
  } catch {
    return null;
  }
}

/**
 * Decide whether the already-staged bundle satisfies `latestVersion`.
 *
 * A staged build counts only as a fallback for the exact version GitHub
 * advertises: it is what spares a returning user a redundant download, and it is
 * deliberately conservative — an unknown or differing marker re-downloads.
 */
function stagedUpdateFor(extractDir: string, latestVersion: string): boolean {
  const staged = stagedVersion(extractDir);
  return staged !== null && staged === latestVersion;
}

/**
 * Lifecycle of an update run.
 *
 * `ready` is the state the whole redesign exists for: the new build is already
 * downloaded, extracted and validated on disk, and the app is expected to offer
 * a "restart to update" affordance instead of restarting underneath the user.
 * The swap into the running bundle only happens in
 * {@link installPreparedUpdate}, when the user asks for it.
 */
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';

/** Snapshot of the updater, published to every listener on change. */
export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  /** 0..100; set only while phase === 'downloading'. */
  percent?: number;
  /** Human-readable message; set only when phase === 'error'. */
  error?: string;
}

export type UpdateListener = (state: UpdateState) => void;

const listeners = new Set<UpdateListener>();
let current: UpdateState | null = null;

/**
 * The live state object. Built lazily rather than at module load: resolving the
 * running version reads from Electron, and importing this module outside a live
 * app (unit tests, tooling) should stay cheap and free of side effects.
 */
function state(): UpdateState {
  if (!current) {
    const version = resolveCurrentVersion();
    current = { phase: 'idle', currentVersion: version, latestVersion: version };
  }
  return current;
}

/**
 * The single funnel for every state change in this file.
 *
 * Funnelling matters because subscribers are notified from here and nowhere
 * else: a listener can never miss a transition that some other code path forgot
 * to publish, and everyone observes the same snapshot of a change.
 */
function setState(partial: Partial<UpdateState>): UpdateState {
  current = { ...state(), ...partial };
  const snapshot = { ...current };
  // Notify a copy of the set: a listener that unsubscribes, or subscribes, while
  // being notified must not disturb delivery to the others.
  for (const listener of [...listeners]) {
    try {
      listener({ ...snapshot });
    } catch (err) {
      console.warn(
        '[superiu] update state listener failed:',
        err instanceof Error ? err.message : err
      );
    }
  }
  return snapshot;
}

/** Subscribe to updater state; the returned function unsubscribes. */
export function onUpdateState(listener: UpdateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Latest state snapshot (never null; starts as an 'idle' state). */
export function getUpdateState(): UpdateState {
  // A copy, so a caller cannot mutate module state by holding on to it.
  return { ...state() };
}

/** Localize a thrown value into the one-line message the user is shown. */
function describeUpdateFailure(err: unknown): string {
  if (err instanceof Error && err.message) {
    // Node surfaces an aborted fetch as a DOMException whose message is English
    // ("This operation was aborted"); the watchdog's own reason is the localized
    // text, so prefer that whenever the abort is what ended the download.
    if (err.name === 'AbortError') return '下载超时：连接长时间无数据';
    return err.message;
  }
  return '更新失败：未知错误';
}

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
  const macArch = zips.filter((asset) => {
    const name = asset.name?.toLowerCase() ?? '';
    return name.includes('mac') && name.includes(wantedArch);
  });
  // Fall back to any macOS zip (e.g. a universal build that omits the arch).
  const candidates = macArch.length > 0 ? macArch : zips.filter((a) => (a.name ?? '').toLowerCase().includes('mac'));

  if (candidates.length === 0) return null;

  // The rolling release channel can briefly carry assets from more than one
  // build (a re-run uploads alongside stale files), and GitHub's asset order is
  // not guaranteed — always take the highest embedded version.
  const best = candidates.reduce((acc, asset) => {
    if (!acc.browser_download_url && asset.browser_download_url) return asset;
    const accVersion = versionFromAssetName(acc.name) ?? '';
    const assetVersion = versionFromAssetName(asset.name) ?? '';
    return semverGt(assetVersion, accVersion) ? asset : acc;
  });
  return best.browser_download_url ? best : null;
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

  // Development app bundle (`SuperIU (Dev).app`): do not auto-update over
  // the local development build. Developers rebuild from source.
  if (path.basename(runningBundlePath()) === 'SuperIU (Dev).app') {
    return {
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion
    };
  }
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

/** Abort a download that has made no progress for this long. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/** Bytes between progress ticks when the server sends no `content-length`. */
const PROGRESS_BYTE_STEP = 1024 * 1024;

/** Download a URL to a file, reporting integer progress percentages. */
async function downloadFile(
  url: string,
  destination: string,
  onProgress?: (percent: number, received: number, total: number) => void
): Promise<void> {
  // An idle (not total) timeout: a large release on a slow link must be allowed
  // to finish, but a connection that stops delivering data must not hang the UI
  // forever. The timer is re-armed on every chunk.
  const controller = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdleTimeout = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new Error('下载超时：连接长时间无数据')),
      DOWNLOAD_IDLE_TIMEOUT_MS
    );
  };
  const clearIdleTimeout = (): void => {
    clearTimeout(idleTimer);
  };

  let response: Response;
  try {
    armIdleTimeout();
    response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'SuperIU-Desktop', Accept: 'application/octet-stream' }
    });
  } catch (err) {
    clearIdleTimeout();
    throw err;
  }

  if (!response.ok) {
    clearIdleTimeout();
    throw new Error(`下载失败：服务器返回 ${response.status}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  const body = response.body;
  if (!body) {
    clearIdleTimeout();
    throw new Error('下载失败：响应没有内容');
  }

  const out = fs.createWriteStream(destination);
  let received = 0;
  let lastPercent = -1;
  let lastReportedBytes = 0;

  try {
    // Node's fetch returns a web ReadableStream; iterate it as an async source.
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      armIdleTimeout();
      received += chunk.length;
      if (!out.write(chunk)) {
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      }
      if (typeof onProgress === 'function') {
        const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
        // With a known length, report on each whole percent; without one, fall
        // back to a byte step so an unknown-length stream still shows movement
        // without one renderer round-trip per chunk.
        const shouldReport =
          total > 0 ? percent !== lastPercent : received - lastReportedBytes >= PROGRESS_BYTE_STEP;
        if (shouldReport) {
          lastPercent = percent;
          lastReportedBytes = received;
          onProgress(percent, received, total);
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
  } finally {
    clearIdleTimeout();
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
 * Install a prepared `.app` over the running bundle as atomically as the
 * filesystem allows.
 *
 * The naive `rm -rf target && ditto prepared target` has a window in which the
 * installed app does not exist at all: an interrupted or failing copy leaves the
 * user with nothing to launch. This stages the new bundle as a sibling first,
 * then swaps the two with `rename` (an atomic metadata operation on one volume),
 * and only then discards the old copy. If any step fails, the original bundle is
 * restored from the backup.
 */
export async function replaceBundle(preparedApp: string, target: string): Promise<void> {
  const targetParent = path.dirname(target);
  const targetName = path.basename(target);
  const stamp = Date.now();
  const backupTarget = path.join(targetParent, `.${targetName}.old-${stamp}`);
  const stagingTarget = path.join(targetParent, `.${targetName}.new-${stamp}`);

  try {
    // 1. Materialise the new bundle beside the target (same volume → cheap rename).
    // `ditto` preserves macOS code signatures, extended attributes and resource
    // forks. It is missing off macOS, so THIS COPY falls back to recursive
    // `fs.cp`; note the zip unpack in `prepareUpdate` still requires
    // `/usr/bin/ditto -x -k` and this branch does not make the module portable.
    if (process.platform === 'darwin' && fs.existsSync('/usr/bin/ditto')) {
      await runCommand('/usr/bin/ditto', [preparedApp, stagingTarget]);
    } else {
      await fsp.cp(preparedApp, stagingTarget, { recursive: true });
    }
    // 2. Move the live bundle aside (the running process keeps its open inode).
    await fsp.rename(target, backupTarget);

    // 3. Put the new bundle in place.
    await fsp.rename(stagingTarget, target);
  } catch (err) {
    // Roll back: restore the original if it was moved away and the swap failed.
    if (fs.existsSync(backupTarget) && !fs.existsSync(target)) {
      await fsp.rename(backupTarget, target).catch(() => undefined);
    }
    await fsp.rm(stagingTarget, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  // The new bundle is live; the old copy is only now safe to discard.
  await fsp.rm(backupTarget, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Download an update into the staging directory and validate what came out.
 *
 * Staging is what makes the background download safe: nothing here touches the
 * running bundle, so the app keeps working (and keeps writing to its own
 * bundle's disk image) while the release streams down, and an abandoned or
 * failed download leaves the installed app exactly as it was.
 */
async function prepareUpdate(updateInfo: UpdateCheckResult): Promise<void> {
  if (!updateInfo.downloadUrl) {
    throw new Error('更新信息缺少下载地址');
  }

  const tempRoot = app.getPath('temp');
  const extractDir = path.join(tempRoot, UPDATE_STAGE_DIR_NAME);
  const zipPath = path.join(tempRoot, UPDATE_ZIP_NAME);

  // A build staged by an earlier session for this exact version is already the
  // answer: reusing it keeps the "restart to install" offer immediate instead of
  // making the user wait through the same download twice.
  if (app.isPackaged && stagedUpdateFor(extractDir, updateInfo.latestVersion)) {
    setState({ phase: 'ready', latestVersion: updateInfo.latestVersion, percent: undefined });
    return;
  }

  // Drop whatever a previous attempt staged: a stale or half-extracted bundle
  // must never be the thing the user is later offered to install.
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });

  // The extracted bundle is kept on the success path — it *is* the staged
  // update — and also in development, where it is the only copy the user can
  // act on; it is discarded only when extraction did not produce a usable app.
  let keepExtracted = false;
  try {
    await downloadFile(updateInfo.downloadUrl, zipPath, (percent) => {
      setState({ phase: 'downloading', latestVersion: updateInfo.latestVersion, percent });
    });

    // `ditto -x -k` is the macOS-native way to unpack a zip while preserving the
    // bundle's symlinks, extended attributes and code signature.
    await runCommand('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);

    const extractedApp = path.join(extractDir, APP_BUNDLE_NAME);
    if (!fs.existsSync(extractedApp)) {
      throw new Error(`解压后的压缩包中没有 ${APP_BUNDLE_NAME}`);
    }

    // Clear quarantine flag on the extracted update so Gatekeeper won't block it
    if (process.platform === 'darwin') {
      await runCommand('/usr/bin/xattr', ['-cr', extractedApp]).catch(() => undefined);
    }

    if (!app.isPackaged) {
      // Development runs from a source checkout, not an app bundle, so there is
      // nothing to swap and nothing to restart into. Keep the download and say
      // so; the user can install it themselves.
      keepExtracted = true;
      await dialog.showMessageBox({
        type: 'info',
        title: 'SuperIU',
        message: '更新已下载（开发模式，无法覆盖正在运行的源码）',
        detail: `新版本 ${updateInfo.latestVersion} 已保存至 ${extractedApp}`
      });
      setState({ phase: 'idle', percent: undefined });
      return;
    }

    keepExtracted = true;
  } finally {
    await fsp.rm(zipPath, { force: true }).catch(() => undefined);
    if (!keepExtracted) {
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // Record what is staged, so the next launch recognises this download instead
  // of repeating it. Written only after the bundle validated, above; the
  // development path has already returned and never stages for a future session.
  await fsp
    .writeFile(path.join(extractDir, UPDATE_STAGED_VERSION_FILE), updateInfo.latestVersion, 'utf-8')
    .catch(() => undefined);

  // Packaged: the validated bundle stays staged until the user asks to restart.
  setState({ phase: 'ready', latestVersion: updateInfo.latestVersion, percent: undefined });
}

/**
 * Check GitHub for a newer build.
 *
 * `interactive` is `true` for the menu item (a click deserves feedback, even
 * when there is nothing to install) and `false` for the silent background probe
 * at startup (which stays completely quiet unless an update is found).
 *
 * When something IS newer the download starts immediately in the background and
 * this function returns; the caller renders progress from {@link onUpdateState}.
 * No dialog and no progress window blocks the app while the release streams
 * down, and the app relaunches only through {@link installPreparedUpdate}.
 */
export async function checkForUpdate(interactive: boolean): Promise<void> {
  const phaseAtEntry = state().phase;
  if (phaseAtEntry === 'downloading' || phaseAtEntry === 'installing') {
    // A download or an install already owns the updater; a second run would only
    // fight it for the same staging paths.
    return;
  }

  // 'checking' overwrites the phase, so remember this now: a build that is
  // already staged must survive a re-check that finds nothing newer.
  const hadStagedUpdate = phaseAtEntry === 'ready';

  setState({ phase: 'checking', error: undefined });

  const result = await checkForUpdates({ silent: !interactive });

  if (!result.hasUpdate) {
    if (hadStagedUpdate || state().phase === 'ready') {
      // Still offer the restart: "nothing newer than what we already staged" is
      // not a reason to make the staged build disappear.
      setState({ phase: 'ready' });
      return;
    }
    setState({
      phase: 'idle',
      currentVersion: result.currentVersion,
      latestVersion: result.latestVersion,
      releaseNotes: result.releaseNotes,
      percent: undefined
    });
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

  setState({
    phase: 'downloading',
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    releaseNotes: result.releaseNotes,
    percent: 0
  });

  try {
    await prepareUpdate(result);
  } catch (err) {
    const message = describeUpdateFailure(err);
    console.error('[superiu] update failed:', message);
    setState({ phase: 'error', error: message, percent: undefined });
  }
}

/**
 * Install the update that is already downloaded and staged, then restart into
 * it.
 *
 * Throws unless a download has completed, so a stray call can never swap a
 * half-prepared bundle into place; callers gate this behind the 'ready' state
 * they render.
 */
export async function installPreparedUpdate(): Promise<void> {
  if (state().phase !== 'ready') {
    throw new Error('没有已下载完成的更新');
  }

  setState({ phase: 'installing' });

  const stagedApp = path.join(app.getPath('temp'), UPDATE_STAGE_DIR_NAME, APP_BUNDLE_NAME);
  try {
    await replaceBundle(stagedApp, runningBundlePath());
  } catch (err) {
    // `replaceBundle` restores the original bundle before throwing, so the
    // installed app keeps working; surfacing the error is what lets the user
    // retry rather than wonder.
    const message = describeUpdateFailure(err);
    console.error('[superiu] update install failed:', message);
    setState({ phase: 'error', error: message });
    throw err;
  }

  // `app.quit()` rather than `app.exit(0)`: quit runs the `before-quit` handler
  // in main.ts, which tears the UI server, gateway client and SSH tunnel down.
  // `exit` would kill the process with that teardown skipped.
  app.relaunch();
  app.quit();
}

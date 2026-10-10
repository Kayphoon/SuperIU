/**
 * Desktop-shell settings: the persisted connection configuration and the
 * first-run gating logic.
 *
 * ── Why this module is Electron-free ────────────────────────────────────────
 * This module is deliberately pure: it imports only `node:fs` / `node:path` and
 * never touches `electron`. `main.ts` imports from here at module scope (before
 * `app.whenReady()`), and the unit tests import the same functions without an
 * Electron runtime, so anything with an Electron import here would make both
 * impossible.
 *
 * ── Key ownership ───────────────────────────────────────────────────────────
 * `<workspace>/.superiu/ui-settings.json` is shared: the SPA's server owns the
 * `UiSettings` keys (`apiKey`, `providers`, …) and rewrites the WHOLE typed
 * object on save (see `@agent/ui` `persistSettings`). The desktop shell owns
 * `connectionMode`, `gateway`, `remote`, `workspaceRoot` and `onboardingCompleted`.
 * Every write here is therefore a read-modify-write that preserves keys it does
 * not own, so a desktop write can never drop the server's settings and vice
 * versa.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The ways the desktop shell can run. */
export type ConnectionMode = 'local' | 'gateway' | 'remote' | 'custom_url';

/** A direct-URL connection to an already-running SuperIU service. */
export interface CustomUrlConfig {
  /** Base URL of the service (`http://` or `https://`). */
  url: string;
  /** Optional pairing key / token presented as a `pairing_key` cookie. */
  token?: string;
}

/** A resolved connection configuration for the shell. */
export interface GatewayConfig {
  mode: ConnectionMode;
  /** WebSocket endpoint, when a gateway is configured. */
  url?: string;
  /** Pre-shared token presented during the handshake. */
  token?: string;
  /** Local workspace directory the sandbox is anchored to. */
  workspaceRoot: string;
  /** Stable device id persisted across launches, when one is configured. */
  deviceId?: string;
  /** SSH-managed remote settings, when `mode === 'remote'`. */
  remote?: RemoteConfig;
  /** Direct URL settings, when `mode === 'custom_url'`. */
  customUrl?: CustomUrlConfig;
}

/** Resolved settings for the SSH-managed `remote` mode. */
export interface RemoteConfig {
  /** ssh host alias (resolved against `~/.ssh/config`). */
  alias: string;
  /** Remote workspace directory on the VPS. */
  workspace: string;
  /** Overrides the release download base URL. */
  releaseBase?: string;
  /** Pins a specific daemon version. */
  version?: string;
  /** Fixed local tunnel port; an ephemeral port is chosen when omitted. */
  localPort?: number;
  /** Enable the daemon's idle auto-update (off when omitted). */
  autoUpdateIdle?: boolean;
  /** Hours between idle auto-update checks; only forwarded when `> 0`. */
  autoUpdateIntervalHours?: number;
}

/** Parsed subset of `ui-settings.json` relevant to the desktop connection. */
export interface DesktopSettings {
  connectionMode?: string;
  gateway?: { url?: string; token?: string; deviceId?: string; deviceName?: string };
  customUrl?: { url?: string; token?: string };
  remote?: {
    alias?: string;
    workspace?: string;
    releaseBase?: string;
    version?: string;
    localPort?: number;
    autoUpdateIdle?: boolean;
    autoUpdateIntervalHours?: number;
  };
  workspaceRoot?: string;
  /** Set by the desktop shell once the user has chosen a mode. */
  onboardingCompleted?: boolean;
}

/** Absolute path of the workspace settings file. */
export function settingsFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.superiu', 'ui-settings.json');
}

/** Read `<workspace>/.superiu/ui-settings.json`, tolerating a missing/broken file. */
export function readDesktopSettings(workspaceRoot: string): DesktopSettings {
  const file = settingsFilePath(workspaceRoot);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as DesktopSettings;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the settings file, preserving every key this module does
 * not own.
 *
 * A read-modify-write (never a whole-file replace): the file is shared with the
 * SPA's server, which owns `apiKey`, `providers` and the rest of `UiSettings`.
 * A corrupt or missing file is treated as `{}` so the patch still lands rather
 * than throwing.
 */
export function writeDesktopSettings(workspaceRoot: string, patch: Partial<DesktopSettings>): void {
  const file = settingsFilePath(workspaceRoot);
  const current = readDesktopSettings(workspaceRoot);
  const next: DesktopSettings = { ...current, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 0o600, matching `@agent/ui`'s `persistSettings`: on a fresh install the
  // desktop shell is now the FIRST creator of this file (onboarding writes it
  // before the SPA server exists), and Node's `mode` only applies at creation —
  // so omitting it here would leave a file that later holds `apiKey` at 0644
  // (umask 022) and no subsequent SPA save could tighten it.
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  // `mode` is ignored when the file already exists, so tighten a file this flow
  // may have created before the mode was passed (or one hand-edited wider).
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort: a filesystem without POSIX modes must not fail the write.
  }
}

/**
 * Resolve the effective connection configuration.
 *
 * Environment variables take precedence over the settings file, matching how
 * every other shell reads provider credentials. An empty string is treated as
 * "unset" so a blank env var cannot shadow a configured setting.
 *
 * Mode precedence: an explicit `connectionMode` (env then settings) wins; that
 * falls back to `remote` when an ssh alias is configured, then `gateway` when
 * both a url and token are present, then `local`.
 */
export function resolveGatewayConfig(workspaceRoot: string): GatewayConfig {
  const settings = readDesktopSettings(workspaceRoot);

  const envUrl = process.env.SUPERIU_GATEWAY_URL?.trim() || undefined;
  const envToken = process.env.SUPERIU_GATEWAY_TOKEN?.trim() || undefined;
  const settingUrl = settings.gateway?.url?.trim() || undefined;
  const settingToken = settings.gateway?.token?.trim() || undefined;

  const url = envUrl ?? settingUrl;
  const token = envToken ?? settingToken;

  // Custom-URL connection: env wins, empty string is "unset".
  const envCustomUrl = process.env.SUPERIU_CUSTOM_URL?.trim() || undefined;
  const settingCustomUrl = settings.customUrl?.url?.trim() || undefined;
  const customUrl = envCustomUrl ?? settingCustomUrl;
  const envCustomToken = process.env.SUPERIU_CUSTOM_TOKEN?.trim() || undefined;
  const settingCustomToken = settings.customUrl?.token?.trim() || undefined;
  const customToken = envCustomToken ?? settingCustomToken;

  // Remote alias: env wins, empty string is "unset".
  const envAlias = process.env.SUPERIU_REMOTE_ALIAS?.trim() || undefined;
  const settingAlias = settings.remote?.alias?.trim() || undefined;
  const alias = envAlias ?? settingAlias;

  // Remote workspace: env wins, empty string is "unset"; falls back to the
  // local workspace root when unset (a sensible default remote path).
  const envRemoteWorkspace = process.env.SUPERIU_REMOTE_WORKSPACE?.trim() || undefined;
  const settingRemoteWorkspace = settings.remote?.workspace?.trim() || undefined;

  const rawMode = (process.env.SUPERIU_CONNECTION_MODE ?? settings.connectionMode ?? '')
    .trim()
    .toLowerCase();
  const explicitMode: ConnectionMode | undefined =
    rawMode === 'local'
      ? 'local'
      : rawMode === 'gateway'
        ? 'gateway'
        : rawMode === 'remote'
          ? 'remote'
          : rawMode === 'custom_url'
            ? 'custom_url'
            : undefined;

  // A gateway is usable only with both halves of the credential pair. Without
  // them the shell would connect and be rejected, which is strictly worse than
  // falling back to the working local experience.
  const hasGateway = Boolean(url && token);
  const hasRemote = Boolean(alias);
  const mode: ConnectionMode =
    explicitMode ?? (hasRemote ? 'remote' : hasGateway ? 'gateway' : 'local');

  const workspace = settings.workspaceRoot?.trim();
  const resolvedWorkspaceRoot = workspace
    ? path.isAbsolute(workspace)
      ? workspace
      : path.resolve(workspaceRoot, workspace)
    : workspaceRoot;

  const remote: RemoteConfig | undefined = alias
    ? {
        alias,
        workspace: envRemoteWorkspace ?? settingRemoteWorkspace ?? resolvedWorkspaceRoot,
        releaseBase: settings.remote?.releaseBase?.trim() || undefined,
        version: settings.remote?.version?.trim() || undefined,
        localPort:
          typeof settings.remote?.localPort === 'number' && Number.isFinite(settings.remote.localPort)
            ? settings.remote.localPort
            : undefined,
        autoUpdateIdle:
          typeof settings.remote?.autoUpdateIdle === 'boolean'
            ? settings.remote.autoUpdateIdle
            : undefined,
        autoUpdateIntervalHours:
          typeof settings.remote?.autoUpdateIntervalHours === 'number' &&
          Number.isFinite(settings.remote.autoUpdateIntervalHours) &&
          settings.remote.autoUpdateIntervalHours > 0
            ? settings.remote.autoUpdateIntervalHours
            : undefined
      }
    : undefined;

  const customUrlConfig: CustomUrlConfig | undefined =
    mode === 'custom_url' ? { url: customUrl ?? '', token: customToken } : undefined;

  return {
    mode,
    url: mode === 'custom_url' ? customUrl : url,
    token: mode === 'custom_url' ? customToken : token,
    deviceId: settings.gateway?.deviceId?.trim() || undefined,
    workspaceRoot: resolvedWorkspaceRoot,
    remote,
    customUrl: customUrlConfig
  };
}

/**
 * Decide whether the first-run onboarding must be shown.
 *
 * Precedence (frozen by the onboarding contract):
 *   1. `SUPERIU_SKIP_ONBOARDING=1`  → never show (false)
 *   2. `SUPERIU_FORCE_ONBOARDING=1` → always show (true)
 *   3. `settings.onboardingCompleted === true` → false
 *   4. an explicit `connectionMode` of local|gateway|remote|custom_url → false
 *   5. `gateway.mode !== 'local'` (a gateway/remote is already configured) → false
 *   6. otherwise → true
 *
 * `gateway` is the already-resolved config from {@link resolveGatewayConfig},
 * so the `SUPERIU_CONNECTION_MODE` env escape hatch is inherited for free.
 */
export function needsOnboarding(settings: DesktopSettings, gateway: GatewayConfig): boolean {
  if (process.env.SUPERIU_SKIP_ONBOARDING === '1') return false;
  if (process.env.SUPERIU_FORCE_ONBOARDING === '1') return true;
  if (settings.onboardingCompleted === true) return false;
  const mode = settings.connectionMode?.trim().toLowerCase();
  if (mode === 'local' || mode === 'gateway' || mode === 'remote' || mode === 'custom_url') return false;
  if (gateway.mode !== 'local') return false;
  return true;
}

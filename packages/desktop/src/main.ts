/**
 * SuperIU — macOS native desktop shell.
 *
 * ── Why this package exists ─────────────────────────────────────────────────
 * `@agent/ui` is a plain `node:http` server plus a static SPA. In a browser tab
 * the OS/browser owns `Cmd+Q` and `Cmd+,` — a web page cannot intercept them, so
 * "native macOS operations" (quit, settings, window control) is undeliverable
 * without a native shell. This main process provides exactly that: a real
 * Electron application Menu, native window chrome, and a single-instance app
 * lifecycle, while reusing the existing UI server in-process.
 */

import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  dialog,
  ipcMain,
  nativeTheme,
  shell
} from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer, type ServerHandle } from '@agent/ui';

import {
  INVOKE,
  THEME_CHANNEL,
  REMOTE_PROGRESS_CHANNEL,
  UPDATE_STATE_CHANNEL,
  type NotificationPayload,
  type ThemePayload
} from './ipc.js';
import { GatewayClient } from './gateway_client.js';
import { WorkspaceSandboxWorker } from './sandbox/worker.js';
import { ABOUT_LABELS, buildMenuTemplate, createMenuDispatcher } from './menu.js';
import {
  checkForUpdate,
  installPreparedUpdate,
  getUpdateState,
  onUpdateState,
  type UpdateState
} from './updater.js';
import {
  RemoteConnectionManager,
  RemoteConnectionError,
  readSshConfig,
  type RemoteStep
} from './remote/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'SuperIU';

/**
 * Root of the shipped application payload.
 *
 * Packaged, that is `Contents/Resources/app` (where the bundle places `dist/`,
 * `docs/` and `node_modules/`); in development it is `packages/desktop`, one
 * level above `dist/`. `app.isPackaged` is the only reliable discriminator —
 * deriving it from the directory depth alone breaks in one of the two layouts.
 */
function appRoot(): string {
  return app.getAppPath();
}

/** Window geometry: generous default, sane floor for the three-pane layout. */
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 860;
const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------
// Acquired BEFORE anything heavy so a second launch never starts a second HTTP
// server / AgentRunner (and therefore never opens a second set of DB handles).

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let serverHandle: ServerHandle | null = null;
let gatewayClient: GatewayClient | null = null;
let remoteManager: RemoteConnectionManager | null = null;
let shuttingDown = false;

// ---------------------------------------------------------------------------
// Connection mode resolution
// ---------------------------------------------------------------------------
// The desktop shell can run in three modes:
//
//   - `local`   — the historical standalone experience: boot the in-process
//                 `@agent/ui` server and point the window at it.
//   - `gateway` — act as a remote workspace/sandbox client for a VPS Gateway:
//                 maintain a persistent WebSocket, serve reverse RPC
//                 (`fs.readFile` / `fs.writeFile` / `bash.execute`) against the
//                 user's local folder, and gate dangerous commands behind a
//                 native approval dialog.
//   - `remote`  — the SSH-managed flow: read `~/.ssh/config`, provision/start
//                 the daemon on the VPS over ssh, open a local port-forward, and
//                 then connect a `GatewayClient` to the tunnelled local port —
//                 all orchestrated by `RemoteConnectionManager`.
//
// A gateway is considered configured when both a URL and a token are present,
// either through the environment (`SUPERIU_GATEWAY_URL` + `SUPERIU_GATEWAY_TOKEN`)
// or the persisted settings file (`gateway.url` / `gateway.token`). A remote
// connection is considered configured when an ssh alias is present (env
// `SUPERIU_REMOTE_ALIAS` or `remote.alias`). The explicit
// `SUPERIU_CONNECTION_MODE` / `connectionMode` setting wins over the mere
// presence of either, so an operator can pin local startup while a gateway or
// remote host is still configured.

type ConnectionMode = 'local' | 'gateway' | 'remote';

interface GatewayConfig {
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
}

/** Resolved settings for the SSH-managed `remote` mode. */
interface RemoteConfig {
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
}

/** Parsed subset of `ui-settings.json` relevant to the desktop connection. */
interface DesktopSettings {
  connectionMode?: string;
  gateway?: { url?: string; token?: string; deviceId?: string; deviceName?: string };
  remote?: { alias?: string; workspace?: string; releaseBase?: string; version?: string; localPort?: number };
  workspaceRoot?: string;
}

/** Read `<workspace>/.superiu/ui-settings.json`, tolerating a missing/broken file. */
function readDesktopSettings(workspaceRoot: string): DesktopSettings {
  const file = path.join(workspaceRoot, '.superiu', 'ui-settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as DesktopSettings;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
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
function resolveGatewayConfig(workspaceRoot: string): GatewayConfig {
  const settings = readDesktopSettings(workspaceRoot);

  const envUrl = process.env.SUPERIU_GATEWAY_URL?.trim() || undefined;
  const envToken = process.env.SUPERIU_GATEWAY_TOKEN?.trim() || undefined;
  const settingUrl = settings.gateway?.url?.trim() || undefined;
  const settingToken = settings.gateway?.token?.trim() || undefined;

  const url = envUrl ?? settingUrl;
  const token = envToken ?? settingToken;

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
    rawMode === 'local' ? 'local' : rawMode === 'gateway' ? 'gateway' : rawMode === 'remote' ? 'remote' : undefined;

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
            : undefined
      }
    : undefined;

  return {
    mode,
    url,
    token,
    deviceId: settings.gateway?.deviceId?.trim() || undefined,
    workspaceRoot: resolvedWorkspaceRoot,
    remote
  };
}

// The native menu is installed at module scope, before `ready` — too early to
// read the persisted settings file. It is therefore seeded again in `bootstrap`
// from the resolved handle, which is the first point the file is authoritative.
let uiLanguage: 'zh' | 'en' = 'zh';

// ---------------------------------------------------------------------------
// Native appearance
// ---------------------------------------------------------------------------

/**
 * Tell the focused renderer the appearance changed.
 *
 * `nativeTheme.themeSource` is what makes `prefers-color-scheme` agree with the
 * pinned preference inside the renderer, so this event is the desktop shell's
 * authoritative "re-resolve now" signal — both for an OS-level change while the
 * preference is `system`, and for a `themeSource` override applied here.
 */
function broadcastTheme(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload: ThemePayload = { scheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' };
  mainWindow.webContents.send(THEME_CHANNEL, payload);
}

/**
 * Bridge OS appearance changes into the renderer.
 *
 * Registered synchronously, before `ready`: a system switch during startup must
 * not be missed, and `nativeTheme` is usable from the moment the main process
 * starts. `themeSource` is never written from here — the renderer owns the
 * preference, and a write would race it.
 */
function installThemeSync(): void {
  nativeTheme.on('updated', broadcastTheme);
}

// ---------------------------------------------------------------------------
// Menu → renderer bridge
// ---------------------------------------------------------------------------

/** Forward a menu action to the focused window's renderer. */
const dispatchToRenderer = createMenuDispatcher((channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
});

function openDocs(): void {
  // The bundler ships `docs/` inside the app payload; a development checkout
  // keeps them at the repository root, one level above `packages/desktop`.
  const candidates = [
    path.join(appRoot(), 'docs', 'shells-guide.md'),
    path.resolve(appRoot(), '..', '..', 'docs', 'shells-guide.md')
  ];
  const doc = candidates.find((candidate) => fs.existsSync(candidate));
  if (!doc) {
    console.warn('[superiu] documentation not found; looked in:', candidates.join(', '));
    return;
  }
  void shell.openPath(doc);
}

function installApplicationMenu(): void {
  const template = buildMenuTemplate(
    {
      dispatch: dispatchToRenderer,
      openDocs
    },
    APP_NAME,
    uiLanguage
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Configure the native About panel for the current {@link uiLanguage}.
 *
 * Called at module scope (before `ready`, like {@link installApplicationMenu})
 * so the panel is never unconfigured, again from `bootstrap` once the settings
 * file has supplied the real language, and again from the `setLanguage` IPC
 * handler — AppKit keeps whatever was set last, and the language CAN change at
 * runtime, so a one-shot call at startup would leave the panel in the previous
 * language.
 *
 * `credits` is the only localized field: `applicationName` is the product name
 * (fixed by the bundle identity) and `copyright` is a year plus that same name.
 * The line repeats the SPA's `settings.about.product` string so the native and
 * in-app About surfaces cannot describe the product in two vocabularies.
 */
function installAboutPanel(): void {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: `© ${new Date().getFullYear()} SuperIU`,
    credits: (ABOUT_LABELS[uiLanguage] ?? ABOUT_LABELS.zh).credits
  });
}

// ---------------------------------------------------------------------------
// Silent updates
// ---------------------------------------------------------------------------
// The updater owns the network work and publishes a state machine; this shell
// owns every user-visible consequence of it. The split exists because the
// download must not block or decorate the app: it happens in a temp directory
// while the user keeps working, and the only surfaces are the Dock progress
// bar (during) and an offer to restart (after).

/** Last version whose "restart to install" offer was shown, so it shows once. */
let promptedUpdateVersion: string | null = null;
/** Last error message surfaced, so a repeated failure does not re-open dialogs. */
let shownUpdateError: string | null = null;
/** Whether the current native menu shows the install item, so rebuilds are rare. */
let menuInstallVisible = false;

/**
 * Mirror download progress onto the Dock, and clear it for every other phase.
 *
 * `-1` is the documented "remove the bar" value. The progress bar is a
 * `BrowserWindow` property (Electron has no `app.setProgressBar`; verified
 * against 44.4.3 at runtime — `app`, `app.dock` and the `Dock` prototype expose
 * only `setBadge`/`setBadgeCount`), and it renders in the macOS Dock while the
 * window exists. Window and call are both guarded: an update can be discovered
 * before the window is up, and closing the window must not break the download.
 */
function mirrorUpdateProgress(state: UpdateState): void {
  const progress =
    state.phase === 'downloading' && typeof state.percent === 'number'
      ? Math.min(1, Math.max(0, state.percent / 100))
      : -1;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setProgressBar(progress);
  } catch {
    // No Dock (headless launch, unsupported platform): progress is a nicety.
  }
}

/**
 * Tell the user an update is staged, once per version.
 *
 * A native notification reaches a backgrounded app; the dialog is the durable
 * surface with the actual choice. The version is recorded by the caller BEFORE
 * this runs, so a second `ready` state for the same version cannot double-show.
 */
async function announceUpdateReady(version: string, releaseNotes?: string): Promise<void> {
  if (Notification.isSupported()) {
    new Notification({
      title: '更新已就绪',
      body: `SuperIU ${version} 已在后台下载完成，重启即可安装。`
    }).show();
  }

  const options = {
    type: 'info' as const,
    buttons: ['立即重启并安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: '更新已就绪',
    message: `SuperIU ${version} 已下载完成`,
    detail: releaseNotes?.trim()
      ? releaseNotes.slice(0, 2000)
      : '更新已在后台下载并校验完成，重启应用即可安装。'
  };
  const { response } =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);

  if (response === 0) {
    // Failures publish an 'error' state, which the listener below reports; this
    // catch only keeps a rejected promise from going unhandled.
    void installPreparedUpdate().catch((err) => {
      console.error('[superiu] failed to install update:', err);
    });
  }
}

/** Report a failed download once per distinct message. */
async function announceUpdateFailure(message: string): Promise<void> {
  const options = {
    type: 'error' as const,
    buttons: ['好'],
    defaultId: 0,
    noLink: true,
    title: '更新失败',
    message
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    await dialog.showMessageBox(mainWindow, options);
  } else {
    await dialog.showMessageBox(options);
  }
}

/**
 * The one subscription that translates updater state into shell behaviour.
 *
 * Registered at module scope (before `ready`, like the other installs) so no
 * state published during early bootstrap is missed.
 */
onUpdateState((state: UpdateState) => {
  mirrorUpdateProgress(state);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(UPDATE_STATE_CHANNEL, state);
  }
  // Rebuild on a readiness CHANGE, not on every state: this is what makes
  // 重启以安装更新 appear and disappear (the item is rendered from
  // `canInstallUpdate()`), while progress ticks — one per download chunk — stay
  // cheap instead of re-creating the whole native menu thousands of times. The
  // cached flag starts false, matching the initial `idle` menu built at module
  // scope, so no rebuild is owed until the phase actually changes.
  const canInstall = state.phase === 'ready';
  if (canInstall !== menuInstallVisible) {
    menuInstallVisible = canInstall;
    installApplicationMenu();
  }

  if (state.phase === 'ready' && promptedUpdateVersion !== state.latestVersion) {
    promptedUpdateVersion = state.latestVersion;
    void announceUpdateReady(state.latestVersion, state.releaseNotes);
  }

  if (state.phase === 'error' && state.error && shownUpdateError !== state.error) {
    shownUpdateError = state.error;
    void announceUpdateFailure(state.error);
  }
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: APP_NAME,
    // Native traffic lights inset into the page — the SPA renders its own
    // header bar with a matching drag region (`.titlebar`).
    titleBarStyle: 'hiddenInset',
    // Native translucent material. `transparent` stays false: vibrancy needs a
    // fully transparent *background colour*, not a transparent window.
    vibrancy: 'under-window',
    backgroundColor: '#00000000',
    transparent: false,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.once('ready-to-show', () => win.show());

  // Keep the OS window title in sync with the SPA's own document title.
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    win.setTitle(title || APP_NAME);
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  void win.loadURL(url);
  return win;
}

/** Focus the existing window (dock click, or a blocked second launch). */
function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (serverHandle) {
      mainWindow = createWindow(serverHandle.url);
    } else if (remoteManager) {
      showGatewayStatus(
        resolveGatewayConfig(process.cwd()),
        remoteManager.gatewayClient?.connectionState ?? 'connecting'
      );
    } else if (gatewayClient) {
      showGatewayStatus(resolveGatewayConfig(process.cwd()), gatewayClient.connectionState);
    }
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Gateway mode
// ---------------------------------------------------------------------------

/**
 * Native approval gate for dangerous shell commands.
 *
 * Injected into {@link GatewayClient} as `onApprovalRequired`, so the sandbox
 * worker never runs a destructive command without an explicit human decision on
 * the machine that would be affected. The dialog is modal to the main window and
 * defaults to Cancel: pressing Escape (or closing it) rejects the command.
 */
async function approveDangerousCommand(command: string): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Run'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Approve command',
    message: 'A remote request wants to run a dangerous command on this Mac.',
    detail: command.length > 2000 ? `${command.slice(0, 2000)}…` : command
  };
  const { response } =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
  return response === 1;
}

/**
 * Minimal status surface for gateway / remote modes.
 *
 * Gateway and remote modes intentionally do NOT boot the local `@agent/ui`
 * server — the gateway owns the console, and this process is only its remote
 * workspace. A window still has to exist or the app reads as a headless zombie
 * (and macOS would refuse to focus it), so this renders a few plain-text lines of
 * connection status. It is deliberately un-styled: it exists to be legible, not
 * to be a designed surface.
 */
function gatewayStatusHtml(
  config: GatewayConfig,
  state: string,
  remote?: { step?: RemoteStep; detail?: string }
): string {
  const safe = (value: string): string =>
    value.replace(/[&<>"]/g, (ch) =>
      ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;'
    );

  const isRemote = config.mode === 'remote' && Boolean(config.remote);
  const headline = isRemote
    ? `${safe(APP_NAME)} is connecting to a remote VPS over SSH.`
    : `${safe(APP_NAME)} is connected as a remote workspace.`;

  // Remote mode shows the ssh alias/workspace and whichever step is current,
  // instead of the (nonexistent) local gateway URL.
  const remoteLines = isRemote && config.remote
    ? `
  <p>Host: <code>${safe(config.remote.alias)}</code></p>
  <p>Remote workspace: <code>${safe(config.remote.workspace)}</code></p>
  <p>Step: <code>${safe(remote?.step ? `${remote.step.id} — ${remote.step.status}` : '—')}</code></p>
  ${remote?.detail ? `<p>Detail: <code>${safe(remote.detail)}</code></p>` : ''}`
    : `
  <p>Gateway: <code>${safe(config.url ?? '—')}</code></p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${safe(APP_NAME)}</title></head>
<body style="font-family: -apple-system, system-ui, sans-serif; padding: 2rem; color: #888;">
  <p>${headline}</p>${remoteLines}
  <p>Workspace: <code>${safe(config.workspaceRoot)}</code></p>
  <p>Status: <strong>${safe(state)}</strong></p>
</body></html>`;
}

/** Create the gateway-mode window (or reuse the existing one) showing `state`. */
function showGatewayStatus(
  config: GatewayConfig,
  state: string,
  remote?: { step?: RemoteStep; detail?: string }
): void {
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(gatewayStatusHtml(config, state, remote))}`;
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow(url);
    return;
  }
  void mainWindow.loadURL(url);
}

/**
 * Boot gateway mode: connect to the VPS Gateway and serve reverse RPC against
 * the local workspace.
 *
 * Returns once the client has been constructed and `connect()` called; the
 * handshake and reconnects are asynchronous by design, so the window reflects
 * the live `onStateChange` rather than blocking startup on the first ack.
 */
function startGatewayMode(config: GatewayConfig): void {
  if (!config.url || !config.token) {
    throw new Error('gateway mode requires both a url and a token');
  }

  const client = new GatewayClient({
    url: config.url,
    token: config.token,
    workspaceRoot: config.workspaceRoot,
    ...(config.deviceId ? { deviceId: config.deviceId } : {}),
    onApprovalRequired: approveDangerousCommand,
    onStateChange: (state) => {
      console.log(`[superiu] gateway ${state}`);
      showGatewayStatus(config, state);
    },
    onEvent: (event) => {
      // Events are the gateway console's to render; in gateway mode this process
      // has no local SPA, so it only surfaces them for diagnostics.
      console.log(`[superiu] gateway event ${event.type} (session ${event.sessionId})`);
    }
  });

  gatewayClient = client;
  // `connect()` synchronously transitions `idle → connecting`, which fires
  // `onStateChange` and paints the first status window; no separate initial
  // render is needed here.
  client.connect();
  console.log(`[superiu] gateway mode → ${config.url} (workspace ${config.workspaceRoot})`);
}

/** Close the gateway connection exactly once. */
function closeGateway(): void {
  const client = gatewayClient;
  gatewayClient = null;
  if (!client) return;
  try {
    client.close();
  } catch (err) {
    console.error('[superiu] failed to close gateway client:', err);
  }
}

// ---------------------------------------------------------------------------
// Remote (SSH-managed) mode
// ---------------------------------------------------------------------------

/**
 * Boot remote mode: parse `~/.ssh/config`, provision/start the daemon on the VPS
 * over ssh, open a local port-forward, and connect a `GatewayClient` to the
 * tunnelled local port — all via {@link RemoteConnectionManager}.
 *
 * `resolveHost` is wired to {@link readSshConfig} so an alias defined in the
 * user's ssh config (with a non-standard port / identity file / user) is honoured
 * by the tunnel rather than being assumed to be a bare hostname. `readSshConfig`
 * never throws: when `~/.ssh/config` is missing it returns `[]` and the alias is
 * passed to ssh unresolved, which ssh itself then resolves.
 */
async function startRemoteMode(config: GatewayConfig): Promise<void> {
  const remote = config.remote;
  if (!remote) {
    throw new Error('remote mode requires a remote alias');
  }

  // First paint before any ssh work begins, so the user sees the flow start
  // instead of a blank window during a slow probe/install.
  showGatewayStatus(config, 'connecting', {
    step: { id: 'probe', status: 'active' }
  });

  const manager = new RemoteConnectionManager({
    resolveHost: async (alias) => {
      try {
        const entries = await readSshConfig();
        return entries.find((entry) => entry.alias === alias);
      } catch {
        // `readSshConfig` is documented never to throw; this is belt-and-braces
        // so a surprise still lets ssh resolve the alias itself.
        return undefined;
      }
    }
  });
  remoteManager = manager;

  // Progress → log + status window + main window.
  const onProgress = (step: RemoteStep): void => {
    const detail = step.detail ? ` (${step.detail})` : '';
    console.log(`[superiu] remote ${step.id}: ${step.status}${detail}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(REMOTE_PROGRESS_CHANNEL, {
        id: step.id,
        status: step.status,
        detail: step.detail
      });
    }
  };

  try {
    const result = await manager.connect({
      alias: remote.alias,
      workspace: remote.workspace,
      deviceId: config.deviceId,
      releaseBase: remote.releaseBase,
      version: remote.version,
      localPort: remote.localPort,
      onProgress,
      onApprovalRequired: approveDangerousCommand,
      onEvent: (event) => {
        // Events belong to the gateway console; this process has no local SPA in
        // remote mode, so they are surfaced for diagnostics only.
        console.log(`[superiu] remote event ${event.type} (session ${event.sessionId})`);
      }
    });

    // The manager connects the GatewayClient internally; reflect its live state.
    console.log(
      `[superiu] remote mode → ${result.localUrl} via ${remote.alias} (workspace ${remote.workspace})`
    );
    showGatewayStatus(config, result.gatewayClient.connectionState, {
      step: { id: 'client', status: 'done' },
      detail: `tunnel port ${result.tunnelPort}`
    });
  } catch (err) {
    // Surface the failing step and STOP. Deliberately no silent fallback to
    // local mode: that would boot a second AgentRunner/DB handle set the user
    // did not ask for. A visible status window (already painted by onProgress)
    // plus a logged error is the contract.
    const step = err instanceof RemoteConnectionError ? err.step : undefined;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[superiu] remote mode failed at step ${step ?? 'unknown'}: ${message}`);
    showGatewayStatus(config, `failed (${step ?? 'unknown'})`, {
      step: step ? { id: step, status: 'failed' } : undefined,
      detail: message
    });
    // Tear the half-open manager down (closes the tunnel + client) but never the
    // remote daemon.
    await manager.disconnect().catch(() => undefined);
    if (remoteManager === manager) remoteManager = null;
    throw new RemoteConnectionError(
      step ?? 'probe',
      `remote connection failed at step ${step ?? 'unknown'}: ${message}`,
      err
    );
  }
}

/**
 * Close the remote transport exactly once.
 *
 * Calls {@link RemoteConnectionManager.disconnect}, which closes the gateway
 * client and the ssh tunnel but deliberately leaves the VPS daemon running: the
 * whole point of remote mode is that the VPS keeps working when the laptop goes
 * away.
 */
async function closeRemote(): Promise<void> {
  const manager = remoteManager;
  remoteManager = null;
  if (!manager) return;
  try {
    await manager.disconnect();
  } catch (err) {
    console.error('[superiu] failed to disconnect remote manager:', err);
  }
}

// ---------------------------------------------------------------------------
// Renderer → main IPC (badge, notifications, quit)
// ---------------------------------------------------------------------------

function installIpcHandlers(): void {
  ipcMain.handle(INVOKE.setBadgeCount, (_event, count: number) => {
    app.setBadgeCount(Number.isFinite(count) ? Math.trunc(count) : 0);
  });

  ipcMain.handle(INVOKE.showNotification, (_event, payload: NotificationPayload) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: payload?.title ?? APP_NAME,
      body: payload?.body ?? ''
    });
    notification.on('click', () => focusMainWindow());
    notification.show();
  });

  ipcMain.handle(INVOKE.flashFrame, () => {
    mainWindow?.flashFrame(true);
  });

  ipcMain.handle(INVOKE.quit, () => {
    app.quit();
  });

  // Only the two known ids rebuild the menu; anything else (a stale renderer,
  // a hand-crafted message) leaves the current menu untouched.
  //
  // The native About panel is rebuilt too: its `credits` line is localized, and
  // a language switch must not leave it describing the product in the language
  // the user just left.
  ipcMain.handle(INVOKE.setLanguage, (_event, language: string) => {
    if (language !== 'zh' && language !== 'en') return;
    uiLanguage = language;
    installApplicationMenu();
    installAboutPanel();
  });

  // Same allow-list discipline as the language handler: an unknown value is
  // ignored rather than handed to `nativeTheme`, which would throw on it.
  //
  // No explicit broadcast here: writing a CHANGED `themeSource` emits
  // `updated` (verified against Electron 44), and `installThemeSync` already
  // forwards that to the renderer. Assigning the value that is already in force
  // emits nothing — and needs nothing, because the renderer painted the scheme
  // locally before it called us.
  ipcMain.handle(INVOKE.setTheme, (_event, theme: string) => {
    if (theme !== 'system' && theme !== 'dark' && theme !== 'light') return;
    nativeTheme.themeSource = theme;
  });

  ipcMain.handle(INVOKE.getSshHosts, async () => {
    try {
      const entries = await readSshConfig();
      return entries.map((e) => ({
        alias: e.alias,
        hostName: e.hostName,
        user: e.user
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle(INVOKE.connectRemote, async (_event, options: { alias: string; workspace: string; saveDefault?: boolean }) => {
    if (options.saveDefault) {
      try {
        const workspace = app.isPackaged ? app.getPath('home') : process.cwd();
        const settingsFile = path.join(workspace, '.superiu', 'ui-settings.json');
        let current: any = {};
        if (fs.existsSync(settingsFile)) {
          current = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        }
        current.connectionMode = 'remote';
        current.remote = {
          alias: options.alias,
          workspace: options.workspace
        };
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        fs.writeFileSync(settingsFile, JSON.stringify(current, null, 2), 'utf-8');
      } catch (e) {
        console.warn('[superiu] failed to persist default remote settings:', e);
      }
    }

    const config: GatewayConfig = {
      mode: 'remote',
      workspaceRoot: options.workspace,
      remote: {
        alias: options.alias,
        workspace: options.workspace
      }
    };

    await startRemoteMode(config);
  });

  ipcMain.handle(INVOKE.checkForUpdate, async () => {
    await checkForUpdate(true);
  });

  ipcMain.handle(INVOKE.installUpdate, async () => {
    await installPreparedUpdate();
  });

  ipcMain.handle(INVOKE.getUpdateState, () => {
    return getUpdateState();
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Tear down the in-process HTTP server + AgentRunner exactly once. */
async function closeServer(): Promise<void> {
  const handle = serverHandle;
  serverHandle = null;
  if (!handle) return;
  try {
    await handle.close();
  } catch (err) {
    console.error('[superiu] failed to close UI server:', err);
  }
}

/** Tear down whichever transport mode is active, exactly once. */
async function shutdown(): Promise<void> {
  closeGateway();
  await closeRemote();
  await closeServer();
}

app.on('second-instance', () => {
  focusMainWindow();
});

app.on('activate', () => {
  focusMainWindow();
});

app.on('window-all-closed', () => {
  // macOS convention: closing the last window keeps the app (and its server)
  // alive; the dock icon re-opens a window via `activate`.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  // Give the async teardown a chance to finish so no orphan process or open
  // SQLite handle outlives the app.
  event.preventDefault();
  shuttingDown = true;
  void shutdown().finally(() => app.exit(0));
});

installAboutPanel();

// ESM caveat (verified against Electron 44): the `ready` event is emitted only
// AFTER the entry module has finished evaluating. A top-level
// `await app.whenReady()` therefore deadlocks — the await blocks evaluation,
// which blocks the very event it is waiting for. Bootstrap is therefore kicked
// off without awaiting it at module scope, so evaluation completes and Electron
// can go ready.
//
// Everything that does not require `ready` is registered synchronously first.
async function bootstrap(): Promise<void> {
  await app.whenReady();

  // A bundled app launched from Finder or Spotlight inherits `cwd = /`, which is
  // not writable: the engine's first `mkdir .superiu/…` would throw ENOENT and
  // the app would exit before showing a window. A GUI app has no "directory it
  // was started from", so the workspace is the user's home — the same place the
  // engine already falls back to for memory. `chdir` (rather than only passing
  // `workspaceDir`) keeps every cwd-relative path in the engine coherent, and
  // the explicit option means the session store never depends on that.
  const workspace = app.isPackaged ? app.getPath('home') : process.cwd();
  process.chdir(workspace);

  // Resolve the transport first: in gateway/remote mode the shell is a remote
  // workspace/sandbox client for the VPS Gateway and must NOT boot the local
  // `@agent/ui` server (that would open a second AgentRunner and DB handle set
  // for a console the gateway already owns). Local mode is the historical
  // standalone experience and remains the fallback whenever no gateway/remote is
  // configured or the mode is pinned to `local`.
  const gateway = resolveGatewayConfig(workspace);

  if (gateway.mode === 'remote') {
    console.log(`[superiu] workspace ${workspace}`);
    // A remote failure is surfaced and logged by `startRemoteMode`, which then
    // rethrows so `bootstrap().catch` below can exit non-zero. We deliberately
    // do NOT fall back to local mode: that would start a second AgentRunner the
    // user did not ask for.
    await startRemoteMode(gateway);
    return;
  }

  if (gateway.mode === 'gateway') {
    console.log(`[superiu] workspace ${workspace}`);
    startGatewayMode(gateway);
    return;
  }

  serverHandle = await startServer({ port: 0, quiet: true, workspaceDir: workspace });
  console.log(`[superiu] workspace ${workspace}`);
  console.log(`[superiu] UI server listening on ${serverHandle.url}`);

  // Now that the settings file has been read, rebuild the menu so the first
  // paint matches it instead of the module-scope default.
  uiLanguage = serverHandle.language;
  installApplicationMenu();
  installAboutPanel();

  // Mirror the persisted appearance onto the native side BEFORE the window
  // exists: `nativeTheme.themeSource` is what makes `prefers-color-scheme`
  // inside the renderer agree with a pinned Dark/Light choice, and the page
  // reads that query in its pre-paint script. Applying it after `loadURL` would
  // leave the very first paint resolving against the OS default.
  nativeTheme.themeSource = serverHandle.theme;

  mainWindow = createWindow(serverHandle.url);

  // Silent background update probe. Delayed so it never competes with startup
  // work, and skipped in development where there is no installable bundle. The
  // download it may start is invisible by design: progress and the restart
  // offer reach the user through the update-state listener above.
  if (app.isPackaged) {
    setTimeout(() => {
      void checkForUpdate(false);
    }, 5000);
  }
}

if (gotTheLock) {
  installApplicationMenu();
  installIpcHandlers();
  installThemeSync();

  void bootstrap().catch((err) => {
    console.error('[superiu] failed to start:', err);
    // If a status window is already on screen (a failed remote/gateway step
    // painted one before throwing), leave it up long enough to be read instead
    // of vanishing in a silent exit. The user can quit when done.
    if (mainWindow && !mainWindow.isDestroyed()) return;
    app.exit(1);
  });
}

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
  session,
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
  CONNECTION_STATE_CHANNEL,
  type ConnectionInfoPayload,
  type NotificationPayload,
  type ThemePayload
} from './ipc.js';
import {
  needsOnboarding,
  readDesktopSettings,
  resolveGatewayConfig,
  writeDesktopSettings,
  type GatewayConfig
} from './settings.js';
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
  decideNavigationFailure,
  decideRenderProcessGone,
  normalizeNavUrl,
  MAX_RENDERER_REVIVALS,
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
let onboardingWindow: BrowserWindow | null = null;
let serverHandle: ServerHandle | null = null;
let gatewayClient: GatewayClient | null = null;
let remoteManager: RemoteConnectionManager | null = null;
let activeRemoteUrl: string | null = null;
/** URL of the directly-connected custom service, when `mode === 'custom_url'`. */
let activeCustomUrl: string | null = null;
/** Pairing token for the custom service, mirrored into a cookie on connect. */
let customUrlToken: string | null = null;
/** Retries spent on the current SPA navigation (reset when the SPA commits). */
let remoteNavAttempts = 0;
/** Pending SPA reload timer for a failed navigation. */
let remoteNavTimer: NodeJS.Timeout | undefined;
/** When the current SPA navigation first failed; anchors the retry deadline. */
let spaNavStartedAt: number | null = null;
/** Times the SPA renderer has been revived in the current session. */
let remoteRendererRevivals = 0;
/** Windows already carrying the SPA recovery listeners (mainWindow is reused). */
const spaRecoveryAttached = new WeakSet<BrowserWindow>();

function getConnectionInfo(): ConnectionInfoPayload {
  if (activeCustomUrl) {
    return {
      mode: 'custom_url',
      customUrl: activeCustomUrl,
      state: 'connected'
    };
  }
  if (remoteManager && activeRemoteUrl) {
    const config = resolveGatewayConfig(resolveWorkspace());
    const client = remoteManager.gatewayClient;
    let localPort: number | undefined;
    try {
      localPort = Number(new URL(activeRemoteUrl).port) || undefined;
    } catch {}
    return {
      mode: 'remote',
      alias: config.remote?.alias,
      remoteWorkspace: config.remote?.workspace,
      localPort,
      advertiseUrl: config.remote?.advertiseUrl,
      state: client?.connectionState ?? 'connected',
      rttMs: client?.rttMs
    };
  }
  if (gatewayClient) {
    return {
      mode: 'gateway',
      state: gatewayClient.connectionState,
      rttMs: gatewayClient.rttMs
    };
  }
  return {
    mode: 'local',
    state: 'connected'
  };
}

function broadcastConnectionInfo(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(CONNECTION_STATE_CHANNEL, getConnectionInfo());
}
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

// The settings/connection-mode resolution itself lives in `./settings.js`, a
// pure (Electron-free) module so it can be unit-tested without an Electron
// runtime and imported before `app.whenReady()`.
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
// Background update loop (startup delay + periodic polling)
// ---------------------------------------------------------------------------
// Startup probe: 30 seconds delay so initial local server boot, SSH tunnels,
// and gateway handshakes have completely settled without network/CPU contention.
//
// Periodic polling: 1 hour between silent background checks.
const UPDATE_STARTUP_PROBE_DELAY_MS = 30 * 1000;
const UPDATE_POLL_INTERVAL_MS = 60 * 60 * 1000;

let updateProbeTimer: NodeJS.Timeout | undefined;
let updatePollTimer: NodeJS.Timeout | undefined;

function startBackgroundUpdateLoop(): void {
  if (updateProbeTimer || updatePollTimer) return;
  if (!app.isPackaged) return;

  updateProbeTimer = setTimeout(() => {
    updateProbeTimer = undefined;
    void checkForUpdate(false);
  }, UPDATE_STARTUP_PROBE_DELAY_MS);

  updatePollTimer = setInterval(() => {
    void checkForUpdate(false);
  }, UPDATE_POLL_INTERVAL_MS);
}

function stopBackgroundUpdateLoop(): void {
  if (updateProbeTimer) {
    clearTimeout(updateProbeTimer);
    updateProbeTimer = undefined;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = undefined;
  }
}

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

  attachSpaRecovery(win);
  void win.loadURL(url);
  return win;
}

/**
 * Make the remote-mode SPA navigation self-healing on `win`.
 *
 * Idempotent per window: `mainWindow` is reused across reconnects and a second
 * set of listeners would fire the retry twice. Every branch is gated on
 * `activeRemoteUrl`, so local/gateway windows (where it is null) never retry.
 *
 * `spaNavStartedAt` anchors the retry deadline and `remoteNavTimer` the pending
 * reload; both are module state because the window outlives any single connect.
 */
function attachSpaRecovery(win: BrowserWindow): void {
  if (spaRecoveryAttached.has(win)) return;
  spaRecoveryAttached.add(win);
  const wc = win.webContents;

  wc.on('did-navigate', (_event, url: string) => {
    if (activeRemoteUrl && normalizeNavUrl(url) === normalizeNavUrl(activeRemoteUrl)) {
      spaNavStartedAt = null;
      remoteNavAttempts = 0;
      remoteRendererRevivals = 0;
    }
  });

  wc.on(
    'did-fail-load',
    (
      _event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ) => {
      if (spaNavStartedAt === null) spaNavStartedAt = Date.now();
      const decision = decideNavigationFailure({
        errorCode,
        errorDescription,
        isMainFrame,
        url: validatedURL,
        targetUrl: activeRemoteUrl,
        attempts: remoteNavAttempts,
        elapsedMs: Date.now() - spaNavStartedAt
      });
      if (decision.kind === 'ignore') return;
      console.warn(
        `[superiu] remote SPA navigation failed (${errorCode}: ${errorDescription}) on ${validatedURL}`
      );
      if (decision.kind === 'retry') {
        remoteNavAttempts += 1;
        clearTimeout(remoteNavTimer);
        remoteNavTimer = setTimeout(() => {
          remoteNavTimer = undefined;
          if (activeRemoteUrl && !win.isDestroyed()) void win.loadURL(activeRemoteUrl);
        }, decision.delayMs);
        return;
      }
      if (mainWindow === win) {
        showGatewayStatus(resolveGatewayConfig(process.cwd()), `failed (${errorCode})`, {
          step: { id: 'client', status: 'failed' },
          detail: `Navigation failed: ${decision.message}`
        });
      }
    }
  );

  wc.on('render-process-gone', (_event, details: { reason: string }) => {
    if (decideRenderProcessGone(details.reason, activeRemoteUrl) === 'ignore') return;
    if (remoteRendererRevivals >= MAX_RENDERER_REVIVALS) {
      console.error(
        `[superiu] remote SPA renderer gone (${details.reason}); giving up after ${remoteRendererRevivals} revivals`
      );
      return;
    }
    remoteRendererRevivals += 1;
    spaNavStartedAt = null;
    remoteNavAttempts = 0;
    console.warn(
      `[superiu] remote SPA renderer gone (${details.reason}); reloading ${activeRemoteUrl}`
    );
    if (!win.isDestroyed() && activeRemoteUrl) void win.loadURL(activeRemoteUrl);
  });
}

/** Focus the existing window (dock click, or a blocked second launch). */
function focusMainWindow(): void {
  // A first-run window takes precedence while it is still needed: on macOS a
  // dock click must reopen it rather than leaving the app as a windowless
  // zombie (the local server / main window does not exist yet).
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    if (onboardingWindow.isMinimized()) onboardingWindow.restore();
    onboardingWindow.show();
    onboardingWindow.focus();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (serverHandle) {
      mainWindow = createWindow(serverHandle.url);
    } else if (activeRemoteUrl) {
      mainWindow = createWindow(activeRemoteUrl);
    } else if (remoteManager) {
      showGatewayStatus(
        resolveGatewayConfig(process.cwd()),
        remoteManager.gatewayClient?.connectionState ?? 'connecting'
      );
    } else if (gatewayClient) {
      showGatewayStatus(resolveGatewayConfig(process.cwd()), gatewayClient.connectionState);
    } else if (needsOnboarding(readDesktopSettings(resolveWorkspace()), resolveGatewayConfig(resolveWorkspace()))) {
      // Dock click with no window at all and no mode chosen yet: reopen the
      // first-run window instead of doing nothing.
      openOnboarding();
    }
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// First-run onboarding window
// ---------------------------------------------------------------------------
// A SEPARATE window from `mainWindow`. Remote mode paints a status page BEFORE
// any ssh work begins (and `showGatewayStatus` loadURLs it into `mainWindow`);
// if the wizard were `mainWindow`, the mode cards and the 7-step pipeline would
// be replaced the moment the pipeline started, and progress events would land on
// a page that cannot render them. So the wizard keeps its own window, fed
// progress through `RemoteModeOptions.progressTarget`.

/** The workspace root shared by `bootstrap` and the local starter. */
function resolveWorkspace(): string {
  return app.isPackaged ? app.getPath('home') : process.cwd();
}

/** Open the first-run window (idempotent: an open wizard is only re-focused). */
function openOnboarding(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    onboardingWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 560,
    height: 760,
    minWidth: 520,
    minHeight: 640,
    show: false,
    resizable: true,
    title: '首次启动 · SuperIU',
    // Same native chrome shape as `createWindow`: inset traffic lights and the
    // translucent under-window material the wizard's own tokens expect.
    titleBarStyle: 'hiddenInset',
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
  win.on('closed', () => {
    if (onboardingWindow === win) onboardingWindow = null;
  });

  onboardingWindow = win;
  void win.loadFile(path.join(HERE, 'views', 'onboarding.html'));
}

/** Close the first-run window (idempotent). */
function closeOnboarding(): void {
  const win = onboardingWindow;
  onboardingWindow = null;
  if (win && !win.isDestroyed()) win.destroy();
}

// ---------------------------------------------------------------------------
// Mode starters
// ---------------------------------------------------------------------------

/**
 * Boot local mode: the historical standalone experience, extracted verbatim
 * from `bootstrap` so the first-run flow can start it after the user chooses
 * 本地 Agent without re-entering the (already-consumed) `bootstrap`.
 */
async function startLocalMode(): Promise<void> {
  const workspace = resolveWorkspace();
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
}

// ---------------------------------------------------------------------------
// Custom URL mode
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a user-supplied service URL.
 *
 * Only `http`/`https` are accepted (a `file:`/`javascript:` URL must never be
 * loaded into the privileged window), and the result is reduced to
 * `origin + pathname` so query strings / fragments cannot smuggle state into the
 * persisted setting or the pairing-cookie scope.
 */
function normalizeCustomUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid custom URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported custom URL protocol: ${parsed.protocol}`);
  }
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${parsed.origin}${pathname}`;
}

/**
 * Boot custom-URL mode: point the window at an already-running SuperIU service.
 *
 * Unlike gateway/remote mode there is no transport to manage — the service is
 * self-contained — so this only validates the URL, mirrors an optional pairing
 * token into the `pairing_key` cookie, and navigates the main window. The token
 * is a cookie rather than a query param so it never lands in history/logs.
 */
async function startCustomUrlMode(config: GatewayConfig): Promise<void> {
  const rawUrl = config.customUrl?.url?.trim();
  if (!rawUrl) {
    throw new Error('custom_url mode requires a url');
  }
  const cleanUrl = normalizeCustomUrl(rawUrl);

  const token = config.customUrl?.token?.trim() || undefined;
  if (token) {
    try {
      await session.defaultSession.cookies.set({
        url: cleanUrl,
        name: 'pairing_key',
        value: token
      });
    } catch (err) {
      console.warn('[superiu] failed to set pairing cookie:', err);
    }
  }

  activeCustomUrl = cleanUrl;
  customUrlToken = token ?? null;
  activeRemoteUrl = cleanUrl;

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow(cleanUrl);
  } else {
    void mainWindow.loadURL(cleanUrl);
  }

  broadcastConnectionInfo();
  console.log(`[superiu] custom URL mode → ${cleanUrl}`);
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

/** Human labels for the SSH connection steps (see {@link RemoteStep}). */
const REMOTE_STEP_ORDER: RemoteStep['id'][] = [
  'probe',
  'install',
  'workspace',
  'token',
  'start',
  'tunnel',
  'client'
];

/**
 * Bilingual copy for the gateway/remote status surface (see
 * {@link gatewayStatusHtml}). One typed dictionary per language so a missing or
 * extra key is a compile error rather than an English string leaking into the
 * Chinese UI; the shell selects with the module-scope {@link uiLanguage}, the
 * same way {@link ABOUT_LABELS} drives the native About panel.
 */
interface StatusCopy {
  /** `lang` attribute for the status document. */
  htmlLang: string;
  documentTitle: (app: string) => string;
  modeBadge: { remote: string; gateway: string };
  tagline: { remote: string; gateway: string };
  toneTitle: {
    connectingRemote: string;
    connectingGateway: string;
    connected: string;
    failed: string;
    inactive: string;
  };
  toneBody: {
    connectingRemote: (app: string) => string;
    connectingGateway: (app: string) => string;
    connectedRemote: (app: string) => string;
    connectedGateway: (app: string) => string;
    failedRemote: string;
    failedGateway: string;
    inactive: (app: string) => string;
  };
  sections: { progress: string; connection: string; localWorkspace: string };
  labels: {
    currentStep: string;
    progress: string;
    details: string;
    sshHost: string;
    remoteWorkspace: string;
    gateway: string;
  };
  steps: Record<RemoteStep['id'], string>;
  stepStatus: Record<RemoteStep['status'], string>;
  progressOf: (index: number, total: number) => string;
  technical: string;
  unknown: string;
}

const STATUS_COPY: Record<'zh' | 'en', StatusCopy> = {
  zh: {
    htmlLang: 'zh',
    documentTitle: (app) => `${app} — 状态`,
    modeBadge: { remote: 'SSH', gateway: '网关' },
    tagline: { remote: '通过 SSH 连接的远程工作区', gateway: '网关工作区' },
    toneTitle: {
      connectingRemote: '正在通过 SSH 连接…',
      connectingGateway: '正在连接网关…',
      connected: '已连接',
      failed: '连接失败',
      inactive: '已断开连接'
    },
    toneBody: {
      connectingRemote: (app) => `${app} 正在通过 SSH 连接到远程 VPS。`,
      connectingGateway: (app) => `${app} 正在连接网关。`,
      connectedRemote: (app) => `${app} 已作为远程工作区连接。`,
      connectedGateway: (app) => `${app} 已连接到网关。`,
      failedRemote: 'SuperIU 无法通过 SSH 连接到远程 VPS。请查看下方详情。',
      failedGateway: 'SuperIU 无法连接到网关。请查看下方详情。',
      inactive: (app) => `连接已关闭。重新打开 ${app} 以重新连接。`
    },
    sections: { progress: '进度', connection: '连接', localWorkspace: '本地工作区' },
    labels: {
      currentStep: '当前步骤',
      progress: '进度',
      details: '详情',
      sshHost: 'SSH 主机',
      remoteWorkspace: '远程工作区',
      gateway: '网关'
    },
    steps: {
      probe: '检查远程主机',
      install: '安装 SuperIU 守护进程',
      workspace: '准备远程工作区',
      token: '与网关配对',
      start: '启动守护进程',
      tunnel: '建立 SSH 隧道',
      client: '连接网关客户端'
    },
    stepStatus: { pending: '等待中', active: '进行中', done: '已完成', failed: '失败' },
    progressOf: (index, total) => `第 ${index} 步，共 ${total} 步`,
    technical: '技术状态：',
    unknown: '未知'
  },
  en: {
    htmlLang: 'en',
    documentTitle: (app) => `${app} — Status`,
    modeBadge: { remote: 'SSH', gateway: 'Gateway' },
    tagline: { remote: 'Remote workspace over SSH', gateway: 'Gateway workspace' },
    toneTitle: {
      connectingRemote: 'Connecting over SSH…',
      connectingGateway: 'Connecting to the gateway…',
      connected: 'Connected',
      failed: 'Connection failed',
      inactive: 'Disconnected'
    },
    toneBody: {
      connectingRemote: (app) => `${app} is connecting to a remote VPS over SSH.`,
      connectingGateway: (app) => `${app} is connecting to the gateway.`,
      connectedRemote: (app) => `${app} is connected as a remote workspace.`,
      connectedGateway: (app) => `${app} is connected to the gateway.`,
      failedRemote: 'SuperIU could not reach the remote VPS over SSH. See the details below.',
      failedGateway: 'SuperIU could not reach the gateway. See the details below.',
      inactive: (app) => `The connection is closed. Reopen ${app} to reconnect.`
    },
    sections: { progress: 'Progress', connection: 'Connection', localWorkspace: 'Local workspace' },
    labels: {
      currentStep: 'Current step',
      progress: 'Progress',
      details: 'Details',
      sshHost: 'SSH host',
      remoteWorkspace: 'Remote workspace',
      gateway: 'Gateway'
    },
    steps: {
      probe: 'Checking the remote host',
      install: 'Installing the SuperIU daemon',
      workspace: 'Preparing the remote workspace',
      token: 'Pairing with the gateway',
      start: 'Starting the daemon',
      tunnel: 'Opening the SSH tunnel',
      client: 'Connecting the gateway client'
    },
    stepStatus: { pending: 'Waiting', active: 'In progress', done: 'Done', failed: 'Failed' },
    progressOf: (index, total) => `Step ${index} of ${total}`,
    technical: 'Technical status:',
    unknown: 'unknown'
  }
};

let appIconBase64Cache: string | null = null;
function getAppIconBase64(): string {
  if (appIconBase64Cache !== null) return appIconBase64Cache;
  const candidates = [
    path.join(HERE, 'views', 'app-icon.png'),
    path.join(HERE, 'app-icon.png'),
    path.join(appRoot(), 'src', 'views', 'app-icon.png'),
    path.join(appRoot(), 'assets', 'icon.png')
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        appIconBase64Cache = fs.readFileSync(candidate).toString('base64');
        return appIconBase64Cache;
      }
    } catch {}
  }
  appIconBase64Cache = '';
  return '';
}

/**
 * Status surface for gateway / remote modes.
 *
 * Gateway and remote modes intentionally do NOT boot the local `@agent/ui`
 * server — the gateway owns the console, and this process is only its remote
 * workspace. A window still has to exist or the app reads as a headless zombie
 * (and macOS would refuse to focus it), so this renders the connection status as
 * a self-contained, macOS-native status card: a tone-coded headline (connecting /
 * connected / failed / inactive), explanatory copy, a vertical step timeline
 * covering the 7-step deployment lifecycle, connection details, and the local
 * workspace. The raw internal state is kept in a secondary technical footer.
 *
 * Everything is inline (no external assets or network requests) and every
 * dynamic value is escaped before it reaches the markup.
 */
function gatewayStatusHtml(
  config: GatewayConfig,
  state: string,
  remote?: { step?: RemoteStep; detail?: string }
): string {
  const safe = (value: string): string =>
    value.replace(/[&<>"']/g, (ch) =>
      ch === '&'
        ? '&amp;'
        : ch === '<'
          ? '&lt;'
          : ch === '>'
            ? '&gt;'
            : ch === '"'
              ? '&quot;'
              : '&#39;'
    );

  const isRemote = config.mode === 'remote' && Boolean(config.remote);
  const step = remote?.step;
  const stepStatus = step?.status;
  const rawState = state;

  // Collapse the overlapping vocabularies (GatewayClientState, RemoteStepStatus,
  // and the synthetic `failed (step)` string) into the four tones a user needs.
  const tone: 'connecting' | 'connected' | 'failed' | 'inactive' =
    rawState.startsWith('failed') || stepStatus === 'failed'
      ? 'failed'
      : rawState === 'connected'
        ? 'connected'
        : rawState === 'idle' || rawState === 'closed'
          ? 'inactive'
          : 'connecting';

  const copy = STATUS_COPY[uiLanguage] ?? STATUS_COPY.zh;

  // Remote and gateway modes share the four tones but not their copy, so the
  // tone resolves to a finished title/body pair exactly once, here.
  const toneText: Record<typeof tone, { title: string; body: string }> = {
    connecting: isRemote
      ? { title: copy.toneTitle.connectingRemote, body: copy.toneBody.connectingRemote(APP_NAME) }
      : {
          title: copy.toneTitle.connectingGateway,
          body: copy.toneBody.connectingGateway(APP_NAME)
        },
    connected: isRemote
      ? { title: copy.toneTitle.connected, body: copy.toneBody.connectedRemote(APP_NAME) }
      : { title: copy.toneTitle.connected, body: copy.toneBody.connectedGateway(APP_NAME) },
    failed: isRemote
      ? { title: copy.toneTitle.failed, body: copy.toneBody.failedRemote }
      : { title: copy.toneTitle.failed, body: copy.toneBody.failedGateway },
    inactive: { title: copy.toneTitle.inactive, body: copy.toneBody.inactive(APP_NAME) }
  };

  const currentStepId = step?.id;
  let activeStepIndex = currentStepId ? REMOTE_STEP_ORDER.indexOf(currentStepId) : -1;

  if (activeStepIndex < 0 && tone === 'failed') {
    const match = rawState.match(/failed\s*\(([^)]+)\)/);
    if (match && REMOTE_STEP_ORDER.includes(match[1] as RemoteStep['id'])) {
      activeStepIndex = REMOTE_STEP_ORDER.indexOf(match[1] as RemoteStep['id']);
    } else {
      activeStepIndex = 0;
    }
  } else if (activeStepIndex < 0 && tone === 'connecting') {
    activeStepIndex = 0;
  } else if (tone === 'connected') {
    activeStepIndex = REMOTE_STEP_ORDER.length;
  }

  const totalSteps = REMOTE_STEP_ORDER.length;
  const stepProgressIndex = tone === 'connected'
    ? totalSteps
    : Math.max(0, activeStepIndex);

  const stepItemsHtml = isRemote
    ? REMOTE_STEP_ORDER.map((stepId, idx) => {
        let itemStatus: RemoteStep['status'];
        if (tone === 'connected') {
          itemStatus = 'done';
        } else if (idx < activeStepIndex) {
          itemStatus = 'done';
        } else if (idx === activeStepIndex) {
          itemStatus = tone === 'failed' ? 'failed' : (step?.status ?? 'active');
        } else {
          itemStatus = 'pending';
        }

        const isCurrentOrFailed = idx === activeStepIndex;
        const detailText = isCurrentOrFailed ? (remote?.detail || step?.detail) : undefined;

        const nodeGlyph = itemStatus === 'done'
          ? '<i class="icon-check"></i>'
          : itemStatus === 'active'
            ? '<span class="node-pulse-dot"></span>'
            : itemStatus === 'failed'
              ? '<span class="icon-fail">!</span>'
              : '<span class="node-pending-dot"></span>';

        const detailHtml = detailText
          ? `
            <div class="step-detail">
              <div class="step-detail-head">
                <span class="step-detail-label">${safe(copy.labels.details)}</span>
              </div>
              <pre class="step-detail-body">${safe(detailText)}</pre>
            </div>`
          : '';

        return `
        <div class="timeline-step timeline-step--${safe(itemStatus)}">
          <div class="timeline-node-col">
            <div class="timeline-node timeline-node--${safe(itemStatus)}" aria-hidden="true">
              ${nodeGlyph}
            </div>
            <div class="timeline-line"></div>
          </div>
          <div class="timeline-content">
            <div class="timeline-header">
              <span class="timeline-title">${safe(copy.steps[stepId] ?? stepId)}</span>
              <span class="chip chip--${safe(itemStatus)}">${safe(copy.stepStatus[itemStatus] ?? itemStatus)}</span>
            </div>
            ${detailHtml}
          </div>
        </div>`;
      }).join('')
    : '';

  const stepCard = isRemote
    ? `
  <section class="card">
    <div class="card-header">
      <h3>${safe(copy.sections.progress)}</h3>
      <span class="card-badge">${safe(copy.progressOf(Math.min(totalSteps, stepProgressIndex + 1), totalSteps))}</span>
    </div>
    <div class="timeline">
      ${stepItemsHtml}
    </div>
  </section>`
    : remote?.detail
      ? `
  <section class="card">
    <div class="card-header">
      <h3>${safe(copy.labels.details)}</h3>
    </div>
    <div class="step-detail" style="margin-top: 0;">
      <pre class="step-detail-body">${safe(remote.detail)}</pre>
    </div>
  </section>`
      : '';

  // Remote mode shows the ssh alias/workspace; gateway mode shows the endpoint
  // (there is no remote host). Local workspace is always relevant.
  const connectionFields =
    isRemote && config.remote
      ? `
      <div class="field">
        <span class="label">${safe(copy.labels.sshHost)}</span>
        <span class="value"><code>${safe(config.remote.alias)}</code></span>
      </div>
      <div class="field">
        <span class="label">${safe(copy.labels.remoteWorkspace)}</span>
        <span class="value"><code>${safe(config.remote.workspace)}</code></span>
      </div>`
      : `
      <div class="field">
        <span class="label">${safe(copy.labels.gateway)}</span>
        <span class="value"><code>${safe(config.url ?? '—')}</code></span>
      </div>`;

  const appIcon = getAppIconBase64();
  const logoMarkup = appIcon
    ? `<img class="app-icon" src="data:image/png;base64,${appIcon}" alt="${safe(APP_NAME)}" aria-hidden="true" />`
    : `<span class="logo" aria-hidden="true">${safe(APP_NAME.slice(0, 1))}</span>`;

  const heroIndicatorGlyph =
    tone === 'connected'
      ? '<i class="icon-check-hero"></i>'
      : tone === 'failed'
        ? '<span class="icon-fail-hero">!</span>'
        : tone === 'inactive'
          ? '<span class="icon-idle-hero"></span>'
          : '<span class="beacon-ring"></span><span class="beacon-dot"></span>';

  return `<!doctype html>
<html lang="${safe(copy.htmlLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${safe(copy.documentTitle(APP_NAME))}</title>
<style>
  :root {
    color-scheme: light dark;
    --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", system-ui, sans-serif;
    --font-mono: ui-monospace, "SF Mono", Monaco, Menlo, Consolas, monospace;

    /* Light Theme (macOS Vibrancy Under-Window) */
    --bg-canvas: rgba(246, 246, 248, 0.78);
    --panel: rgba(255, 255, 255, 0.82);
    --panel-border: rgba(0, 0, 0, 0.08);
    --panel-border-subtle: rgba(0, 0, 0, 0.045);
    --panel-shadow: 0 4px 24px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02);

    --text: #1d1d1f;
    --muted: #6e6e73;
    --subtle: #86868b;

    --code-bg: rgba(0, 0, 0, 0.045);
    --code-border: rgba(0, 0, 0, 0.07);
    --code-text: #24292f;

    --accent: #0071e3;
    --accent-subtle: rgba(0, 113, 227, 0.12);
    --ok: #28cd41;
    --ok-subtle: rgba(40, 205, 65, 0.12);
    --err: #ff3b30;
    --err-subtle: rgba(255, 59, 48, 0.12);
    --idle: #8e8e93;
    --idle-subtle: rgba(142, 142, 147, 0.12);

    --track-bg: rgba(0, 0, 0, 0.06);
    --chip-bg: rgba(0, 0, 0, 0.05);
    --app-icon-shadow: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.12)) drop-shadow(0 1.5px 3px rgba(0, 0, 0, 0.08));
  }

  @media (prefers-color-scheme: dark) {
    :root {
      /* Dark Theme (macOS Vibrancy Under-Window) */
      --bg-canvas: rgba(26, 26, 30, 0.80);
      --panel: rgba(38, 38, 44, 0.76);
      --panel-border: rgba(255, 255, 255, 0.10);
      --panel-border-subtle: rgba(255, 255, 255, 0.05);
      --panel-shadow: 0 10px 36px rgba(0, 0, 0, 0.40), 0 1px 2px rgba(0, 0, 0, 0.25);

      --text: #f5f5f7;
      --muted: #98989d;
      --subtle: #636366;

      --code-bg: rgba(255, 255, 255, 0.07);
      --code-border: rgba(255, 255, 255, 0.09);
      --code-text: #e6edf3;

      --accent: #0a84ff;
      --accent-subtle: rgba(10, 132, 255, 0.16);
      --ok: #30d158;
      --ok-subtle: rgba(48, 209, 88, 0.16);
      --err: #ff453a;
      --err-subtle: rgba(255, 69, 58, 0.16);
      --idle: #8e8e93;
      --idle-subtle: rgba(142, 142, 147, 0.16);

      --track-bg: rgba(255, 255, 255, 0.08);
      --chip-bg: rgba(255, 255, 255, 0.08);
      --app-icon-shadow: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.45)) drop-shadow(0 2px 5px rgba(0, 0, 0, 0.30));
    }
  }

  * { box-sizing: border-box; }
  html {
    height: 100%;
  }
  html, body {
    margin: 0;
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  body {
    min-height: 100%;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    background: var(--bg-canvas);
    color: var(--text);
    font-size: 13.5px;
    line-height: 1.5;
    overflow-x: hidden;
    overflow-y: auto;
  }

  /* hiddenInset chrome: leave the traffic lights clear and keep the window draggable. */
  .titlebar {
    position: fixed;
    inset: 0 0 auto 0;
    height: 38px;
    -webkit-app-region: drag;
    z-index: 100;
  }

  .wrap {
    width: 100%;
    max-width: 540px;
    margin: auto;
    padding: 46px 20px 28px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    position: relative;
    z-index: 1;
  }

  /* Header */
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 2px 2px;
  }
  .app-icon {
    width: 36px;
    height: 36px;
    flex: none;
    object-fit: contain;
    filter: var(--app-icon-shadow);
    -webkit-user-drag: none;
    user-select: none;
    pointer-events: none;
  }
  .logo {
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: 9px;
    display: grid;
    place-items: center;
    font-size: 18px;
    font-weight: 700;
    color: #ffffff;
    background: linear-gradient(135deg, #0a84ff 0%, #5e5ce6 100%);
    box-shadow: 0 3px 12px rgba(10, 132, 255, 0.30), inset 0 1px 0 rgba(255, 255, 255, 0.35);
    user-select: none;
  }
  .head-meta {
    flex: 1;
    min-width: 0;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .head h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 650;
    letter-spacing: -0.015em;
    line-height: 1.2;
    color: var(--text);
  }
  .mode-badge {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--code-bg);
    border: 1px solid var(--code-border);
    color: var(--muted);
  }
  .tagline {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--muted);
  }

  /* Status Hero Card */
  .status-hero {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 13px;
    padding: 14px 16px;
    box-shadow: var(--panel-shadow);
    display: flex;
    flex-direction: column;
    gap: 11px;
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
  }
  .status-hero--connecting { border-color: rgba(10, 132, 255, 0.28); }
  .status-hero--connected { border-color: rgba(48, 209, 88, 0.28); }
  .status-hero--failed { border-color: rgba(255, 69, 58, 0.28); }
  .status-hero--inactive { border-color: rgba(142, 142, 147, 0.28); }

  .status-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .status-indicator {
    width: 22px;
    height: 22px;
    flex: none;
    margin-top: 1px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    position: relative;
  }
  .status-hero--connecting .status-indicator {
    background: var(--accent-subtle);
    color: var(--accent);
  }
  .status-hero--connected .status-indicator {
    background: var(--ok-subtle);
    color: var(--ok);
  }
  .status-hero--failed .status-indicator {
    background: var(--err-subtle);
    color: var(--err);
  }
  .status-hero--inactive .status-indicator {
    background: var(--idle-subtle);
    color: var(--idle);
  }

  .beacon-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    position: relative;
    z-index: 2;
  }
  .beacon-ring {
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    border: 1.5px solid currentColor;
    opacity: 0.6;
    animation: beacon-pulse 1.8s ease-out infinite;
  }
  @keyframes beacon-pulse {
    0% { transform: scale(0.65); opacity: 0.9; }
    50% { transform: scale(1.25); opacity: 0.15; }
    100% { transform: scale(0.65); opacity: 0.9; }
  }

  .icon-check-hero {
    display: block;
    width: 4px;
    height: 9px;
    border: solid currentColor;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
    margin-top: -2px;
  }
  .icon-fail-hero {
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
  }
  .icon-idle-hero {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  .status-content {
    flex: 1;
    min-width: 0;
  }
  .status-hero h2 {
    margin: 0;
    font-size: 14.5px;
    font-weight: 650;
    letter-spacing: -0.01em;
    line-height: 1.3;
  }
  .status-hero--connecting h2 { color: var(--accent); }
  .status-hero--connected h2 { color: var(--ok); }
  .status-hero--failed h2 { color: var(--err); }
  .status-hero--inactive h2 { color: var(--idle); }

  .status-hero p {
    margin: 3px 0 0;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  /* Progress track */
  .track {
    height: 3.5px;
    border-radius: 999px;
    background: var(--track-bg);
    overflow: hidden;
    position: relative;
  }
  .track-fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: currentColor;
  }
  .status-hero--connecting .track-fill {
    width: 38%;
    background: linear-gradient(90deg, transparent, var(--accent) 50%, transparent);
    animation: indeterminate 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }
  .status-hero--connected .track-fill {
    width: 100%;
    background: var(--ok);
  }
  .status-hero--failed .track-fill {
    width: 100%;
    background: var(--err);
  }
  .status-hero--inactive .track-fill {
    width: 100%;
    background: var(--idle);
    opacity: 0.35;
  }
  @keyframes indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(280%); }
  }

  /* Card */
  .card {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 13px;
    padding: 12px 16px;
    box-shadow: var(--panel-shadow);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 9px;
  }
  .card h3 {
    margin: 0;
    font-size: 11px;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .card-badge {
    font-size: 11px;
    font-weight: 550;
    color: var(--muted);
    background: var(--chip-bg);
    padding: 1.5px 7px;
    border-radius: 999px;
  }

  /* Timeline */
  .timeline {
    display: flex;
    flex-direction: column;
    padding: 1px 0;
  }
  .timeline-step {
    display: flex;
    align-items: flex-start;
    gap: 11px;
    position: relative;
    padding: 4px 0;
  }
  .timeline-step:first-child { padding-top: 1px; }
  .timeline-step:last-child { padding-bottom: 1px; }

  .timeline-node-col {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: none;
    width: 18px;
  }
  .timeline-node {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--panel);
    border: 1.5px solid var(--panel-border);
    position: relative;
    z-index: 2;
  }
  .timeline-node--done {
    background: var(--ok-subtle);
    border-color: var(--ok);
    color: var(--ok);
  }
  .timeline-node--active {
    background: var(--accent-subtle);
    border-color: var(--accent);
    color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }
  .timeline-node--failed {
    background: var(--err-subtle);
    border-color: var(--err);
    color: var(--err);
  }
  .timeline-node--pending {
    background: transparent;
    border-color: var(--panel-border-subtle);
  }

  .icon-check {
    display: block;
    width: 3px;
    height: 6.5px;
    border: solid currentColor;
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
    margin-top: -1.5px;
  }
  .node-pulse-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    animation: node-pulse 1.4s ease-in-out infinite;
  }
  @keyframes node-pulse {
    0%, 100% { transform: scale(0.8); opacity: 1; }
    50% { transform: scale(1.25); opacity: 0.6; }
  }
  .icon-fail {
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
  }
  .node-pending-dot {
    width: 3.5px;
    height: 3.5px;
    border-radius: 50%;
    background: var(--muted);
    opacity: 0.35;
  }

  .timeline-line {
    position: absolute;
    top: 16px;
    bottom: -8px;
    left: 7px;
    width: 2px;
    background: var(--panel-border);
    z-index: 1;
  }
  .timeline-step--done .timeline-line {
    background: var(--ok);
    opacity: 0.6;
  }
  .timeline-step:last-child .timeline-line {
    display: none;
  }

  .timeline-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 0px;
  }
  .timeline-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .timeline-title {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text);
  }
  .timeline-step--done .timeline-title {
    opacity: 0.85;
  }
  .timeline-step--active .timeline-title {
    font-weight: 650;
    color: var(--text);
  }
  .timeline-step--failed .timeline-title {
    font-weight: 650;
    color: var(--err);
  }
  .timeline-step--pending .timeline-title {
    color: var(--muted);
    opacity: 0.55;
    font-weight: 400;
  }

  /* Chips */
  .chip {
    flex: none;
    font-size: 10.5px;
    font-weight: 550;
    padding: 1px 6.5px;
    border-radius: 999px;
    background: var(--chip-bg);
    color: var(--muted);
    line-height: 1.4;
  }
  .chip--active {
    background: var(--accent-subtle);
    color: var(--accent);
    font-weight: 600;
  }
  .chip--done {
    background: var(--ok-subtle);
    color: var(--ok);
  }
  .chip--failed {
    background: var(--err-subtle);
    color: var(--err);
    font-weight: 600;
  }
  .chip--pending {
    opacity: 0.55;
  }

  /* Step Detail */
  .step-detail {
    margin-top: 5px;
    border-radius: 8px;
    background: var(--code-bg);
    border: 1px solid var(--code-border);
    overflow: hidden;
    -webkit-app-region: no-drag;
  }
  .step-detail-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-bottom: 1px solid var(--code-border);
    font-size: 10px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .step-detail-body {
    margin: 0;
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.45;
    color: var(--code-text);
    max-height: 7.5em;
    overflow-y: auto;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    -webkit-user-select: text;
    user-select: text;
  }
  .step-detail-body::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  .step-detail-body::-webkit-scrollbar-thumb {
    background: var(--panel-border);
    border-radius: 999px;
  }

  /* Fields List */
  .fields-list {
    display: flex;
    flex-direction: column;
  }
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 0;
    gap: 10px;
  }
  .field + .field {
    border-top: 1px solid var(--panel-border-subtle);
  }
  .label {
    flex: none;
    font-size: 12px;
    color: var(--muted);
  }
  .value {
    min-width: 0;
    display: flex;
    justify-content: flex-end;
  }
  code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--code-bg);
    border: 1px solid var(--code-border);
    color: var(--code-text);
    padding: 2px 6px;
    border-radius: 6px;
    overflow-wrap: anywhere;
    word-break: break-all;
    -webkit-user-select: text;
    user-select: text;
  }

  /* Footer */
  .tech {
    font-size: 10.5px;
    color: var(--muted);
    text-align: center;
    padding: 2px 0;
    opacity: 0.85;
  }
  .tech code {
    font-size: 10.5px;
    padding: 1px 5px;
  }

  /* Motion */
  @media (prefers-reduced-motion: reduce) {
    .beacon-ring, .beacon-dot, .node-pulse-dot {
      animation: none !important;
    }
    .status-hero--connecting .track-fill {
      animation: none !important;
      width: 100%;
      opacity: 0.5;
    }
  }

  /* Compact Mode */
  @media (max-height: 760px) {
    .wrap {
      padding: 42px 16px 20px;
      gap: 9px;
    }
    .head {
      gap: 10px;
    }
    .app-icon {
      width: 30px;
      height: 30px;
    }
    .logo {
      width: 30px;
      height: 30px;
      font-size: 15px;
      border-radius: 7.5px;
    }
    .head h1 {
      font-size: 14.5px;
    }
    .tagline {
      font-size: 11px;
    }
    .status-hero {
      padding: 10px 13px;
      gap: 8px;
      border-radius: 11px;
    }
    .status-hero h2 {
      font-size: 13.5px;
    }
    .status-hero p {
      font-size: 11.5px;
    }
    .card {
      padding: 9px 13px;
      border-radius: 11px;
    }
    .card-header {
      margin-bottom: 7px;
    }
    .timeline-step {
      padding: 3px 0;
    }
    .timeline-title {
      font-size: 12px;
    }
    .field {
      padding: 3.5px 0;
    }
    .label {
      font-size: 11.5px;
    }
    code {
      font-size: 11px;
    }
  }
</style>
</head>
<body>
<div class="titlebar" aria-hidden="true"></div>
<main class="wrap">
  <header class="head">
    ${logoMarkup}
    <div class="head-meta">
      <div class="title-row">
        <h1>${safe(APP_NAME)}</h1>
        <span class="mode-badge">${safe(isRemote ? copy.modeBadge.remote : copy.modeBadge.gateway)}</span>
      </div>
      <p class="tagline">${safe(isRemote ? copy.tagline.remote : copy.tagline.gateway)}</p>
    </div>
  </header>

  <section class="status-hero status-hero--${tone}" role="status">
    <div class="status-row">
      <div class="status-indicator" aria-hidden="true">
        ${heroIndicatorGlyph}
      </div>
      <div class="status-content">
        <h2>${safe(toneText[tone].title)}</h2>
        <p>${safe(toneText[tone].body)}</p>
      </div>
    </div>
    <div class="track" aria-hidden="true"><span class="track-fill"></span></div>
  </section>
${stepCard}
  <section class="card">
    <div class="card-header">
      <h3>${safe(copy.sections.connection)}</h3>
    </div>
    <div class="fields-list">
      ${connectionFields}
    </div>
  </section>

  <section class="card">
    <div class="card-header">
      <h3>${safe(copy.sections.localWorkspace)}</h3>
    </div>
    <div class="fields-list">
      <div class="field">
        <span class="value"><code>${safe(config.workspaceRoot)}</code></span>
      </div>
    </div>
  </section>

  <footer class="tech">${safe(copy.technical)} <code>${safe(rawState || copy.unknown)}</code></footer>
</main>
</body>
</html>`;
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
 * Knobs for {@link startRemoteMode} used by the first-run flow.
 *
 * The wizard owns its own window, so when the connect request comes from it the
 * status page must NOT be painted (it would steal the wizard's window contents)
 * and progress must be routed to the wizard instead of `mainWindow`.
 */
interface RemoteModeOptions {
  /** Paint the live status window. Default true. */
  paint?: boolean;
  /** Window that receives `REMOTE_PROGRESS_CHANNEL` step events. Default: `() => mainWindow`. */
  progressTarget?: () => BrowserWindow | null;
}

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
async function startRemoteMode(config: GatewayConfig, opts: RemoteModeOptions = {}): Promise<void> {
  const remote = config.remote;
  if (!remote) {
    throw new Error('remote mode requires a remote alias');
  }

  const paint = opts.paint !== false;
  const progressTarget = opts.progressTarget ?? ((): BrowserWindow | null => mainWindow);

  // Repaint the status page per step — the data: URL page carries no script, so
  // the main process is the only writer that can show real progress. `spaShown`
  // stops a late progress event from clobbering an already-loaded SPA.
  let spaShown = false;
  let lastStatusKey: string | null = null;

  // First paint before any ssh work begins, so the user sees the flow start
  // instead of a blank window during a slow probe/install.
  if (paint) {
    showGatewayStatus(config, 'connecting', {
      step: { id: 'probe', status: 'active' }
    });
    lastStatusKey = 'probe:active';
  }

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

  // Progress → log + status window + progress target (main window, or the
  // first-run wizard).
  const onProgress = (step: RemoteStep): void => {
    const detail = step.detail ? ` (${step.detail})` : '';
    console.log(`[superiu] remote ${step.id}: ${step.status}${detail}`);
    const target = progressTarget();
    if (target && !target.isDestroyed()) {
      target.webContents.send(REMOTE_PROGRESS_CHANNEL, {
        id: step.id,
        status: step.status,
        detail: step.detail
      });
    }
    if (paint && !spaShown && step.status !== 'pending') {
      const key = `${step.id}:${step.status}`;
      if (key !== lastStatusKey) {
        lastStatusKey = key;
        showGatewayStatus(config, 'connecting', { step, detail: step.detail });
      }
    }
  };

  try {
    const result = await manager.connect({
      alias: remote.alias,
      workspace: remote.workspace,
      deviceId: config.deviceId,
      releaseBase: remote.releaseBase,
      version: remote.version,
      // Remote mode loads the SPA from the daemon, not from this bundle, so an
      // installed daemon older than this app serves a stale console. Target the
      // app's own version to upgrade it on connect.
      daemonTargetVersion: app.getVersion(),
      localPort: remote.localPort,
      autoUpdateIdle: remote.autoUpdateIdle,
      autoUpdateIntervalHours: remote.autoUpdateIntervalHours,
      onProgress,
      onApprovalRequired: approveDangerousCommand,
      onEvent: (event) => {
        // Events belong to the gateway console; this process has no local SPA in
        // remote mode, so they are surfaced for diagnostics only.
        console.log(`[superiu] remote event ${event.type} (session ${event.sessionId})`);
      },
      onStateChange: (state, rttMs) => {
        broadcastConnectionInfo();
      }
    });

    // The manager connects the GatewayClient internally; reflect its live state.
    console.log(
      `[superiu] remote mode → ${result.localUrl} via ${remote.alias} (workspace ${remote.workspace})`
    );
    const remoteHttpUrl = `http://127.0.0.1:${result.tunnelPort}`;
    activeRemoteUrl = remoteHttpUrl;
    // Fresh session: cancel any reload queued against the previous port and
    // restart the retry budget from zero.
    clearTimeout(remoteNavTimer);
    remoteNavTimer = undefined;
    remoteNavAttempts = 0;
    spaNavStartedAt = null;

    if (paint) {
      spaShown = true;
      if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createWindow(remoteHttpUrl);
      } else {
        void mainWindow.loadURL(remoteHttpUrl);
      }
    }
  } catch (err) {
    // Surface the failing step and STOP. Deliberately no silent fallback to
    // local mode: that would boot a second AgentRunner/DB handle set the user
    // did not ask for. A visible status window (already painted by onProgress)
    // plus a logged error is the contract.
    const step = err instanceof RemoteConnectionError ? err.step : undefined;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[superiu] remote mode failed at step ${step ?? 'unknown'}: ${message}`);
    // With `paint:false` the caller's view (the wizard) renders the error banner
    // itself, so the status page is skipped.
    if (paint) {
      spaShown = true;
      showGatewayStatus(config, `failed (${step ?? 'unknown'})`, {
        step: step ? { id: step, status: 'failed' } : undefined,
        detail: message
      });
    }
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
  activeRemoteUrl = null;
  // The session is over: drop any pending SPA reload and its retry deadline so a
  // straggling timer cannot navigate the window against the *next* session's URL.
  clearTimeout(remoteNavTimer);
  remoteNavTimer = undefined;
  spaNavStartedAt = null;
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
  ipcMain.handle(INVOKE.getConnectionInfo, () => {
    return getConnectionInfo();
  });
  ipcMain.handle(INVOKE.disconnectRemote, async () => {
    if (activeCustomUrl) {
      activeCustomUrl = null;
      customUrlToken = null;
      activeRemoteUrl = null;
      broadcastConnectionInfo();
      await startLocalMode();
      return;
    }
    await closeRemote();
    broadcastConnectionInfo();
    const config = resolveGatewayConfig(resolveWorkspace());
    showGatewayStatus(config, 'idle');
  });
  ipcMain.handle(INVOKE.upgradeRemote, async () => {
    if (remoteManager) {
      return await remoteManager.upgradeRemoteServer();
    }
    return { ok: false, error: 'No active remote connection' };
  });

  ipcMain.handle(
    INVOKE.connectRemote,
    async (
      event,
      options: {
        alias: string;
        workspace: string;
        localPort?: number;
        saveDefault?: boolean;
        autoUpdateIdle?: boolean;
        autoUpdateIntervalHours?: number;
        advertiseUrl?: string;
      }
    ) => {
      // A connect request that originated in the first-run wizard: skip the
      // status paint (the wizard owns its window) and route progress to it.
      const onboarding =
        onboardingWindow && !onboardingWindow.isDestroyed() ? onboardingWindow : null;
      const fromOnboarding = Boolean(onboarding && event.sender === onboarding.webContents);

      // A fixed local forward port is honoured, not dropped. `resolveGatewayConfig`
      // reads `settings.remote.localPort` back on the next boot, so persisting it
      // here is what makes the wizard's "本地转发端口" field survive a restart.
      const localPort =
        typeof options.localPort === 'number' && Number.isFinite(options.localPort)
          ? options.localPort
          : undefined;

      // `undefined` means "no preference": neither the persisted settings nor the
      // live connection may invent a value the caller never sent (the SPA omits
      // the field entirely), or a restart would silently disable the feature.
      const autoUpdateIdle =
        typeof options.autoUpdateIdle === 'boolean' ? options.autoUpdateIdle : undefined;
      const autoUpdateIntervalHours =
        typeof options.autoUpdateIntervalHours === 'number' &&
        Number.isFinite(options.autoUpdateIntervalHours) &&
        options.autoUpdateIntervalHours > 0
          ? options.autoUpdateIntervalHours
          : undefined;

      if (options.saveDefault) {
        try {
          // Read-modify-write through the settings module so the SPA's own keys
          // (apiKey, providers, …) survive. Recording the choice also marks the
          // first run complete so the wizard is never shown again.
          writeDesktopSettings(resolveWorkspace(), {
            connectionMode: 'remote',
            remote: {
              alias: options.alias,
              workspace: options.workspace,
              localPort,
              ...(autoUpdateIdle !== undefined ? { autoUpdateIdle } : {}),
              ...(autoUpdateIntervalHours !== undefined ? { autoUpdateIntervalHours } : {}),
              ...(options.advertiseUrl ? { advertiseUrl: options.advertiseUrl.trim() } : {})
            },
            onboardingCompleted: true
          });
        } catch (e) {
          console.warn('[superiu] failed to persist default remote settings:', e);
        }
      }

      const config: GatewayConfig = {
        mode: 'remote',
        workspaceRoot: options.workspace,
        remote: {
          alias: options.alias,
          workspace: options.workspace,
          localPort,
          autoUpdateIdle,
          autoUpdateIntervalHours,
          advertiseUrl: options.advertiseUrl ? options.advertiseUrl.trim() : undefined
        }
      };

      // Returns as soon as `connect()` is initiated (the handshake is async by
      // design); the wizard keeps rendering progress until then.
      await startRemoteMode(
        config,
        fromOnboarding ? { paint: false, progressTarget: () => onboardingWindow } : {}
      );

      if (fromOnboarding) {
        // The choice is on disk: close the wizard and show the live web console.
        closeOnboarding();
        if (activeRemoteUrl) {
          if (!mainWindow || mainWindow.isDestroyed()) {
            mainWindow = createWindow(activeRemoteUrl);
          } else {
            void mainWindow.loadURL(activeRemoteUrl);
          }
        } else {
          showGatewayStatus(config, remoteManager?.gatewayClient?.connectionState ?? 'connecting');
        }
      }
    }
  );

  ipcMain.handle(
    INVOKE.connectCustomUrl,
    async (
      event,
      options: { url: string; token?: string; saveDefault?: boolean }
    ) => {
      const rawUrl = typeof options?.url === 'string' ? options.url.trim() : '';
      const cleanUrl = normalizeCustomUrl(rawUrl);
      const token =
        typeof options?.token === 'string' && options.token.trim()
          ? options.token.trim()
          : undefined;

      // A connect request that originated in the first-run wizard: close it once
      // the connection is up (the main window takes over).
      const onboarding =
        onboardingWindow && !onboardingWindow.isDestroyed() ? onboardingWindow : null;
      const fromOnboarding = Boolean(onboarding && event.sender === onboarding.webContents);

      if (options?.saveDefault) {
        try {
          writeDesktopSettings(resolveWorkspace(), {
            connectionMode: 'custom_url',
            customUrl: { url: cleanUrl, token },
            onboardingCompleted: true
          });
        } catch (e) {
          console.warn('[superiu] failed to persist custom URL settings:', e);
        }
      }

      const config: GatewayConfig = {
        mode: 'custom_url',
        url: cleanUrl,
        token,
        customUrl: { url: cleanUrl, token },
        workspaceRoot: resolveWorkspace()
      };

      await startCustomUrlMode(config);

      if (fromOnboarding) closeOnboarding();
    }
  );

  ipcMain.handle(INVOKE.completeOnboarding, async (_event, opts: { mode: 'local' }) => {
    if (!opts || opts.mode !== 'local') throw new Error('unsupported onboarding mode');
    // Start the engine BEFORE closing the wizard: `startLocalMode` can throw
    // (port bind, directory permissions, memory-dir resolution), and closing
    // first would destroy the only window while `bootstrap` has long since
    // returned — leaving a windowless process and an error the page can never
    // show. On failure the wizard stays up and its own `.catch` renders the
    // error. This mirrors the remote path, which closes only after success.
    await startLocalMode();
    writeDesktopSettings(resolveWorkspace(), {
      connectionMode: 'local',
      onboardingCompleted: true
    });
    closeOnboarding();
  });

  ipcMain.handle(INVOKE.checkForUpdate, async (_event, options?: { interactive?: boolean }) => {
    await checkForUpdate(options?.interactive ?? true);
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
  stopBackgroundUpdateLoop();
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
  const workspace = resolveWorkspace();
  process.chdir(workspace);

  // Resolve the transport first: in gateway/remote mode the shell is a remote
  // workspace/sandbox client for the VPS Gateway and must NOT boot the local
  // `@agent/ui` server (that would open a second AgentRunner and DB handle set
  // for a console the gateway already owns). Local mode is the historical
  // standalone experience and remains the fallback whenever no gateway/remote is
  // configured or the mode is pinned to `local`.
  const gateway = resolveGatewayConfig(workspace);

  // First run: no mode has ever been recorded. Show the wizard and stop — the
  // server/main window is started later, once the user makes a choice, via the
  // `completeOnboarding` / `connectRemote` IPC handlers. Logging the workspace
  // here matches every other branch.
  if (needsOnboarding(readDesktopSettings(workspace), gateway)) {
    console.log(`[superiu] workspace ${workspace}`);
    openOnboarding();
    return;
  }

  if (gateway.mode === 'custom_url') {
    console.log(`[superiu] workspace ${workspace}`);
    await startCustomUrlMode(gateway);
    startBackgroundUpdateLoop();
    return;
  }

  if (gateway.mode === 'remote') {
    console.log(`[superiu] workspace ${workspace}`);
    // A remote failure is surfaced and logged by `startRemoteMode`, which then
    // rethrows so `bootstrap().catch` below can exit non-zero. We deliberately
    // do NOT fall back to local mode: that would start a second AgentRunner the
    // user did not ask for.
    await startRemoteMode(gateway);
    startBackgroundUpdateLoop();
    return;
  }

  if (gateway.mode === 'gateway') {
    console.log(`[superiu] workspace ${workspace}`);
    startGatewayMode(gateway);
    startBackgroundUpdateLoop();
    return;
  }

  await startLocalMode();
  startBackgroundUpdateLoop();
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

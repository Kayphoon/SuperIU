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

/**
 * Status surface for gateway / remote modes.
 *
 * Gateway and remote modes intentionally do NOT boot the local `@agent/ui`
 * server — the gateway owns the console, and this process is only its remote
 * workspace. A window still has to exist or the app reads as a headless zombie
 * (and macOS would refuse to focus it), so this renders the connection status as
 * a self-contained, dark/light-aware card: a tone-coded headline (connecting /
 * connected / failed / inactive), explanatory copy, the current SSH step, the
 * connection details, and the local workspace. The raw internal state is kept
 * only in a secondary technical footer.
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

  const stepIndex = step ? REMOTE_STEP_ORDER.indexOf(step.id) : -1;
  const stepFields = step
    ? `
      <div class="field">
        <span class="label">${safe(copy.labels.currentStep)}</span>
        <span class="value">${safe(copy.steps[step.id] ?? step.id)}</span>
        <span class="chip chip--${safe(step.status)}">${safe(copy.stepStatus[step.status] ?? step.status)}</span>
      </div>${
        stepIndex >= 0
          ? `
      <div class="field">
        <span class="label">${safe(copy.labels.progress)}</span>
        <span class="value">${safe(copy.progressOf(stepIndex + 1, REMOTE_STEP_ORDER.length))}</span>
      </div>`
          : ''
      }`
    : '';

  const detailField = remote?.detail
    ? `
      <div class="field">
        <span class="label">${safe(copy.labels.details)}</span>
        <span class="value detail">${safe(remote.detail)}</span>
      </div>`
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

  const stepCard =
    step || remote?.detail
      ? `
  <section class="card">
    <h3>${safe(copy.sections.progress)}</h3>${stepFields}${detailField}
  </section>`
      : '';

  return `<!doctype html>
<html lang="${safe(copy.htmlLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${safe(copy.documentTitle(APP_NAME))}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f5f7; --panel: #ffffff; --text: #1d1d1f; --muted: #6e6e73;
    --border: rgba(0, 0, 0, 0.10); --code-bg: rgba(0, 0, 0, 0.05);
    --accent: #0a84ff; --ok: #1a9e57; --err: #c9342a; --idle: #8e8e93;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1c1c1e; --panel: #2c2c2e; --text: #f5f5f7; --muted: #98989d;
      --border: rgba(255, 255, 255, 0.12); --code-bg: rgba(255, 255, 255, 0.08);
      --accent: #0a84ff; --ok: #30d158; --err: #ff453a; --idle: #8e8e93;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* hiddenInset chrome: leave the traffic lights clear and keep the window draggable. */
  .titlebar { position: fixed; inset: 0 0 auto 0; height: 38px; -webkit-app-region: drag; }
  .wrap {
    max-width: 620px; margin: 0 auto; padding: 54px 28px 40px;
    display: flex; flex-direction: column; gap: 18px;
  }
  .head { display: flex; align-items: center; gap: 12px; }
  .logo {
    width: 40px; height: 40px; flex: none; border-radius: 11px;
    display: grid; place-items: center; font-size: 20px; font-weight: 600; color: #fff;
    background: linear-gradient(160deg, #0a84ff, #6a5cff);
  }
  .head h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
  .tagline { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }
  .status {
    background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
    padding: 18px; display: grid; grid-template-columns: auto minmax(0, 1fr);
    gap: 12px; color: var(--idle);
  }
  .status .dot { width: 11px; height: 11px; border-radius: 50%; margin-top: 5px; background: currentColor; }
  .status h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .status p { margin: 4px 0 0; color: var(--muted); overflow-wrap: anywhere; }
  .status--connecting { color: var(--accent); }
  .status--connected { color: var(--ok); }
  .status--failed { color: var(--err); }
  .status--inactive { color: var(--idle); }
  .status--connecting .dot { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .track {
    grid-column: 1 / -1; height: 4px; margin-top: 6px; border-radius: 999px;
    background: var(--code-bg); overflow: hidden;
  }
  .track > i {
    display: block; height: 100%; width: 38%; border-radius: 999px;
    background: currentColor; animation: slide 1.4s ease-in-out infinite;
  }
  @keyframes slide { 0% { transform: translateX(-110%); } 100% { transform: translateX(300%); } }
  .status--connected .track > i,
  .status--failed .track > i,
  .status--inactive .track > i { width: 100%; animation: none; }
  @media (prefers-reduced-motion: reduce) {
    .status--connecting .dot { animation: none; }
    .track > i { animation: none; width: 100%; opacity: 0.5; }
  }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 14px 18px; }
  .card h3 {
    margin: 0 0 10px; font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--muted);
  }
  .field { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 5px 0; }
  .field + .field { border-top: 1px solid var(--border); }
  .label { flex: none; min-width: 96px; font-size: 12.5px; color: var(--muted); }
  .value { flex: 1 1 180px; min-width: 0; font-weight: 500; overflow-wrap: anywhere; }
  .chip {
    flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
    background: var(--code-bg); color: var(--muted);
  }
  .chip--active { color: var(--accent); }
  .chip--done { color: var(--ok); }
  .chip--failed { color: var(--err); }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
    background: var(--code-bg); padding: 2px 6px; border-radius: 6px;
    overflow-wrap: anywhere; word-break: break-word;
  }
  .tech { font-size: 11.5px; color: var(--muted); text-align: center; overflow-wrap: anywhere; }
  /*
   * A failed step's detail is raw upstream output — an ssh error, or the whole
   * multi-line probe script echoed back by a non-zero exit. Cap it so a long
   * message cannot push the status cards off-screen; the full text stays
   * reachable by scrolling the block (and by selecting it).
   */
  .value.detail {
    max-height: 7.5em; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; font-weight: 400; line-height: 1.45;
    background: var(--code-bg); border-radius: 8px; padding: 6px 8px;
    -webkit-user-select: text; user-select: text;
  }
  .value.detail::-webkit-scrollbar { width: 8px; }
  .value.detail::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; }
  /*
   * Compact mode for short viewports (remote mode's status window is 540x600).
   * Only the vertical rhythm and type scale shrink: the full-size layout above
   * is untouched at >=760px height, long paths still wrap (see .value and code),
   * and the palette / motion rules above keep applying.
   */
  @media (max-height: 760px) {
    .wrap { max-width: 560px; padding: 40px 18px 14px; gap: 8px; }
    .head { gap: 10px; }
    .logo { width: 28px; height: 28px; border-radius: 8px; font-size: 14px; }
    .head h1 { font-size: 15px; }
    .tagline { margin-top: 1px; font-size: 11px; }
    .status { padding: 11px 13px; gap: 10px; border-radius: 12px; }
    .status h2 { font-size: 14.5px; }
    .status p { margin-top: 3px; font-size: 12px; }
    .track { margin-top: 4px; }
    .card { padding: 9px 13px; border-radius: 12px; }
    .card h3 { margin-bottom: 5px; font-size: 10.5px; }
    .field { padding: 2px 0; gap: 2px 8px; }
    .label { min-width: 84px; font-size: 11.5px; }
    .value { flex-basis: 140px; font-size: 12.5px; }
    .chip { font-size: 10.5px; padding: 1px 7px; }
    code { font-size: 11.5px; padding: 1px 5px; }
    .tech { font-size: 10.5px; }
  }
</style>
</head>
<body>
<div class="titlebar" aria-hidden="true"></div>
<main class="wrap">
  <header class="head">
    <span class="logo" aria-hidden="true">${safe(APP_NAME.slice(0, 1))}</span>
    <div>
      <h1>${safe(APP_NAME)}</h1>
      <p class="tagline">${safe(isRemote ? copy.tagline.remote : copy.tagline.gateway)}</p>
    </div>
  </header>

  <section class="status status--${tone}" role="status">
    <span class="dot" aria-hidden="true"></span>
    <div class="status-text">
      <h2>${safe(toneText[tone].title)}</h2>
      <p>${safe(toneText[tone].body)}</p>
    </div>
    <div class="track" aria-hidden="true"><i></i></div>
  </section>
${stepCard}
  <section class="card">
    <h3>${safe(copy.sections.connection)}</h3>${connectionFields}
  </section>

  <section class="card">
    <h3>${safe(copy.sections.localWorkspace)}</h3>
    <div class="field">
      <span class="value"><code>${safe(config.workspaceRoot)}</code></span>
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
    await closeRemote();
    broadcastConnectionInfo();
    const config = resolveGatewayConfig(resolveWorkspace());
    showGatewayStatus(config, 'idle');
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
              ...(autoUpdateIntervalHours !== undefined ? { autoUpdateIntervalHours } : {})
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
          autoUpdateIntervalHours
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

  await startLocalMode();
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

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

import { app, BrowserWindow, Menu, Notification, ipcMain, nativeTheme, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer, type ServerHandle } from '@agent/ui';

import {
  INVOKE,
  THEME_CHANNEL,
  type NotificationPayload,
  type ThemePayload
} from './ipc.js';
import { ABOUT_LABELS, buildMenuTemplate, createMenuDispatcher } from './menu.js';

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
let shuttingDown = false;

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
    { dispatch: dispatchToRenderer, openDocs },
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
    if (serverHandle) mainWindow = createWindow(serverHandle.url);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
  void closeServer().finally(() => app.exit(0));
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
  // not writable: the engine's first `mkdir .myagent/…` would throw ENOENT and
  // the app would exit before showing a window. A GUI app has no "directory it
  // was started from", so the workspace is the user's home — the same place the
  // engine already falls back to for memory. `chdir` (rather than only passing
  // `workspaceDir`) keeps every cwd-relative path in the engine coherent, and
  // the explicit option means the session store never depends on that.
  const workspace = app.isPackaged ? app.getPath('home') : process.cwd();
  process.chdir(workspace);

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

if (gotTheLock) {
  installApplicationMenu();
  installIpcHandlers();
  installThemeSync();

  void bootstrap().catch((err) => {
    console.error('[superiu] failed to start:', err);
    app.exit(1);
  });
}

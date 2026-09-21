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

import { app, BrowserWindow, Menu, Notification, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer, type ServerHandle } from '@agent/ui';

import { INVOKE, type NotificationPayload } from './ipc.js';
import { buildMenuTemplate, createMenuDispatcher } from './menu.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..', '..');
const APP_NAME = 'SuperIU';

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
  // Local documentation ships with the repo; no network dependency.
  void shell.openPath(path.join(APP_ROOT, 'docs', 'agent-loop-and-context-architecture.md'));
}

function installApplicationMenu(): void {
  const template = buildMenuTemplate({ dispatch: dispatchToRenderer, openDocs }, APP_NAME);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  copyright: `© ${new Date().getFullYear()} SuperIU`,
  credits: 'Native desktop shell for the SuperIU agent console.'
});

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

  serverHandle = await startServer({ port: 0, quiet: true });
  console.log(`[superiu] UI server listening on ${serverHandle.url}`);

  mainWindow = createWindow(serverHandle.url);
}

if (gotTheLock) {
  installApplicationMenu();
  installIpcHandlers();

  void bootstrap().catch((err) => {
    console.error('[superiu] failed to start:', err);
    app.exit(1);
  });
}

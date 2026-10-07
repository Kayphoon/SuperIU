/**
 * Preload bridge for the SuperIU desktop shell.
 *
 * ── Why this file is `.cts` ─────────────────────────────────────────────────
 * The window runs with `sandbox: true` + `contextIsolation: true`, which is the
 * strictest Electron configuration. In that mode the preload is executed as
 * plain CommonJS with:
 *   - NO ESM support (`.mjs` preloads require `sandbox: false`), and
 *   - a `require` polyfill limited to a subset of `electron`
 *     (contextBridge, crashReporter, ipcRenderer, nativeImage, sharedTexture,
 *     webFrame, webUtils) — local modules and Node builtins are NOT reachable.
 *
 * Both facts were verified empirically against Electron 44 rather than assumed.
 * `.cts` compiles to `dist/preload.cjs`, so the file is CommonJS regardless of
 * the package's `"type": "module"`.
 *
 * Consequence: the channel names below are inlined literals. They are
 * cross-checked against `ipc.ts` at COMPILE TIME via the annotated types, so
 * drift between the contract and this bridge is a build error, never a silent
 * runtime mismatch.
 */

import type {
  MenuPayload,
  NotificationPayload,
  SuperiuDesktopBridge,
  ThemePayload,
  UpdatePayload,
  ConnectionInfoPayload
} from './ipc.js';

// Compile-time drift guards: each annotation pins the literal to the exact type
// declared in the shared contract. Change one side without the other → TS error.
const MENU_CHANNEL: typeof import('./ipc.js').MENU_CHANNEL = 'superiu:menu';
const THEME_CHANNEL: typeof import('./ipc.js').THEME_CHANNEL = 'superiu:theme';
const SET_BADGE_COUNT: typeof import('./ipc.js').INVOKE.setBadgeCount = 'superiu:set-badge-count';
const SHOW_NOTIFICATION: typeof import('./ipc.js').INVOKE.showNotification =
  'superiu:show-notification';
const FLASH_FRAME: typeof import('./ipc.js').INVOKE.flashFrame = 'superiu:flash-frame';
const QUIT: typeof import('./ipc.js').INVOKE.quit = 'superiu:quit';
const SET_LANGUAGE: typeof import('./ipc.js').INVOKE.setLanguage = 'superiu:set-language';
const SET_THEME: typeof import('./ipc.js').INVOKE.setTheme = 'superiu:set-theme';
const GET_SSH_HOSTS: typeof import('./ipc.js').INVOKE.getSshHosts = 'superiu:get-ssh-hosts';
const CONNECT_REMOTE: typeof import('./ipc.js').INVOKE.connectRemote = 'superiu:connect-remote';
const COMPLETE_ONBOARDING: typeof import('./ipc.js').INVOKE.completeOnboarding =
  'superiu:complete-onboarding';
const CHECK_FOR_UPDATE: typeof import('./ipc.js').INVOKE.checkForUpdate = 'superiu:check-for-update';
const INSTALL_UPDATE: typeof import('./ipc.js').INVOKE.installUpdate = 'superiu:install-update';
const GET_UPDATE_STATE: typeof import('./ipc.js').INVOKE.getUpdateState = 'superiu:get-update-state';
const GET_CONNECTION_INFO: typeof import('./ipc.js').INVOKE.getConnectionInfo =
  'superiu:get-connection-info';
const DISCONNECT_REMOTE: typeof import('./ipc.js').INVOKE.disconnectRemote =
  'superiu:disconnect-remote';
const CONNECTION_STATE_CHANNEL: typeof import('./ipc.js').CONNECTION_STATE_CHANNEL =
  'superiu:connection-state';
const REMOTE_PROGRESS_CHANNEL: typeof import('./ipc.js').REMOTE_PROGRESS_CHANNEL = 'superiu:remote-progress';
const UPDATE_STATE_CHANNEL: typeof import('./ipc.js').UPDATE_STATE_CHANNEL = 'superiu:update-state';

const { contextBridge, ipcRenderer } = require('electron');

const bridge: SuperiuDesktopBridge = {
  isDesktop: true,
  platform: process.platform,

  /**
   * Subscribe to menu actions forwarded from the main process.
   * Returns an unsubscribe function.
   */
  onMenu(callback: (payload: MenuPayload) => void): () => void {
    // The raw listener is wrapped so the renderer never receives the Electron
    // `IpcRendererEvent` (which would leak a privileged object across the bridge).
    const listener = (_event: unknown, payload: MenuPayload): void => callback(payload);
    ipcRenderer.on(MENU_CHANNEL, listener);
    return (): void => {
      ipcRenderer.off(MENU_CHANNEL, listener);
    };
  },

  /**
   * Subscribe to native appearance changes.
   * Returns an unsubscribe function.
   */
  onTheme(callback: (payload: ThemePayload) => void): () => void {
    const listener = (_event: unknown, payload: ThemePayload): void => callback(payload);
    ipcRenderer.on(THEME_CHANNEL, listener);
    return (): void => {
      ipcRenderer.off(THEME_CHANNEL, listener);
    };
  },

  setBadgeCount(count: number): Promise<void> {
    return ipcRenderer.invoke(SET_BADGE_COUNT, count);
  },

  showNotification(payload: NotificationPayload): Promise<void> {
    return ipcRenderer.invoke(SHOW_NOTIFICATION, payload);
  },

  flashFrame(): Promise<void> {
    return ipcRenderer.invoke(FLASH_FRAME);
  },

  quit(): Promise<void> {
    return ipcRenderer.invoke(QUIT);
  },

  setLanguage(language: string): Promise<void> {
    return ipcRenderer.invoke(SET_LANGUAGE, language);
  },

  setTheme(theme: string): Promise<void> {
    return ipcRenderer.invoke(SET_THEME, theme);
  },

  getSshHosts(): Promise<any> {
    return ipcRenderer.invoke(GET_SSH_HOSTS);
  },

  connectRemote(options: any): Promise<void> {
    return ipcRenderer.invoke(CONNECT_REMOTE, options);
  },

  completeOnboarding(options: { mode: 'local' }): Promise<void> {
    return ipcRenderer.invoke(COMPLETE_ONBOARDING, options);
  },

  onRemoteProgress(callback: (step: any) => void): () => void {
    const listener = (_event: unknown, step: any): void => callback(step);
    ipcRenderer.on(REMOTE_PROGRESS_CHANNEL, listener);
    return (): void => {
      ipcRenderer.off(REMOTE_PROGRESS_CHANNEL, listener);
    };
  },

  checkForUpdate(): Promise<void> {
    return ipcRenderer.invoke(CHECK_FOR_UPDATE);
  },

  installUpdate(): Promise<void> {
    return ipcRenderer.invoke(INSTALL_UPDATE);
  },

  getUpdateState(): Promise<UpdatePayload> {
    return ipcRenderer.invoke(GET_UPDATE_STATE);
  },

  onUpdateState(callback: (state: UpdatePayload) => void): () => void {
    void ipcRenderer.invoke(GET_UPDATE_STATE).then((state: UpdatePayload) => {
      if (state) callback(state);
    }).catch(() => {});

    const listener = (_event: unknown, state: UpdatePayload): void => callback(state);
    ipcRenderer.on(UPDATE_STATE_CHANNEL, listener);
    return (): void => {
      ipcRenderer.off(UPDATE_STATE_CHANNEL, listener);
    };
  },

  getConnectionInfo(): Promise<ConnectionInfoPayload> {
    return ipcRenderer.invoke(GET_CONNECTION_INFO);
  },

  onConnectionStateChange(callback: (info: ConnectionInfoPayload) => void): () => void {
    void ipcRenderer.invoke(GET_CONNECTION_INFO).then((info: ConnectionInfoPayload) => {
      if (info) callback(info);
    }).catch(() => {});

    const listener = (_event: unknown, info: ConnectionInfoPayload): void => callback(info);
    ipcRenderer.on(CONNECTION_STATE_CHANNEL, listener);
    return (): void => {
      ipcRenderer.off(CONNECTION_STATE_CHANNEL, listener);
    };
  },

  disconnectRemote(): Promise<void> {
    return ipcRenderer.invoke(DISCONNECT_REMOTE);
  }
};

// The renderer only ever sees this frozen surface; `ipcRenderer` itself is never
// exposed, so the page cannot send arbitrary IPC messages.
contextBridge.exposeInMainWorld('superiuDesktop', Object.freeze(bridge));
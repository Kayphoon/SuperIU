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

import type { MenuPayload, NotificationPayload, SuperiuDesktopBridge } from './ipc.js';

// Compile-time drift guards: each annotation pins the literal to the exact type
// declared in the shared contract. Change one side without the other → TS error.
const MENU_CHANNEL: typeof import('./ipc.js').MENU_CHANNEL = 'superiu:menu';
const SET_BADGE_COUNT: typeof import('./ipc.js').INVOKE.setBadgeCount = 'superiu:set-badge-count';
const SHOW_NOTIFICATION: typeof import('./ipc.js').INVOKE.showNotification =
  'superiu:show-notification';
const FLASH_FRAME: typeof import('./ipc.js').INVOKE.flashFrame = 'superiu:flash-frame';
const QUIT: typeof import('./ipc.js').INVOKE.quit = 'superiu:quit';
const SET_LANGUAGE: typeof import('./ipc.js').INVOKE.setLanguage = 'superiu:set-language';

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
  }
};

// The renderer only ever sees this frozen surface; `ipcRenderer` itself is never
// exposed, so the page cannot send arbitrary IPC messages.
contextBridge.exposeInMainWorld('superiuDesktop', Object.freeze(bridge));

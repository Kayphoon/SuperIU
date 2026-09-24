/**
 * Shared IPC contract between the Electron main process and the sandboxed
 * preload bridge. Both sides import this module, so the channel names and
 * payload shapes can never drift apart.
 *
 * The renderer never touches `ipcRenderer`; it only sees the narrow surface
 * exposed on `window.superiuDesktop` by `preload.ts`.
 */

/** Main → renderer: a native menu item asked the SPA to do something. */
export const MENU_CHANNEL = 'superiu:menu';

/** Renderer → main: window-level chrome requests (badge, notification, quit). */
export const INVOKE = {
  setBadgeCount: 'superiu:set-badge-count',
  showNotification: 'superiu:show-notification',
  flashFrame: 'superiu:flash-frame',
  quit: 'superiu:quit',
  setLanguage: 'superiu:set-language'
} as const;

/**
 * Menu actions the main process forwards to the renderer. The SPA also handles
 * these keystrokes itself, so the items are advertised with
 * `registerAccelerator: false` and dispatch on click — keeping the two paths in
 * sync and making the accelerators discoverable in the menu bar.
 *
 * Note `focus-input`: its accelerator is `Cmd+K`, but the SPA binds ⌘K to the
 * command palette, not to focusing the composer. That divergence predates this
 * contract and is deliberately left as-is.
 */
export type MenuAction =
  | 'settings'
  | 'new-session'
  | 'abort'
  | 'focus-input'
  | 'more'
  | 'toggle-sidebar'
  | 'about'
  | 'docs';

export interface MenuPayload {
  action: MenuAction;
}

export interface NotificationPayload {
  title: string;
  body: string;
}

/** Shape of `window.superiuDesktop`, mirrored here so both sides stay typed. */
export interface SuperiuDesktopBridge {
  readonly isDesktop: true;
  readonly platform: NodeJS.Platform;
  onMenu(callback: (payload: MenuPayload) => void): () => void;
  setBadgeCount(count: number): Promise<void>;
  showNotification(payload: NotificationPayload): Promise<void>;
  flashFrame(): Promise<void>;
  quit(): Promise<void>;
  /**
   * Tell the main process which language to build the native application menu
   * in. The renderer cannot reach Electron's `Menu`, so the menu bar is rebuilt
   * on the main-process side.
   */
  setLanguage(language: string): Promise<void>;
}

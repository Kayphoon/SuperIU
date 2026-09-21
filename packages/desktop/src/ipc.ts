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
  quit: 'superiu:quit'
} as const;

/**
 * Menu actions the main process forwards to the renderer. `Cmd+K` (focus
 * input) and `Cmd+.` (abort) are already handled by the SPA's own keydown
 * listeners; forwarding them from the menu keeps the two paths in sync and
 * makes the accelerators discoverable in the menu bar.
 */
export type MenuAction =
  | 'settings'
  | 'new-session'
  | 'abort'
  | 'focus-input'
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
}

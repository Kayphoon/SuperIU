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

/**
 * Main → renderer: the native appearance changed, so the page must re-resolve
 * its scheme. The page's `prefers-color-scheme` follows `nativeTheme`, so this
 * carries the resolved scheme rather than asking the renderer to guess.
 */
export const THEME_CHANNEL = 'superiu:theme';

/** Renderer → main: window-level chrome requests (badge, notification, quit). */
export const INVOKE = {
  setBadgeCount: 'superiu:set-badge-count',
  showNotification: 'superiu:show-notification',
  flashFrame: 'superiu:flash-frame',
  quit: 'superiu:quit',
  setLanguage: 'superiu:set-language',
  setTheme: 'superiu:set-theme'
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
  | 'toggle-sidebar';

export interface MenuPayload {
  action: MenuAction;
}

export interface NotificationPayload {
  title: string;
  body: string;
}

/** The scheme actually in force after resolving `system` against the OS. */
export type ColorScheme = 'dark' | 'light';

export interface ThemePayload {
  scheme: ColorScheme;
}

/** Shape of `window.superiuDesktop`, mirrored here so both sides stay typed. */
export interface SuperiuDesktopBridge {
  readonly isDesktop: true;
  readonly platform: NodeJS.Platform;
  onMenu(callback: (payload: MenuPayload) => void): () => void;
  /**
   * Subscribe to native appearance changes. The OS is the source of truth for
   * `system`, and Electron's `nativeTheme` also reflects an explicit
   * `themeSource` override, so the renderer treats this as the authoritative
   * signal rather than polling `matchMedia`.
   */
  onTheme(callback: (payload: ThemePayload) => void): () => void;
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
  /**
   * Tell the main process which appearance to render native chrome in. The
   * renderer cannot reach Electron's `nativeTheme`, so the window frame, menus
   * and vibrancy material are switched on the main-process side.
   */
  setTheme(theme: string): Promise<void>;
}

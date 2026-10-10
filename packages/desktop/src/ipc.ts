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
  setTheme: 'superiu:set-theme',
  getSshHosts: 'superiu:get-ssh-hosts',
  connectRemote: 'superiu:connect-remote',
  completeOnboarding: 'superiu:complete-onboarding',
  checkForUpdate: 'superiu:check-for-update',
  installUpdate: 'superiu:install-update',
  getUpdateState: 'superiu:get-update-state',
  getConnectionInfo: 'superiu:get-connection-info',
  disconnectRemote: 'superiu:disconnect-remote',
  upgradeRemote: 'superiu:upgrade-remote',
  connectCustomUrl: 'superiu:connect-custom-url'
} as const;

export const REMOTE_PROGRESS_CHANNEL = 'superiu:remote-progress';
export const UPDATE_STATE_CHANNEL = 'superiu:update-state';
export const CONNECTION_STATE_CHANNEL = 'superiu:connection-state';

export interface ConnectionInfoPayload {
  mode: 'local' | 'remote' | 'gateway' | 'custom_url';
  alias?: string;
  remoteWorkspace?: string;
  localPort?: number;
  customUrl?: string;
  advertiseUrl?: string;
  state: 'idle' | 'connected' | 'connecting' | 'reconnecting' | 'closed';
  rttMs?: number;
}

/**
 * Menu actions the main process forwards to the renderer. The SPA also handles
 * these keystrokes itself, so the items are advertised with native accelerators
 * and dispatch on click — keeping the two paths in sync.
 */
export type MenuAction = 'settings' | 'new-session';

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

export interface UpdatePayload {
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  percent?: number;
  error?: string;
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
  getSshHosts?(): Promise<Array<{ alias: string; hostName: string; user?: string }>>;
  connectRemote?(options: {
    alias: string;
    workspace: string;
    /**
     * Fixed local forward port. Persisted to `remote.localPort` when
     * `saveDefault` is set (`resolveGatewayConfig` reads it back on the next
     * boot); omitted → an ephemeral port is allocated.
     */
    localPort?: number;
    saveDefault?: boolean;
    autoUpdateIdle?: boolean;
    autoUpdateIntervalHours?: number;
  }): Promise<void>;
  onRemoteProgress?(callback: (step: { id: string; status: string; detail?: string }) => void): () => void;
  /**
   * Connect directly to an already-running SuperIU service at `url`, optionally
   * presenting a pairing token. `saveDefault` records the choice (and marks
   * onboarding complete) so it is restored on the next launch.
   */
  connectCustomUrl?(options: { url: string; token?: string; saveDefault?: boolean }): Promise<void>;
  /**
   * Record the first-run choice of the local in-process engine and start it.
   * Only `{ mode: 'local' }` is supported; the remote path goes through
   * {@link connectRemote} (which the wizard also calls and which records
   * `onboardingCompleted` on its own).
   */
  completeOnboarding(options: { mode: 'local' }): Promise<void>;
  checkForUpdate?(): Promise<void>;
  installUpdate?(): Promise<void>;
  getUpdateState?(): Promise<UpdatePayload>;
  onUpdateState?(callback: (state: UpdatePayload) => void): () => void;
  getConnectionInfo?(): Promise<ConnectionInfoPayload>;
  onConnectionStateChange?(callback: (info: ConnectionInfoPayload) => void): () => void;
  disconnectRemote?(): Promise<void>;
  upgradeRemote?(): Promise<{ ok: boolean; error?: string }>;
}
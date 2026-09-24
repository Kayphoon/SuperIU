import type { MenuItemConstructorOptions } from 'electron';
import { MENU_CHANNEL, type MenuAction, type MenuPayload } from './ipc.js';

/**
 * Everything the menu needs from the host application. Injected rather than
 * imported so the template can be built (and asserted) without a live Electron
 * runtime.
 */
export interface MenuHandlers {
  /** Forward a menu action to the focused renderer over `MENU_CHANNEL`. */
  dispatch(action: MenuAction): void;
  /** Reveal the project documentation. */
  openDocs(): void;
}

/**
 * Build the `dispatch` half of {@link MenuHandlers} on top of an arbitrary
 * "send to renderer" function.
 *
 * This is the single place the `superiu:menu` payload is constructed, so the
 * documented `{ action }` shape cannot drift from the menu template.
 */
export function createMenuDispatcher(
  send: (channel: string, payload: MenuPayload) => void
): (action: MenuAction) => void {
  return (action: MenuAction): void => {
    send(MENU_CHANNEL, { action });
  };
}

/**
 * Native-menu labels, keyed by UI language.
 *
 * Deliberately NOT `public/i18n.js`: the native menu is a main-process surface
 * with no key overlap, and the browser module is not importable from the
 * packaged main process (it is served to the renderer, not resolved by Node).
 *
 * Role-based items are absent by design — Electron supplies their labels.
 */
const MENU_LABELS = {
  zh: {
    app: 'SuperIU',
    settings: '设置…',
    newSession: '新建会话',
    focusInput: '聚焦输入框',
    abort: '中止本轮',
    more: '更多',
    toggleSidebar: '切换侧边栏',
    file: '文件',
    edit: '编辑',
    view: '视图',
    window: '窗口',
    help: '帮助',
    documentation: 'SuperIU 文档'
  },
  en: {
    app: 'SuperIU',
    settings: 'Settings…',
    newSession: 'New Session',
    focusInput: 'Focus Input',
    abort: 'Abort Turn',
    more: 'More',
    toggleSidebar: 'Toggle Sidebar',
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    help: 'Help',
    documentation: 'SuperIU Documentation'
  }
} as const;

/**
 * The macOS application menu.
 *
 * Accelerators here are REAL main-process menu accelerators — they are handled
 * by Electron before the renderer ever sees a `keydown`, which is precisely why
 * `Cmd+Q` and `Cmd+,` are impossible to deliver from a plain browser tab.
 *
 * `Cmd+K`, `Cmd+.` and `Cmd+J` are marked `registerAccelerator: false`. That
 * option is documented `@platform linux,win32`, so on macOS the accelerator may
 * still be registered and take the key before the renderer; on linux/win32 the
 * page keeps the key and the item only dispatches when clicked.
 *
 * Whether that divergence is harmless depends on the item:
 *   - `Cmd+J` (More) and `Cmd+.` (Abort) dispatch exactly what the SPA's own
 *     keydown handler does, so both paths converge on one behaviour.
 *   - `Cmd+K` does NOT: the menu item is "Focus Input" (`focus-input`), while
 *     the SPA binds ⌘K to the command palette. This is a pre-existing semantic
 *     divergence, out of scope here, and is NOT fixed by this file.
 */
export function buildMenuTemplate(
  handlers: MenuHandlers,
  appName = 'SuperIU',
  language: 'zh' | 'en' = 'zh'
): MenuItemConstructorOptions[] {
  const dispatch = handlers.dispatch;
  // Total lookup: an unknown id falls back to `zh`, matching the SPA default.
  const L = MENU_LABELS[language] ?? MENU_LABELS.zh;

  const appMenu: MenuItemConstructorOptions = {
    label: L.app,
    submenu: [
      // `role: 'about'` renders the panel configured by app.setAboutPanelOptions.
      { role: 'about' },
      {
        label: L.settings,
        accelerator: 'Cmd+,',
        click: () => dispatch('settings')
      },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit', accelerator: 'Cmd+Q' }
    ]
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: L.file,
    submenu: [
      {
        label: L.newSession,
        accelerator: 'Cmd+N',
        click: () => dispatch('new-session')
      },
      { type: 'separator' },
      {
        label: L.focusInput,
        accelerator: 'Cmd+K',
        // KNOWN DIVERGENCE (pre-existing, not introduced here): the SPA binds
        // ⌘K to the command palette (`openModal('palette')`), while this item
        // focuses the composer. If macOS registers this accelerator, ⌘K in the
        // desktop shell does something different from ⌘K in a browser tab.
        registerAccelerator: false,
        click: () => dispatch('focus-input')
      },
      {
        label: L.abort,
        accelerator: 'Cmd+.',
        // Converges with the SPA: its ⌘. handler also calls abortTurn().
        registerAccelerator: false,
        click: () => dispatch('abort')
      },
      {
        label: L.more,
        accelerator: 'Cmd+J',
        // On linux/win32 `registerAccelerator: false` keeps the key with the
        // page; on macOS the accelerator may be registered and dispatched by
        // the native menu instead. Either way this is safe: the item dispatches
        // the same action the SPA's own ⌘J handler performs, so the drawer
        // toggles exactly once.
        // Deliberately NOT Cmd+M — `{ role: 'minimize' }` below already owns
        // that accelerator (verified against electron 44.4.3's role table).
        registerAccelerator: false,
        click: () => dispatch('more')
      },
      { type: 'separator' },
      { role: 'close', accelerator: 'Cmd+W' }
    ]
  };

  const editMenu: MenuItemConstructorOptions = {
    label: L.edit,
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: L.view,
    submenu: [
      {
        label: L.toggleSidebar,
        accelerator: 'Cmd+B',
        registerAccelerator: false,
        click: () => dispatch('toggle-sidebar')
      },
      { type: 'separator' },
      { role: 'reload', accelerator: 'Cmd+R' },
      { role: 'forceReload' },
      { role: 'toggleDevTools', accelerator: 'Alt+Cmd+I' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: L.window,
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    // `role: 'help'` would otherwise supply its own English "Help" label, which
    // is why this one is set explicitly unlike the other role items.
    label: L.help,
    submenu: [
      {
        label: L.documentation,
        click: () => handlers.openDocs()
      }
    ]
  };

  return [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}

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
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    help: 'Help',
    documentation: 'SuperIU Documentation'
  }
} as const;

/**
 * Native About-panel copy, keyed by UI language.
 *
 * Same `zh`/`en` shape and same reason as {@link MENU_LABELS}: the panel is
 * drawn by AppKit in the main process, so the renderer's dictionary
 * (`packages/ui/public/i18n.js`) cannot reach it — but the product must not be
 * described in two vocabularies, so `credits` repeats the SPA's
 * `settings.about.product` string verbatim.
 */
export const ABOUT_LABELS = {
  zh: { credits: 'SuperIU · 自主智能体控制台' },
  en: { credits: 'SuperIU · Autonomous agent console' }
} as const;

/**
 * The macOS application menu.
 *
 * Accelerators here are REAL main-process menu accelerators — they are handled
 * by Electron before the renderer ever sees a `keydown`, which is precisely why
 * `Cmd+Q` and `Cmd+,` are impossible to deliver from a plain browser tab.
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
      { role: 'reload', accelerator: 'Cmd+R' },
      { role: 'forceReload' },
      { role: 'toggleDevTools', accelerator: 'Alt+Cmd+I' },
      { type: 'separator' },
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

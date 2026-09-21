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
 * The macOS application menu.
 *
 * Accelerators here are REAL main-process menu accelerators — they are handled
 * by Electron before the renderer ever sees a `keydown`, which is precisely why
 * `Cmd+Q` and `Cmd+,` are impossible to deliver from a plain browser tab.
 *
 * `Cmd+K` and `Cmd+.` are marked `registerAccelerator: false`: the SPA already
 * owns those keystrokes (command palette / abort), so the items advertise the
 * shortcut and still dispatch when clicked, without stealing the key event.
 */
export function buildMenuTemplate(
  handlers: MenuHandlers,
  appName = 'SuperIU'
): MenuItemConstructorOptions[] {
  const dispatch = handlers.dispatch;

  const appMenu: MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      // `role: 'about'` renders the panel configured by app.setAboutPanelOptions.
      { role: 'about' },
      {
        label: 'Settings…',
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
    label: 'File',
    submenu: [
      {
        label: 'New Session',
        accelerator: 'Cmd+N',
        click: () => dispatch('new-session')
      },
      { type: 'separator' },
      {
        label: 'Focus Input',
        accelerator: 'Cmd+K',
        // The SPA handles Cmd+K itself; advertise it without consuming it.
        registerAccelerator: false,
        click: () => dispatch('focus-input')
      },
      {
        label: 'Abort Turn',
        accelerator: 'Cmd+.',
        registerAccelerator: false,
        click: () => dispatch('abort')
      },
      { type: 'separator' },
      { role: 'close', accelerator: 'Cmd+W' }
    ]
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
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
    label: 'View',
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
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      {
        label: 'SuperIU Documentation',
        click: () => handlers.openDocs()
      }
    ]
  };

  return [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}

import { Menu, app, shell } from "electron"

import type { WindowManager } from "./window-manager"

export function installApplicationMenu(
  windows: WindowManager,
  checkForUpdates: () => Promise<void>
) {
  const menu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates…",
          click: () => void checkForUpdates(),
        },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () =>
            windows.sendToFocused({
              type: "command",
              command: "open-preferences",
            }),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Tab",
          accelerator: "CmdOrCtrl+T",
          click: () =>
            windows.sendToFocused({ type: "command", command: "new-tab" }),
        },
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () =>
            windows.sendToFocused({ type: "command", command: "close-tab" }),
        },
        { type: "separator" },
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+N",
          click: () => windows.create(),
        },
        {
          label: "Close Window",
          accelerator: "CmdOrCtrl+Shift+W",
          role: "close",
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Back",
          accelerator: "CmdOrCtrl+[",
          click: () =>
            windows.sendToFocused({ type: "command", command: "tab-back" }),
        },
        {
          label: "Forward",
          accelerator: "CmdOrCtrl+]",
          click: () =>
            windows.sendToFocused({ type: "command", command: "tab-forward" }),
        },
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged
          ? []
          : ([
              { role: "toggleDevTools" },
            ] as Array<Electron.MenuItemConstructorOptions>)),
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Open Current Page in Browser",
          click: () => {
            const url = windows.getFocused()?.webContents.getURL()
            if (url) void shell.openExternal(url)
          },
        },
      ],
    },
  ])

  Menu.setApplicationMenu(menu)
}

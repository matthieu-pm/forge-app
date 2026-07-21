import { app, autoUpdater, dialog } from "electron"
import { resolveUpdateBaseUrl } from "./runtime-config"
import type { MessageBoxOptions } from "electron"

import type { WindowManager } from "./window-manager"

const updateIntervalMs = 6 * 60 * 60 * 1000

export function configureUpdater(windows: WindowManager) {
  const baseUrl = resolveUpdateBaseUrl()

  if (!app.isPackaged || !baseUrl) {
    return {
      check: async () => {},
    }
  }

  autoUpdater.setFeedURL({
    url: `${baseUrl}/${process.platform}/${process.arch}`,
  })

  autoUpdater.on("update-downloaded", async (_event, _notes, version) => {
    windows.broadcast({
      type: "update-ready",
      version,
    })

    const options: MessageBoxOptions = {
      type: "info",
      title: "Forge update ready",
      message: `Forge ${version} is ready to install.`,
      detail: "Restart Forge to finish the update.",
      buttons: ["Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
    }
    const parent = windows.getFocused()
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)

    if (result.response === 0) {
      autoUpdater.quitAndInstall()
    }
  })

  autoUpdater.on("error", (error) => {
    console.error("Forge update failed", error)
  })

  const check = async () => {
    await autoUpdater.checkForUpdates()
  }

  setTimeout(() => void check(), 30_000).unref()
  setInterval(() => void check(), updateIntervalMs).unref()

  return { check }
}

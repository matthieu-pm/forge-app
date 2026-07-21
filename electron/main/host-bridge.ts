import { Notification, app, ipcMain, shell } from "electron"
import {
  desktopChannels,
  externalUrlSchema,
  notificationSchema,
  routePathSchema,
  unreadCountSchema,
} from "../shared/bridge-contract"
import type { IpcMainInvokeEvent } from "electron"

import type {
  ForgeNotification,
  HostCapability,
  HostRuntime,
} from "../../src/host/forge-host"
import type { WindowManager } from "./window-manager"

const capabilities: Array<HostCapability> = [
  "deep-links",
  "dock-badge",
  "multi-window",
  "native-notifications",
  "updates",
]

function assertTrustedSender(event: IpcMainInvokeEvent, appOrigin: string) {
  const frame = event.senderFrame

  if (!frame || frame !== event.sender.mainFrame) {
    throw new Error("Desktop bridge calls are limited to the main frame.")
  }

  try {
    if (new URL(frame.url).origin !== new URL(appOrigin).origin) {
      throw new Error("Desktop bridge call came from an untrusted origin.")
    }
  } catch {
    throw new Error("Desktop bridge call came from an invalid origin.")
  }
}

export function registerHostBridge(windows: WindowManager, appOrigin: string) {
  const trusted = <T>(
    handler: (event: IpcMainInvokeEvent, input: unknown) => T | Promise<T>
  ) => {
    return (event: IpcMainInvokeEvent, input: unknown) => {
      assertTrustedSender(event, appOrigin)
      return handler(event, input)
    }
  }

  ipcMain.handle(
    desktopChannels.getRuntime,
    trusted(
      (): HostRuntime => ({
        platform: process.platform === "win32" ? "windows" : "macos",
        hostVersion: app.getVersion(),
        capabilities,
      })
    )
  )

  ipcMain.handle(
    desktopChannels.openExternal,
    trusted(async (_event, input) => {
      await shell.openExternal(externalUrlSchema.parse(input))
    })
  )

  ipcMain.handle(
    desktopChannels.setUnreadCount,
    trusted((_event, input) => {
      app.setBadgeCount(unreadCountSchema.parse(input))
    })
  )

  ipcMain.handle(
    desktopChannels.showNotification,
    trusted((_event, input) => {
      const notificationInput: ForgeNotification =
        notificationSchema.parse(input)

      if (!Notification.isSupported()) {
        return
      }

      const notification = new Notification({
        title: notificationInput.title,
        body: notificationInput.body,
      })

      if (notificationInput.path) {
        notification.on("click", () => {
          windows.navigate(notificationInput.path!)
        })
      }

      notification.show()
    })
  )

  ipcMain.handle(
    desktopChannels.openWindow,
    trusted((_event, input) => {
      windows.create(routePathSchema.parse(input))
    })
  )
}

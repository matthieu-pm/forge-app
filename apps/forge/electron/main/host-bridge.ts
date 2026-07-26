import {
  BrowserWindow,
  Notification,
  app,
  ipcMain,
  nativeTheme,
  shell,
} from "electron"
import {
  beginAuthSchema,
  completeAuthSchema,
  desktopChannels,
  externalUrlSchema,
  localRuntimeIdSchema,
  localRuntimeRunIdSchema,
  notificationSchema,
  resolveLocalRuntimeApprovalSchema,
  resolveLocalRuntimeToolCallSchema,
  routePathSchema,
  startLocalRuntimeRunSchema,
  themeSourceSchema,
  unreadCountSchema,
} from "../shared/bridge-contract"
import { configureAppAppearance } from "./appearance"
import type { IpcMainInvokeEvent } from "electron"

import type {
  ForgeNotification,
  HostCapability,
  HostRuntime,
} from "../../src/host/forge-host"
import type { WindowManager } from "./window-manager"
import type { DesktopAuth } from "./desktop-auth"
import type { ModelBroker } from "./model-broker/broker"

const capabilities: Array<HostCapability> = [
  "browser-auth",
  "deep-links",
  "dock-badge",
  "multi-window",
  "local-agent-runtimes",
  "native-notifications",
  "updates",
]

export function assertTrustedSender(
  event: IpcMainInvokeEvent,
  appOrigin: string
) {
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

export function registerHostBridge(
  windows: WindowManager,
  appOrigin: string,
  desktopAuth: DesktopAuth,
  modelBroker: ModelBroker
) {
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
    desktopChannels.setThemeSource,
    trusted((_event, input) => {
      configureAppAppearance(nativeTheme, themeSourceSchema.parse(input))
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

  ipcMain.handle(
    desktopChannels.beginAuth,
    trusted(async (event, input) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        throw new Error("Authentication must start from a Forge window.")
      }

      const { returnTo } = beginAuthSchema.parse(input)
      await desktopAuth.begin(window, returnTo)
    })
  )

  ipcMain.handle(
    desktopChannels.completeAuth,
    trusted(async (_event, input) => {
      const { token } = completeAuthSchema.parse(input)
      await desktopAuth.complete(token)
    })
  )

  ipcMain.handle(
    desktopChannels.adoptAuthSession,
    trusted(async (event) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        throw new Error("Authentication must finish in a Forge window.")
      }

      const result = await desktopAuth.adopt(event.sender.session, window)
      windows.broadcastExcept(
        { type: "auth-session-adopted", returnTo: "/inbox" },
        event.sender.id
      )
      return result
    })
  )

  ipcMain.handle(
    desktopChannels.signOut,
    trusted(async (event) => {
      await desktopAuth.signOut(event.sender.session)
      windows.broadcast({ type: "auth-signed-out" })
    })
  )

  ipcMain.handle(
    desktopChannels.listLocalRuntimes,
    trusted(async () => [await modelBroker.inspectCodex()])
  )

  ipcMain.handle(
    desktopChannels.startLocalRuntimeLogin,
    trusted(async (_event, input) => {
      localRuntimeIdSchema.parse(input)
      return modelBroker.startCodexLogin()
    })
  )

  ipcMain.handle(
    desktopChannels.startLocalRuntimeRun,
    trusted(async (event, input) => {
      const parsed = startLocalRuntimeRunSchema.parse(input)
      return modelBroker.startCodexRun(parsed, (message) => {
        if (event.sender.isDestroyed()) return
        event.sender.send(desktopChannels.hostEvent, {
          type: "local-agent-event",
          message,
        })
      })
    })
  )

  ipcMain.handle(
    desktopChannels.cancelLocalRuntimeRun,
    trusted(async (_event, input) => {
      await modelBroker.cancelCodexRun(localRuntimeRunIdSchema.parse(input))
    })
  )

  ipcMain.handle(
    desktopChannels.resolveLocalRuntimeApproval,
    trusted((_event, input) => {
      modelBroker.resolveCodexApproval(
        resolveLocalRuntimeApprovalSchema.parse(input)
      )
    })
  )

  ipcMain.handle(
    desktopChannels.resolveLocalRuntimeToolCall,
    trusted((_event, input) => {
      modelBroker.resolveCodexToolCall(
        resolveLocalRuntimeToolCallSchema.parse(input)
      )
    })
  )
}

import { setupRenderer } from "@better-auth/electron/preload"
import { contextBridge, ipcRenderer } from "electron"

import { desktopChannels } from "../shared/bridge-contract"
import type {
  ForgeDesktopBridge,
  ForgeNotification,
  HostEvent,
  HostRuntime,
  LocalAgentRuntime,
} from "../../src/host/forge-host"

setupRenderer()

const bridge: ForgeDesktopBridge = {
  copyText: (value: string) =>
    ipcRenderer.invoke(desktopChannels.copyText, value),
  getRuntime: () =>
    ipcRenderer.invoke(desktopChannels.getRuntime) as Promise<HostRuntime>,
  openExternal: (url: string) =>
    ipcRenderer.invoke(desktopChannels.openExternal, url),
  setUnreadCount: (count: number) =>
    ipcRenderer.invoke(desktopChannels.setUnreadCount, count),
  setThemeSource: (source) =>
    ipcRenderer.invoke(desktopChannels.setThemeSource, source),
  showNotification: (input: ForgeNotification) =>
    ipcRenderer.invoke(desktopChannels.showNotification, input),
  openWindow: (path: string) =>
    ipcRenderer.invoke(desktopChannels.openWindow, path),
  beginAuth: (input) => ipcRenderer.invoke(desktopChannels.beginAuth, input),
  completeAuth: (input) =>
    ipcRenderer.invoke(desktopChannels.completeAuth, input),
  adoptAuthSession: () => ipcRenderer.invoke(desktopChannels.adoptAuthSession),
  signOut: () => ipcRenderer.invoke(desktopChannels.signOut),
  listLocalRuntimes: () =>
    ipcRenderer.invoke(desktopChannels.listLocalRuntimes) as Promise<
      Array<LocalAgentRuntime>
    >,
  startLocalRuntimeLogin: (runtimeId) =>
    ipcRenderer.invoke(desktopChannels.startLocalRuntimeLogin, runtimeId),
  startLocalRuntimeRun: (input) =>
    ipcRenderer.invoke(desktopChannels.startLocalRuntimeRun, input),
  cancelLocalRuntimeRun: (runId) =>
    ipcRenderer.invoke(desktopChannels.cancelLocalRuntimeRun, runId),
  resolveLocalRuntimeApproval: (input) =>
    ipcRenderer.invoke(desktopChannels.resolveLocalRuntimeApproval, input),
  resolveLocalRuntimeToolCall: (input) =>
    ipcRenderer.invoke(desktopChannels.resolveLocalRuntimeToolCall, input),
  subscribe: (listener: (event: HostEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: HostEvent) => {
      listener(event)
    }

    const authenticatedHandler = () => {
      listener({ type: "auth-ready" })
    }

    const authErrorHandler = (
      _event: Electron.IpcRendererEvent,
      context: unknown
    ) => {
      const candidate =
        typeof context === "object" && context
          ? Reflect.get(context, "message")
          : null
      listener({
        type: "auth-error",
        message:
          typeof candidate === "string"
            ? candidate.slice(0, 500)
            : "Authentication could not be completed.",
      })
    }

    ipcRenderer.on(desktopChannels.hostEvent, handler)
    ipcRenderer.on("better-auth:authenticated", authenticatedHandler)
    ipcRenderer.on("better-auth:error", authErrorHandler)

    return () => {
      ipcRenderer.removeListener(desktopChannels.hostEvent, handler)
      ipcRenderer.removeListener(
        "better-auth:authenticated",
        authenticatedHandler
      )
      ipcRenderer.removeListener("better-auth:error", authErrorHandler)
    }
  },
}

contextBridge.exposeInMainWorld("forgeDesktop", bridge)

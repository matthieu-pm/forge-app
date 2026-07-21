import { setupRenderer } from "@better-auth/electron/preload"
import { contextBridge, ipcRenderer } from "electron"

import { desktopChannels } from "../shared/bridge-contract"
import type {
  ForgeDesktopBridge,
  ForgeNotification,
  HostEvent,
  HostRuntime,
} from "../../src/host/forge-host"

setupRenderer()

const bridge: ForgeDesktopBridge = {
  getRuntime: () =>
    ipcRenderer.invoke(desktopChannels.getRuntime) as Promise<HostRuntime>,
  openExternal: (url: string) =>
    ipcRenderer.invoke(desktopChannels.openExternal, url),
  setUnreadCount: (count: number) =>
    ipcRenderer.invoke(desktopChannels.setUnreadCount, count),
  showNotification: (input: ForgeNotification) =>
    ipcRenderer.invoke(desktopChannels.showNotification, input),
  openWindow: (path: string) =>
    ipcRenderer.invoke(desktopChannels.openWindow, path),
  subscribe: (listener: (event: HostEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: HostEvent) => {
      listener(event)
    }

    ipcRenderer.on(desktopChannels.hostEvent, handler)
    return () => ipcRenderer.removeListener(desktopChannels.hostEvent, handler)
  },
}

contextBridge.exposeInMainWorld("forgeDesktop", bridge)

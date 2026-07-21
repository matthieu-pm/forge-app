export type HostCapability =
  | "deep-links"
  | "dock-badge"
  | "multi-window"
  | "native-notifications"
  | "updates"

export type HostRuntime = {
  platform: "web" | "macos" | "windows"
  hostVersion: string | null
  capabilities: Array<HostCapability>
}

export type ForgeNotification = {
  id: string
  title: string
  body: string
  path?: string
}

export type HostEvent =
  | { type: "navigate"; path: string }
  | {
      type: "command"
      command:
        | "find"
        | "open-preferences"
        | "new-tab"
        | "close-tab"
        | "tab-back"
        | "tab-forward"
    }
  | { type: "update-ready"; version: string }

export interface ForgeHost {
  getRuntime: () => Promise<HostRuntime>
  openExternal: (url: string) => Promise<void>
  setUnreadCount: (count: number) => Promise<void>
  showNotification: (input: ForgeNotification) => Promise<void>
  openWindow: (path: string) => Promise<void>
  subscribe: (listener: (event: HostEvent) => void) => () => void
}

export interface ForgeDesktopBridge extends ForgeHost {}

declare global {
  interface Window {
    forgeDesktop?: ForgeDesktopBridge
  }
}

const browserHost: ForgeHost = {
  getRuntime() {
    return Promise.resolve({
      platform: "web",
      hostVersion: null,
      capabilities: [],
    })
  },
  openExternal(url) {
    window.open(url, "_blank", "noopener,noreferrer")
    return Promise.resolve()
  },
  setUnreadCount() {
    return Promise.resolve()
  },
  showNotification(input) {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(input.title, {
        body: input.body,
        tag: input.id,
      })
    }
    return Promise.resolve()
  },
  openWindow(path) {
    window.open(path, "_blank", "noopener,noreferrer")
    return Promise.resolve()
  },
  subscribe() {
    return () => {}
  },
}

export function createForgeHost(bridge?: ForgeDesktopBridge): ForgeHost {
  return bridge ?? browserHost
}

export function getForgeHost(): ForgeHost {
  return createForgeHost(
    typeof window === "undefined" ? undefined : window.forgeDesktop
  )
}

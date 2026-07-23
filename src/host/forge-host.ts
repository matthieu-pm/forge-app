export type HostCapability =
  | "browser-auth"
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

export type HostThemeSource = "system" | "light" | "dark"

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
  | { type: "auth-ready" }
  | { type: "auth-session-adopted"; returnTo: string }
  | { type: "auth-signed-out" }
  | { type: "auth-error"; message: string }

export type BeginAuthInput = {
  returnTo?: string
}

export type CompleteAuthInput = {
  token: string
}

export type AdoptAuthSessionResult = {
  returnTo: string
}

export interface ForgeHost {
  getRuntime: () => Promise<HostRuntime>
  openExternal: (url: string) => Promise<void>
  setUnreadCount: (count: number) => Promise<void>
  setThemeSource: (source: HostThemeSource) => Promise<void>
  showNotification: (input: ForgeNotification) => Promise<void>
  openWindow: (path: string) => Promise<void>
  beginAuth: (input: BeginAuthInput) => Promise<void>
  completeAuth: (input: CompleteAuthInput) => Promise<void>
  adoptAuthSession: () => Promise<AdoptAuthSessionResult>
  signOut: () => Promise<void>
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
  setThemeSource() {
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
  beginAuth() {
    return Promise.reject(
      new Error("Browser authentication is only available in the desktop app.")
    )
  },
  completeAuth() {
    return Promise.reject(
      new Error("Desktop authentication is unavailable in the browser.")
    )
  },
  adoptAuthSession() {
    return Promise.reject(
      new Error("Desktop session adoption is unavailable in the browser.")
    )
  },
  signOut() {
    return Promise.resolve()
  },
  subscribe() {
    return () => {}
  },
}

export function createForgeHost(bridge?: ForgeDesktopBridge): ForgeHost {
  if (!bridge) {
    return browserHost
  }

  if (typeof bridge.setThemeSource === "function") {
    return bridge
  }

  return {
    ...bridge,
    setThemeSource: browserHost.setThemeSource,
  }
}

export function getForgeHost(): ForgeHost {
  return createForgeHost(
    typeof window === "undefined" ? undefined : window.forgeDesktop
  )
}

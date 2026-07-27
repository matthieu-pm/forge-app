import type {
  AgentEventSource,
  AgentEventType,
} from "@/application/agents/event-contract"

export type HostCapability =
  | "browser-auth"
  | "deep-links"
  | "dock-badge"
  | "multi-window"
  | "local-agent-runtimes"
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
  | {
      type: "local-agent-event"
      message: LocalAgentBrokerEvent
    }

export type BeginAuthInput = {
  returnTo?: string
}

export type CompleteAuthInput = {
  token: string
}

export type AdoptAuthSessionResult = {
  returnTo: string
}

export type LocalAgentRuntime = {
  id: "codex"
  label: string
  status:
    | "ready"
    | "login-required"
    | "repair-required"
    | "unavailable"
    | "policy-blocked"
  statusReason: string | null
  accountLabel: string | null
  billingMode: "subscription"
  locality: "local-only"
  models: Array<{
    selectionId: string
    modelId: string
    displayName: string
    supportedReasoningEfforts: Array<string>
    contextWindowTokens: number | null
  }>
}

export type StartLocalRuntimeRunInput = {
  runtimeId: "codex"
  runId: string
  runtimeSessionId: string | null
  modelId: string
  reasoningEffort:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
  message: string
  attachments: Array<{
    id: string
    name: string
    contentType: string
    sizeBytes: number
    contentBase64: string
  }>
}

export type LocalAgentBrokerEvent =
  | {
      type: "runtime-event"
      runId: string
      event: {
        sourceEventId: string
        source: AgentEventSource
        type: AgentEventType
        occurredAt: string
        payload: Record<string, unknown>
      }
    }
  | {
      type: "tool-call-request"
      runId: string
      requestId: string
      namespace: string | null
      tool: string
      arguments: Record<string, unknown>
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
  listLocalRuntimes: () => Promise<Array<LocalAgentRuntime>>
  startLocalRuntimeLogin: (runtimeId: "codex") => Promise<unknown>
  startLocalRuntimeRun: (
    input: StartLocalRuntimeRunInput
  ) => Promise<{ runtimeSessionId: string; runtimeRunId: string }>
  cancelLocalRuntimeRun: (runId: string) => Promise<void>
  resolveLocalRuntimeApproval: (input: {
    runId: string
    approvalId: string
    decision: "approved" | "denied"
  }) => Promise<void>
  resolveLocalRuntimeToolCall: (input: {
    runId: string
    requestId: string
    success: boolean
    output: unknown
  }) => Promise<void>
  subscribe: (listener: (event: HostEvent) => void) => () => void
}

export interface ForgeDesktopBridge extends Omit<
  ForgeHost,
  | "listLocalRuntimes"
  | "startLocalRuntimeLogin"
  | "startLocalRuntimeRun"
  | "cancelLocalRuntimeRun"
  | "resolveLocalRuntimeApproval"
  | "resolveLocalRuntimeToolCall"
> {
  copyText?: (value: string) => Promise<void>
  listLocalRuntimes?: ForgeHost["listLocalRuntimes"]
  startLocalRuntimeLogin?: ForgeHost["startLocalRuntimeLogin"]
  startLocalRuntimeRun?: ForgeHost["startLocalRuntimeRun"]
  cancelLocalRuntimeRun?: ForgeHost["cancelLocalRuntimeRun"]
  resolveLocalRuntimeApproval?: ForgeHost["resolveLocalRuntimeApproval"]
  resolveLocalRuntimeToolCall?: ForgeHost["resolveLocalRuntimeToolCall"]
}

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
  listLocalRuntimes() {
    return Promise.resolve([])
  },
  startLocalRuntimeLogin() {
    return Promise.reject(
      new Error("Local agent subscriptions require the Forge desktop app.")
    )
  },
  startLocalRuntimeRun() {
    return Promise.reject(
      new Error("Local agent subscriptions require the Forge desktop app.")
    )
  },
  cancelLocalRuntimeRun() {
    return Promise.resolve()
  },
  resolveLocalRuntimeApproval() {
    return Promise.reject(
      new Error("Local agent subscriptions require the Forge desktop app.")
    )
  },
  resolveLocalRuntimeToolCall() {
    return Promise.reject(
      new Error("Local agent subscriptions require the Forge desktop app.")
    )
  },
  subscribe() {
    return () => {}
  },
}

export function createForgeHost(bridge?: ForgeDesktopBridge): ForgeHost {
  if (!bridge) {
    return browserHost
  }

  return {
    ...bridge,
    setThemeSource:
      typeof bridge.setThemeSource === "function"
        ? bridge.setThemeSource
        : browserHost.setThemeSource,
    listLocalRuntimes:
      typeof bridge.listLocalRuntimes === "function"
        ? bridge.listLocalRuntimes
        : browserHost.listLocalRuntimes,
    startLocalRuntimeLogin:
      typeof bridge.startLocalRuntimeLogin === "function"
        ? bridge.startLocalRuntimeLogin
        : browserHost.startLocalRuntimeLogin,
    startLocalRuntimeRun:
      typeof bridge.startLocalRuntimeRun === "function"
        ? bridge.startLocalRuntimeRun
        : browserHost.startLocalRuntimeRun,
    cancelLocalRuntimeRun:
      typeof bridge.cancelLocalRuntimeRun === "function"
        ? bridge.cancelLocalRuntimeRun
        : browserHost.cancelLocalRuntimeRun,
    resolveLocalRuntimeApproval:
      typeof bridge.resolveLocalRuntimeApproval === "function"
        ? bridge.resolveLocalRuntimeApproval
        : browserHost.resolveLocalRuntimeApproval,
    resolveLocalRuntimeToolCall:
      typeof bridge.resolveLocalRuntimeToolCall === "function"
        ? bridge.resolveLocalRuntimeToolCall
        : browserHost.resolveLocalRuntimeToolCall,
  }
}

export function getForgeHost(): ForgeHost {
  return createForgeHost(
    typeof window === "undefined" ? undefined : window.forgeDesktop
  )
}

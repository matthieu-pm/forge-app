import * as React from "react"
import { ProductStateProvider } from "./product-state-provider"
import type {
  WorkspaceViewKind,
  WorkspaceViewValues,
} from "@/lib/workspace-preference-contract"
import type { AccountPreferenceGroups } from "@/lib/account-preference-contract"
import {
  protectedSessionEpoch,
  resetProtectedRoutes,
  retireProtectedSession,
} from "@/lib/protected-session"
import { productStorage, resetProductStorage } from "@/lib/product-storage"
import {
  decodeWorkspaceView,
  workspaceViewPrefix,
} from "@/lib/workspace-preference-contract"
import { getAuthState } from "@/lib/auth-state"
import { AccountPreferenceClient } from "@/lib/account-preference-client"
import {
  loadAccountPreferences,
  saveAccountPreferences,
} from "@/lib/account-preference-state"
import {
  accountPreferenceDefaults,
  flattenPreferences,
} from "@/lib/account-preference-contract"
import { onPreferenceSessionInvalidated } from "@/lib/preference-session-events"
import { Button } from "@/components/ui/button"

type ProtectedIdentity = {
  userId: string
  sessionId: string
  workspaceId: string | null
}
const ProtectedIdentityContext = React.createContext<ProtectedIdentity | null>(
  null
)
export const useProtectedIdentity = () =>
  React.useContext(ProtectedIdentityContext)
const WorkspaceContext = React.createContext<AccountPreferenceClient | null>(
  null
)
const Context = React.createContext<AccountPreferenceClient | null>(null)
export function AccountPreferenceProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [identity, setIdentity] = React.useState<ProtectedIdentity | null>(null)
  const active = React.useRef<Array<AccountPreferenceClient>>([])
  React.useEffect(() => {
    let epoch = 0,
      mounted = true
    let verified: ProtectedIdentity | null = null
    let transitioning = false
    async function verify() {
      if (transitioning) return
      const token = ++epoch
      try {
        const state = await getAuthState()
        if (!mounted || epoch !== token) return
        const workspaceId = state.workspace?.id
        const next =
          state.user && state.session
            ? {
                userId: state.user.id,
                sessionId: state.session.id,
                workspaceId: workspaceId ?? null,
              }
            : null
        if (JSON.stringify(verified) !== JSON.stringify(next)) {
          retireProtectedSession()
          resetProductStorage()
          setIdentity(null)
          const scopeEpoch = protectedSessionEpoch()
          await resetProtectedRoutes()
          if (
            !mounted ||
            epoch !== token ||
            scopeEpoch !== protectedSessionEpoch()
          )
            return
          verified = next
        }
        setIdentity((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next
        )
      } catch {
        /* Offline refresh preserves the current account's unsaved work. */
      }
    }
    const unsubscribe = onPreferenceSessionInvalidated((phase) => {
      ++epoch
      transitioning = phase === "start"
      verified = null
      resetProductStorage()
      for (const client of active.current) client.dispose()
      setIdentity(null)
      if (phase === "settled") void verify()
    })
    const focus = () => {
      void verify()
    }
    const interval = window.setInterval(focus, 30_000)
    window.addEventListener("focus", focus)
    window.addEventListener("online", focus)
    void verify()
    return () => {
      mounted = false
      ++epoch
      unsubscribe()
      window.clearInterval(interval)
      window.removeEventListener("focus", focus)
      window.removeEventListener("online", focus)
    }
  }, [])
  if (!identity || !identity.workspaceId)
    return (
      <Context.Provider value={null}>
        <WorkspaceContext.Provider value={null}>
          <ProtectedIdentityContext.Provider value={identity}>
            {children}
          </ProtectedIdentityContext.Provider>
        </WorkspaceContext.Provider>
      </Context.Provider>
    )
  const workspaceIdentity = { ...identity, workspaceId: identity.workspaceId }
  return (
    <ProductStateProvider
      key={JSON.stringify(identity)}
      identity={workspaceIdentity}
    >
      <PreferenceSessionScope
        key={JSON.stringify(identity)}
        identity={workspaceIdentity}
        active={active}
      >
        <ProtectedIdentityContext.Provider value={identity}>
          {children}
        </ProtectedIdentityContext.Provider>
      </PreferenceSessionScope>
    </ProductStateProvider>
  )
}

function PreferenceSessionScope({
  identity,
  active,
  children,
}: {
  identity: { userId: string; sessionId: string; workspaceId: string }
  active: React.RefObject<Array<AccountPreferenceClient>>
  children: React.ReactNode
}) {
  const [[client, workspaceClient]] = React.useState(() =>
    (["account", "workspace"] as const).map(
      (scope) =>
        new AccountPreferenceClient(
          { ...identity, scope },
          {
            load: () => loadAccountPreferences({ data: { scope } }),
            save: (command) => saveAccountPreferences({ data: command }),
          },
          typeof window === "undefined"
            ? undefined
            : {
                getItem: (key) => productStorage.getItem(key),
                setItem: (key, value) => productStorage.setItem(key, value),
              }
        )
    )
  )
  React.useEffect(() => {
    active.current = [client, workspaceClient]
    for (const entry of active.current) {
      entry.activate()
      void entry.refresh()
    }
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void client.refresh()
        void workspaceClient.refresh()
      }
    }
    const online = () => {
      void client.retry()
      void workspaceClient.retry()
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        client.getSnapshot().pending ||
        workspaceClient.getSnapshot().pending
      ) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    window.addEventListener("beforeunload", beforeUnload)
    const interval = window.setInterval(refresh, 30_000)
    window.addEventListener("focus", refresh)
    window.addEventListener("online", online)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener("beforeunload", beforeUnload)
      window.removeEventListener("focus", refresh)
      window.removeEventListener("online", online)
      document.removeEventListener("visibilitychange", refresh)
      client.dispose()
      workspaceClient.dispose()
      active.current = []
    }
  }, [client, workspaceClient, active])
  return (
    <AccountPreferenceScope client={client} workspaceClient={workspaceClient}>
      {children}
    </AccountPreferenceScope>
  )
}
export function AccountPreferenceScope({
  client,
  children,
  workspaceClient,
}: {
  client: AccountPreferenceClient
  workspaceClient?: AccountPreferenceClient
  children: React.ReactNode
}) {
  return (
    <Context.Provider value={client}>
      <WorkspaceContext.Provider value={workspaceClient ?? null}>
        {children}
      </WorkspaceContext.Provider>
    </Context.Provider>
  )
}
const unavailable = {
  status: "loading" as const,
  values: {},
  groups: accountPreferenceDefaults,
  message: "Loading your preferences…",
  pending: false,
  conflicts: [],
}
const noopSubscribe = () => () => {}
export function useAccountPreferences(
  scope: "account" | "workspace" = "account"
) {
  const accountClient = React.useContext(Context),
    workspaceClient = React.useContext(WorkspaceContext)
  const client = scope === "workspace" ? workspaceClient : accountClient
  const state = React.useSyncExternalStore(
    client?.subscribe ?? noopSubscribe,
    client?.getSnapshot ?? (() => unavailable),
    () => unavailable
  )
  return {
    ...state,
    client,
    editable: !!client && ["ready", "saving"].includes(state.status),
  }
}
export function usePreferenceGroup<
  TGroup extends keyof AccountPreferenceGroups,
>(group: TGroup, userId?: string) {
  const sync = useAccountPreferences()
  const matches = !userId || sync.client?.identity.userId === userId
  const preferences = matches
    ? sync.groups[group]
    : accountPreferenceDefaults[group]
  function update(next: AccountPreferenceGroups[TGroup]) {
    if (!sync.client || !matches) throw new Error("Preference session changed.")
    const before = flattenPreferences(preferences, group),
      after = flattenPreferences(next, group)
    const patch = Object.fromEntries(
      Object.entries(after).filter(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])
      )
    )
    if (Object.keys(patch).length) sync.client.edit(patch)
  }
  return { ...sync, preferences, update, editable: matches && sync.editable }
}
export function PreferenceSyncStatus({
  scope = "account",
  compact = false,
}: { scope?: "account" | "workspace"; compact?: boolean } = {}) {
  const { status, message, client } = useAccountPreferences(scope)
  if (
    compact &&
    (status === "ready" ||
      status === "loading" ||
      (scope === "workspace" && status === "disabled"))
  )
    return null
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 px-4 text-xs text-muted-foreground">
      <p
        role={status === "error" || status === "conflict" ? "alert" : "status"}
      >
        {message}
      </p>
      {status === "error" && (
        <Button size="sm" variant="ghost" onClick={() => void client?.retry()}>
          Retry preferences
        </Button>
      )}
      {status === "conflict" && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void client?.reviewSaved()}
        >
          Discard changes and load saved
        </Button>
      )}
    </div>
  )
}

export function useWorkspaceView<TKind extends WorkspaceViewKind>(
  kind: TKind,
  resource = "main",
  guard?: { userId?: string; workspaceId?: string }
) {
  const sync = useAccountPreferences("workspace")
  const matches =
    (!guard?.userId || sync.client?.identity.userId === guard.userId) &&
    (!guard?.workspaceId ||
      sync.client?.identity.workspaceId === guard.workspaceId)
  const value = React.useMemo(
    () => decodeWorkspaceView(kind, resource, matches ? sync.values : {}),
    [kind, resource, matches, sync.values]
  )
  function save(next: WorkspaceViewValues<TKind>) {
    if (!sync.client || !matches || !sync.editable) return false
    const prefix = workspaceViewPrefix(kind, resource),
      before = flattenPreferences(value, prefix),
      after = flattenPreferences(next, prefix)
    const patch = Object.fromEntries(
      Object.entries(after).filter(
        ([key, item]) => JSON.stringify(item) !== JSON.stringify(before[key])
      )
    )
    try {
      if (Object.keys(patch).length) sync.client.edit(patch)
      return true
    } catch {
      return false
    }
  }
  return {
    ...sync,
    value,
    save,
    error:
      matches && ["ready", "saving", "loading"].includes(sync.status)
        ? ""
        : sync.message,
  }
}

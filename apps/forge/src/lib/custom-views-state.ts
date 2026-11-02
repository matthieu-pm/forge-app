import { useEffect, useSyncExternalStore } from "react"
import { savedViewMutationSchema, viewDefinition } from "./saved-view-contract"
import { loadSavedViews, persistSavedView } from "./saved-view-functions"
import {
  CANONICAL_ISSUES_CHANGED,
  canonicalIssueReadGeneration,
  canonicalIssueState,
} from "./canonical-issue-cache"
import { protectedSessionEpoch } from "./protected-session"
import { onPreferenceSessionInvalidated } from "./preference-session-events"
import type { SavedViewDirectory } from "./saved-view-contract"
import type { CustomView } from "./custom-views"
import type { WorkspaceViewValues } from "./workspace-preference-contract"
import { useWorkspaceView } from "@/components/account-preference-provider"

type Entry = {
  data?: SavedViewDirectory
  error: string
  loading: boolean
  busy: boolean
  generation: number
  accessGeneration: number
  retry?: { input: string; key: string }
}
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let version = 0
function notify() {
  version++
  for (const fn of listeners) fn()
}
function clear() {
  entries.clear()
  notify()
}
if (typeof window !== "undefined") onPreferenceSessionInvalidated(clear)
function subscribe(fn: () => void) {
  listeners.add(fn)
  window.addEventListener(CANONICAL_ISSUES_CHANGED, fn)
  window.addEventListener("forge:issue-queries-invalidated", fn)
  return () => {
    listeners.delete(fn)
    window.removeEventListener(CANONICAL_ISSUES_CHANGED, fn)
    window.removeEventListener("forge:issue-queries-invalidated", fn)
  }
}
function identityKey() {
  const i = canonicalIssueState()
  return i
    ? `${i.workspaceId}:${i.userId}:${i.sessionId}:${protectedSessionEpoch()}`
    : ""
}
async function refresh(key: string, entry: Entry) {
  const identity = canonicalIssueState()
  if (!identity || identityKey() !== key) return
  const accessGeneration = canonicalIssueReadGeneration()
  // Canonical access changes retire both the protected projection and reads
  // started before it. Ordinary issue notifications do not advance this fence.
  if (entry.accessGeneration !== accessGeneration) entry.data = undefined
  entry.accessGeneration = accessGeneration
  const token = ++entry.generation
  entry.loading = true
  notify()
  try {
    const data = JSON.parse(
      await loadSavedViews({
        data: {
          workspaceId: identity.workspaceId,
          sessionId: identity.sessionId,
        },
      })
    ) as SavedViewDirectory
    if (
      entries.get(key) !== entry ||
      identityKey() !== key ||
      token !== entry.generation ||
      accessGeneration !== canonicalIssueReadGeneration()
    )
      return
    if (
      `${data.workspaceId}:${data.userId}:${data.sessionId}:${protectedSessionEpoch()}` !==
      key
    )
      throw new Error("Session changed")
    entry.data = data
    entry.error = ""
  } catch {
    if (entries.get(key) !== entry || token !== entry.generation) return
    entry.data = undefined
    entry.error = "Saved views could not be loaded. Refresh to try again."
  } finally {
    if (entries.get(key) === entry && token === entry.generation) {
      entry.loading = false
      notify()
    }
  }
}
export function useCustomViews(workspaceId: string, userId: string) {
  useSyncExternalStore(
    subscribe,
    () => `${version}:${identityKey()}:${canonicalIssueReadGeneration()}`,
    () => ""
  )
  const identity = canonicalIssueState()
  const key =
    identity?.workspaceId === workspaceId && identity.userId === userId
      ? identityKey()
      : ""
  const entry = entries.get(key)
  const accessGeneration = canonicalIssueReadGeneration()
  const data =
    entry?.accessGeneration === accessGeneration ? entry.data : undefined
  useEffect(() => {
    if (!key) return
    let current = entries.get(key)
    if (!current) {
      current = {
        error: "",
        loading: false,
        busy: false,
        generation: 0,
        accessGeneration,
      }
      entries.set(key, current)
      void refresh(key, current)
    } else if (current.accessGeneration !== accessGeneration && !current.busy) {
      void refresh(key, current)
    }
    const active = current
    const reload = () => {
      if (!active.busy && !active.loading) void refresh(key, active)
    }
    const timer = window.setInterval(reload, 30_000)
    window.addEventListener("focus", reload)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", reload)
    }
  }, [key, Boolean(entry), accessGeneration, entry?.busy])
  async function mutate(raw: unknown) {
    if (
      !entry?.data?.enabled ||
      entry.accessGeneration !== canonicalIssueReadGeneration() ||
      entry.busy ||
      !identity ||
      identityKey() !== key
    )
      return false
    try {
      const mutation = savedViewMutationSchema.parse(raw)
      const input = JSON.stringify(mutation)
      const commandKey =
        entry.retry?.input === input ? entry.retry.key : crypto.randomUUID()
      entry.retry = { input, key: commandKey }
      entry.busy = true
      entry.loading = false
      ++entry.generation
      notify()
      await persistSavedView({
        data: {
          workspaceId,
          sessionId: identity.sessionId,
          commandKey,
          mutation,
        },
      })
      if (entries.get(key) !== entry || identityKey() !== key) return false
      entry.retry = undefined
      await refresh(key, entry)
      return entries.get(key) === entry && identityKey() === key
    } catch (error) {
      if (entries.get(key) === entry)
        entry.error =
          error instanceof Error
            ? error.message
            : "The view could not be saved. Your draft is kept."
      return false
    } finally {
      if (entries.get(key) === entry) {
        entry.busy = false
        notify()
      }
    }
  }
  return {
    views: data?.views ?? [],
    enabled: data?.enabled ?? false,
    loading: Boolean(
      key &&
      (!entry || entry.loading || entry.accessGeneration !== accessGeneration)
    ),
    busy: entry?.busy ?? false,
    error: entry?.error || data?.error || "",
    refresh: () => entry && refresh(key, entry),
    save: (view: CustomView) => {
      try {
        return mutate({
          action: "save",
          id: view.id,
          expectedRevision:
            (view as CustomView & { revision?: number }).revision ?? null,
          definition: viewDefinition(view),
        })
      } catch {
        return Promise.resolve(false)
      }
    },
    remove: (id: string) =>
      mutate({
        action: "delete",
        id,
        expectedRevision: entry?.data?.views.find((v) => v.id === id)?.revision,
      }),
    favorite: (id: string, favorite: boolean) =>
      mutate({ action: "favorite", id, favorite }),
  }
}

export type CustomViewDirectoryPreferences = Omit<
  WorkspaceViewValues<"directory">,
  "favoriteIds"
>
export function useCustomViewDirectoryPreferences(
  workspaceId: string,
  userId: string
) {
  const sync = useWorkspaceView("directory", "main", { workspaceId, userId })
  return {
    ...sync.value,
    error: sync.error,
    save: (next: CustomViewDirectoryPreferences) =>
      sync.save({ ...sync.value, ...next }),
  }
}

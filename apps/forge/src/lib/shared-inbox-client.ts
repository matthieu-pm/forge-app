import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { z } from "zod"
import {
  CANONICAL_ISSUES_CHANGED,
  canonicalIssueEpoch,
  canonicalIssueRemovalEpoch,
  canonicalIssueState,
  canonicalIssuesActive,
  isCanonicalIssueSuppressed,
} from "./canonical-issue-cache"
import { sharedInboxPageSchema } from "./shared-inbox-contract"
import { loadSharedInbox } from "./shared-inbox-functions"
import { defaultInboxPreferences } from "./inbox-view"
import { onPreferenceSessionInvalidated } from "./preference-session-events"
import { protectedSessionEpoch } from "./protected-session"
import type { SharedInboxPage } from "./shared-inbox-contract"
import type {
  InboxAction,
  InboxEntry,
  InboxScope,
  InboxState,
} from "./inbox-state"

const localChanged = "forge:inbox-local-state-changed"
const identityChanged = "forge:inbox-identity-changed"
let suspended = false
onPreferenceSessionInvalidated((phase) => {
  suspended = phase === "start"
  window.dispatchEvent(new Event(identityChanged))
})
const metadataSchema = z.record(
  z.string(),
  z.object({
    readThrough: z.string().optional(),
    deletedThrough: z.string().optional(),
    snoozedUntil: z.number().nullable().optional(),
  })
)
function identitySnapshot() {
  const state = canonicalIssueState()
  return JSON.stringify([
    canonicalIssuesActive(),
    state?.workspaceId,
    state?.userId,
    state?.sessionId,
    canonicalIssueEpoch(),
    canonicalIssueRemovalEpoch(),
    protectedSessionEpoch(),
    suspended,
  ])
}
function subscribeIdentity(notify: () => void) {
  window.addEventListener(CANONICAL_ISSUES_CHANGED, notify)
  window.addEventListener(identityChanged, notify)
  return () => {
    window.removeEventListener(CANONICAL_ISSUES_CHANGED, notify)
    window.removeEventListener(identityChanged, notify)
  }
}
const stamp = (entry: {
  events: InboxEntry["events"]
  deliveryRevision?: string
}) => {
  if (entry.deliveryRevision) return entry.deliveryRevision
  const latest = entry.events.at(-1)
  return latest ? `${latest.createdAt}:${latest.id}:${latest.kind}` : ""
}
const emptyState: InboxState = {
  entries: [],
  unsubscribedIssueIds: [],
  preferences: defaultInboxPreferences,
}

export function useSharedInbox(scope: InboxScope) {
  const identityKey = useSyncExternalStore(
    subscribeIdentity,
    identitySnapshot,
    () => ""
  )
  const identity = canonicalIssueState()
  const active = canonicalIssuesActive()
  const matches =
    !suspended &&
    active &&
    identity?.workspaceId === scope.workspaceId &&
    identity.userId === scope.userId
  const key = `forge:inbox-local-state:v1:${JSON.stringify([scope.workspaceId, scope.userId])}`
  const raw = useSyncExternalStore(
    (notify) => {
      window.addEventListener("storage", notify)
      window.addEventListener(localChanged, notify)
      return () => {
        window.removeEventListener("storage", notify)
        window.removeEventListener(localChanged, notify)
      }
    },
    () => {
      try {
        return window.localStorage.getItem(key) ?? "{}"
      } catch {
        return "unavailable"
      }
    },
    () => "{}"
  )
  const [loaded, setLoaded] = useState<{
    key: string
    page?: SharedInboxPage
    error?: string
  }>({ key: "" })
  const [actionError, setActionError] = useState<string | null>(null)
  const refreshRef = useRef<(() => void) | undefined>(undefined)
  const pages = useRef(1)
  useEffect(() => {
    pages.current = 1
    if (!matches) return
    const expected = identityKey
    let disposed = false,
      running = false
    const refresh = async () => {
      if (running) return
      running = true
      try {
        let cursor: string | undefined
        let result: SharedInboxPage | undefined
        const groups = new Map<string, SharedInboxPage["entries"][number]>()
        for (let i = 0; i < pages.current; i++) {
          const page = sharedInboxPageSchema.parse(
            await loadSharedInbox({
              data: {
                workspaceId: scope.workspaceId,
                sessionId: identity.sessionId,
                ...(cursor ? { cursor } : {}),
              },
            })
          )
          if (
            page.workspaceId !== scope.workspaceId ||
            page.userId !== scope.userId ||
            page.sessionId !== identity.sessionId
          )
            throw new Error("Identity mismatch")
          for (const entry of page.entries) {
            const previous = groups.get(entry.id)
            groups.set(
              entry.id,
              previous
                ? {
                    ...previous,
                    issue:
                      entry.issue.revision >= previous.issue.revision
                        ? entry.issue
                        : previous.issue,
                    deliveryRevision:
                      BigInt(entry.deliveryRevision) >
                      BigInt(previous.deliveryRevision)
                        ? entry.deliveryRevision
                        : previous.deliveryRevision,
                    events: [
                      ...new Map(
                        [...previous.events, ...entry.events].map((e) => [
                          e.id,
                          e,
                        ])
                      ).values(),
                    ].sort(
                      (a, b) =>
                        a.createdAt.localeCompare(b.createdAt) ||
                        a.id.localeCompare(b.id)
                    ),
                  }
                : entry
            )
          }
          result = { ...page, entries: [...groups.values()] }
          if (!page.nextCursor) break
          cursor = page.nextCursor
        }
        if (!disposed && identitySnapshot() === expected)
          setLoaded({ key: expected, page: result })
      } catch {
        if (!disposed && identitySnapshot() === expected)
          setLoaded({
            key: expected,
            error: "Your inbox could not be loaded. Try refreshing.",
          })
      } finally {
        running = false
      }
    }
    const refreshNow = () => {
      void refresh()
    }
    refreshRef.current = refreshNow
    refreshNow()
    const interval = window.setInterval(refreshNow, 10_000)
    window.addEventListener("focus", refreshNow)
    return () => {
      disposed = true
      clearInterval(interval)
      window.removeEventListener("focus", refreshNow)
      refreshRef.current = undefined
    }
  }, [identityKey, matches, scope.workspaceId, scope.userId])

  let metadata: z.infer<typeof metadataSchema> = {}
  let metadataError: string | null = null
  try {
    metadata = metadataSchema.parse(JSON.parse(raw))
  } catch {
    metadataError =
      "Your inbox actions could not be loaded. Saved data has been preserved."
  }
  const page = matches && loaded.key === identityKey ? loaded.page : undefined
  const entries: Array<InboxEntry> = (page?.entries ?? [])
    .filter((entry) => !isCanonicalIssueSuppressed(entry.issue.id))
    .map((entry) => {
      const local = metadata[entry.id] as
        z.infer<typeof metadataSchema>[string] | undefined
      return {
        ...entry,
        unread: local?.readThrough !== stamp(entry),
        deleted: local?.deletedThrough === stamp(entry),
        snoozedUntil: local?.snoozedUntil ?? null,
      }
    })
  const dispatch = (action: InboxAction) => {
    if (!page || metadataError) return
    const next = { ...metadata }
    for (const entry of entries) {
      const local = { ...next[entry.id] }
      if (action.type === "read" && action.ids.includes(entry.id))
        local.readThrough = action.unread ? undefined : stamp(entry)
      if (action.type === "delete-many" && action.ids.includes(entry.id))
        local.deletedThrough = stamp(entry)
      if (action.type === "delete" && action.id === entry.id)
        local.deletedThrough = action.deleted ? stamp(entry) : undefined
      if (action.type === "snooze" && action.id === entry.id) {
        local.snoozedUntil = action.until
        if (action.until !== null) local.readThrough = undefined
      }
      next[entry.id] = local
    }
    try {
      window.localStorage.setItem(key, JSON.stringify(next))
      setActionError(null)
      window.dispatchEvent(new Event(localChanged))
    } catch {
      setActionError("Your inbox action could not be saved. Try again.")
      throw new Error("Your inbox action could not be saved.")
    }
  }
  return {
    active,
    state: page && !metadataError ? { ...emptyState, entries } : emptyState,
    error:
      metadataError ??
      actionError ??
      (matches && loaded.key === identityKey ? (loaded.error ?? null) : null),
    loading: matches && loaded.key !== identityKey,
    hasMore: !!page?.nextCursor,
    loadMore: () => {
      pages.current++
      refreshRef.current?.()
    },
    refresh: () => refreshRef.current?.(),
    dispatch,
  }
}

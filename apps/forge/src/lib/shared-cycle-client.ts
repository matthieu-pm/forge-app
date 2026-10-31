import * as React from "react"
import { loadSharedTeamCycles } from "./cycle-state"
import { persistProductState } from "./product-state-server"
import {
  CANONICAL_ISSUES_CHANGED,
  canonicalIssueEpoch,
  canonicalIssueState,
} from "./canonical-issue-cache"
import { onPreferenceSessionInvalidated } from "./preference-session-events"
import { cyclesSchema, teamCyclesStorageKey } from "./team-cycles-contract"
import type {
  SharedCycleSnapshot,
  TeamCyclesSettings,
} from "./team-cycles-contract"

const event = "forge:shared-cycles-changed"
type Entry = {
  teamId: string
  request: number
  snapshot?: SharedCycleSnapshot
  error?: string
  pending?: boolean
  loading?: Promise<void>
  intent?: {
    patch: Partial<TeamCyclesSettings>
    data: Parameters<typeof persistProductState>[0]["data"]
  }
}
const entries = new Map<string, Entry>()
const notify = () => window.dispatchEvent(new Event(event))
onPreferenceSessionInvalidated(() => {
  entries.clear()
  if (typeof window !== "undefined") notify()
})
export function sharedCyclesEnabled(teamId: string) {
  const identity = canonicalIssueState()
  for (const entry of entries.values())
    if (
      entry.snapshot &&
      entry.snapshot.workspaceId === identity?.workspaceId &&
      entry.snapshot.userId === identity?.userId &&
      entry.snapshot.sessionId === identity?.sessionId &&
      entry.teamId === teamId
    )
      return entry.snapshot.settings.enabled
  return undefined
}
export function useSharedTeamCycles(
  teamId: string,
  enabled: boolean,
  number?: number
) {
  const identity = canonicalIssueState()
  const key = identity
    ? JSON.stringify([
        identity.workspaceId,
        identity.userId,
        identity.sessionId,
        teamId,
        number,
      ])
    : ""
  const [, render] = React.useReducer((n) => n + 1, 0)
  if (key && !entries.has(key)) entries.set(key, { teamId, request: 0 })
  const entry = entries.get(key)
  const current = () =>
    entries.get(key) === entry &&
    canonicalIssueState()?.sessionId === identity?.sessionId &&
    canonicalIssueState()?.workspaceId === identity?.workspaceId
  async function refresh() {
    if (!enabled || !identity || !entry || entry.pending) return
    if (entry.loading) return entry.loading
    const epoch = canonicalIssueEpoch()
    const request = ++entry.request
    entry.loading = (async () => {
      try {
        const snapshot = await loadSharedTeamCycles({
          data: {
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
            teamId,
            number,
          },
        })
        if (
          !current() ||
          epoch !== canonicalIssueEpoch() ||
          entry.request !== request
        )
          return
        entry.snapshot = snapshot
        if (!entry.intent) entry.error = undefined
      } catch {
        if (current() && entry.request === request) {
          entry.snapshot = undefined
          entry.error =
            "Shared cycles could not be loaded. Reload or try again."
        }
      } finally {
        if (current() && entry.request === request) {
          entry.loading = undefined
          notify()
        }
      }
    })()
    return entry.loading
  }
  React.useEffect(() => {
    if (!enabled) return
    window.addEventListener(event, render)
    window.addEventListener(CANONICAL_ISSUES_CHANGED, render)
    const focus = () => {
      void refresh()
    }
    window.addEventListener("focus", focus)
    window.addEventListener("forge:team-issues-changed", focus)
    void refresh()
    const timer = window.setInterval(focus, 30_000)
    return () => {
      window.removeEventListener(event, render)
      window.removeEventListener(CANONICAL_ISSUES_CHANGED, render)
      window.removeEventListener("focus", focus)
      window.removeEventListener("forge:team-issues-changed", focus)
      window.clearInterval(timer)
    }
  }, [key, enabled])
  async function update(patch: Partial<TeamCyclesSettings>, retry = false) {
    if (
      !entry?.snapshot ||
      !identity ||
      entry.pending ||
      !entry.snapshot.canManage ||
      (entry.error && !retry)
    )
      return false
    const parsed = cyclesSchema.safeParse({
      ...entry.snapshot.settings,
      ...patch,
    })
    if (!parsed.success) {
      entry.error =
        "Choose valid cycle settings and an IANA timezone, such as Europe/Paris."
      notify()
      return false
    }
    const settings = parsed.data
    entry.intent ??= {
      patch,
      data: {
        workspaceId: identity.workspaceId,
        sessionId: identity.sessionId,
        key: teamCyclesStorageKey(teamId),
        value: JSON.stringify(settings),
        expectedRevision: entry.snapshot.revision,
        commandKey: crypto.randomUUID(),
      },
    }
    entry.request++
    entry.loading = undefined
    entry.pending = true
    const epoch = canonicalIssueEpoch()
    notify()
    try {
      await persistProductState({ data: entry.intent.data })
      if (!current() || epoch !== canonicalIssueEpoch()) return false
      entry.intent = undefined
      entry.error = undefined
      entry.pending = false
      await refresh()
      for (const [otherKey, other] of entries)
        if (
          otherKey !== key &&
          other.teamId === teamId &&
          other.snapshot?.sessionId === identity.sessionId &&
          other.snapshot.workspaceId === identity.workspaceId &&
          entry.snapshot
        ) {
          other.snapshot = {
            ...entry.snapshot,
            cycles: [
              ...new Map(
                [...other.snapshot.cycles, ...entry.snapshot.cycles].map(
                  (c) => [c.id, c]
                )
              ).values(),
            ],
          }
        }
      notify()
      window.dispatchEvent(new Event("forge:team-cycles-changed"))
      return true
    } catch (error) {
      if (!current() || epoch !== canonicalIssueEpoch()) return false
      const conflict =
        error instanceof Error && error.message.startsWith("This data changed")
      entry.pending = false
      await refresh()
      if (conflict && entry.snapshot && entry.intent) {
        entry.intent.data = {
          ...entry.intent.data,
          expectedRevision: entry.snapshot.revision,
          commandKey: crypto.randomUUID(),
          value: JSON.stringify({
            ...entry.snapshot.settings,
            ...entry.intent.patch,
          }),
        }
      }
      entry.error = conflict
        ? "Cycle settings changed in another session. Review the latest values, then retry your saved change or discard it."
        : "Your cycle settings could not be confirmed. Retry the saved change or reload."
      notify()
      return false
    } finally {
      if (current()) {
        entry.pending = false
        notify()
      }
    }
  }
  return {
    snapshot: entry?.snapshot,
    error: entry?.error ?? null,
    pending: !!entry?.pending,
    update,
    retry: async () => {
      if (entry?.intent) return update(entry.intent.patch, true)
      await refresh()
      return !!entry?.snapshot
    },
    discard: () => {
      if (entry) {
        entry.intent = undefined
        entry.error = undefined
        notify()
        void refresh()
      }
    },
    refresh,
  }
}

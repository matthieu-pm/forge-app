import * as React from "react"
import {
  emptyTeamResources,
  teamResourceCommandSchema,
} from "./team-resources-contract"
import { loadTeamResources, persistTeamResources } from "./team-resources-state"
import {
  recoveredTeamResources,
  retainTeamResources,
  retireTeamResources,
} from "./team-resources-journal"
import { productStorageIdentity } from "./product-storage"
import { protectedSessionEpoch } from "./protected-session"
import { onPreferenceSessionInvalidated } from "./preference-session-events"
import type { PendingTeamResources } from "./team-resources-journal"
import type {
  TeamResourceFields,
  TeamResourcesResult,
  TeamResourcesSnapshot,
} from "./team-resources-contract"

const CHANGED = "forge:team-resources-changed"
export function useTeamResources(teamId: string) {
  const identity = productStorageIdentity()
  const queryKey = JSON.stringify([
    teamId,
    identity?.workspaceId,
    identity?.userId,
    identity?.sessionId,
  ])
  const [snapshot, setSnapshot] = React.useState(emptyTeamResources)
  const [ready, setReady] = React.useState(false),
    [error, setError] = React.useState("")
  const [pending, setPending] = React.useState<PendingTeamResources | null>(
    null
  )
  const [conflict, setConflict] = React.useState(false),
    [saving, setSaving] = React.useState(false)
  const generation = React.useRef(0),
    active = React.useRef(queryKey),
    busy = React.useRef(false)
  const [resolved, setResolved] = React.useState("")
  active.current = queryKey
  const refresh = React.useCallback(async () => {
    const binding = productStorageIdentity(),
      epoch = protectedSessionEpoch(),
      token = ++generation.current
    if (!binding) return
    const current = () =>
      token === generation.current &&
      active.current === queryKey &&
      protectedSessionEpoch() === epoch &&
      productStorageIdentity()?.workspaceId === binding.workspaceId &&
      productStorageIdentity()?.userId === binding.userId &&
      productStorageIdentity()?.sessionId === binding.sessionId
    try {
      const next = JSON.parse(
        await loadTeamResources({ data: { ...binding, teamId } })
      ) as TeamResourcesSnapshot
      if (!current()) return
      setSnapshot(next)
      setResolved(queryKey)
      setReady(true)
      setError("")
      try {
        setPending(recoveredTeamResources(binding, teamId))
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "The resource recovery record could not be loaded."
        )
      }
    } catch (e) {
      if (!current()) return
      setSnapshot(emptyTeamResources())
      setResolved(queryKey)
      setReady(true)
      setPending(null)
      setError(
        e instanceof Error ? e.message : "Team resources could not be loaded."
      )
    }
  }, [teamId, queryKey])
  React.useEffect(() => {
    setReady(false)
    setPending(null)
    setConflict(false)
    void refresh()
    const reload = () => {
      if (!busy.current) void refresh()
    }
    const off = onPreferenceSessionInvalidated(() => {
      generation.current++
      setReady(false)
      setSnapshot(emptyTeamResources())
      setPending(null)
      setConflict(false)
    })
    window.addEventListener("focus", reload)
    window.addEventListener(CHANGED, reload)
    const timer = window.setInterval(reload, 15000)
    return () => {
      generation.current++
      off()
      clearInterval(timer)
      window.removeEventListener("focus", reload)
      window.removeEventListener(CHANGED, reload)
    }
  }, [refresh])
  async function send(request: PendingTeamResources) {
    const binding = productStorageIdentity(),
      epoch = protectedSessionEpoch()
    if (!binding || busy.current || active.current !== queryKey)
      throw new Error("Reload to verify your session.")
    const current = () =>
      active.current === queryKey &&
      protectedSessionEpoch() === epoch &&
      productStorageIdentity()?.workspaceId === binding.workspaceId &&
      productStorageIdentity()?.userId === binding.userId &&
      productStorageIdentity()?.sessionId === binding.sessionId
    retainTeamResources(binding, request)
    setPending(request)
    setSaving(true)
    busy.current = true
    try {
      const result = JSON.parse(
        await persistTeamResources({
          data: {
            ...binding,
            commandKey: request.key,
            command: request.command,
          },
        })
      ) as TeamResourcesResult
      if (!current()) throw new Error("The active session changed.")
      if (result.status === "conflict") {
        setSnapshot(result.current)
        setConflict(true)
        return false
      }
      retireTeamResources(binding, request)
      setPending(null)
      setConflict(false)
      await refresh()
      if (!current()) throw new Error("The active session changed.")
      window.dispatchEvent(new Event(CHANGED))
      return true
    } finally {
      busy.current = false
      setSaving(false)
    }
  }
  async function save(fields: TeamResourceFields) {
    if (!ready || error || pending || busy.current)
      throw new Error(
        "Resolve the pending resource request before making another change."
      )
    return send({
      key: crypto.randomUUID(),
      command: teamResourceCommandSchema.parse({
        teamId,
        expectedRevision: snapshot.revision,
        fields,
      }),
    })
  }
  function reviewConflict() {
    const binding = productStorageIdentity()
    if (!binding || !pending || !conflict) return
    retireTeamResources(binding, pending)
    setPending(null)
    setConflict(false)
  }
  return {
    snapshot: resolved === queryKey ? snapshot : emptyTeamResources(),
    ready: resolved === queryKey && ready,
    error: resolved === queryKey ? error : "",
    saving,
    pending: resolved === queryKey ? pending : null,
    conflict,
    save,
    retry: () => (pending ? send(pending) : Promise.resolve(false)),
    reviewConflict,
    refresh,
  }
}
export type TeamResourcesStore = ReturnType<typeof useTeamResources>

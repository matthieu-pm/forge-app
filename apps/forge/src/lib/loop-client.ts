import * as React from "react"
import { z } from "zod"
import { loopCommandSchema } from "./loop-contract"
import { loadTeamLoops, persistTeamLoop } from "./loop-state"
import { productStorageIdentity } from "./product-storage"
import { protectedSessionEpoch } from "./protected-session"
import { onPreferenceSessionInvalidated } from "./preference-session-events"
import type {
  LoopCommand,
  LoopCommandResult,
  LoopSnapshot,
} from "./loop-contract"

const changed = "forge:loops-changed"
const pendingSchema = z
  .object({ key: z.uuid(), command: loopCommandSchema })
  .strict()
export type PendingLoopCommand = z.infer<typeof pendingSchema>
function prefix(
  owner: { workspaceId: string; userId: string },
  teamId: string
) {
  return (
    JSON.stringify([
      "forge.loop-command",
      1,
      owner.workspaceId,
      owner.userId,
      teamId,
    ]).slice(0, -1) + ","
  )
}
function recordKey(
  owner: { workspaceId: string; userId: string },
  teamId: string,
  key: string
) {
  return prefix(owner, teamId) + JSON.stringify(key) + "]"
}
function pendingCommands(
  owner: { workspaceId: string; userId: string },
  teamId: string
) {
  return Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index)
  )
    .filter((key): key is string =>
      Boolean(key?.startsWith(prefix(owner, teamId)))
    )
    .sort()
    .map((key) => {
      const value = pendingSchema.parse(
        JSON.parse(localStorage.getItem(key) ?? "null")
      )
      if (key !== recordKey(owner, teamId, value.key))
        throw new Error(
          "The pending request could not be verified. Its original is preserved."
        )
      return value
    })
}
export function useTeamLoops(teamId: string) {
  const [snapshot, setSnapshot] = React.useState<LoopSnapshot | null>(null)
  const [resolvedTeam, setResolvedTeam] = React.useState("")
  const [error, setError] = React.useState("")
  const [ready, setReady] = React.useState(false)
  const [pending, setPending] = React.useState<Array<PendingLoopCommand>>([])
  const generation = React.useRef(0),
    activeTeam = React.useRef(teamId)
  activeTeam.current = teamId
  const refresh = React.useCallback(async () => {
    const binding = productStorageIdentity(),
      epoch = protectedSessionEpoch(),
      token = ++generation.current
    const current = () =>
      token === generation.current &&
      epoch === protectedSessionEpoch() &&
      activeTeam.current === teamId &&
      productStorageIdentity()?.workspaceId === binding?.workspaceId &&
      productStorageIdentity()?.userId === binding?.userId &&
      productStorageIdentity()?.sessionId === binding?.sessionId
    if (!binding) {
      setSnapshot(null)
      setPending([])
      setReady(false)
      return true
    }
    try {
      const result = JSON.parse(
        await loadTeamLoops({ data: { ...binding, teamId } })
      ) as LoopSnapshot
      if (!current()) return false
      setResolvedTeam(teamId)
      setSnapshot(result)
      setReady(true)
      setError("")
      try {
        setPending(pendingCommands(binding, teamId))
      } catch {
        setError(
          "A pending Loop request could not be loaded. Its recovery data is preserved."
        )
      }
      return true
    } catch (cause) {
      if (!current()) return false
      setResolvedTeam(teamId)
      setSnapshot(null)
      setPending([])
      setReady(true)
      setError(
        cause instanceof Error ? cause.message : "Loops could not be loaded."
      )
      return true
    }
  }, [teamId])
  React.useEffect(() => {
    void refresh()
    const reload = () => void refresh()
    const off = onPreferenceSessionInvalidated(() => {
      generation.current++
      setSnapshot(null)
      setPending([])
      setReady(false)
    })
    window.addEventListener("focus", reload)
    window.addEventListener(changed, reload)
    const timer = window.setInterval(reload, 15000)
    return () => {
      generation.current++
      off()
      clearInterval(timer)
      window.removeEventListener("focus", reload)
      window.removeEventListener(changed, reload)
    }
  }, [refresh])
  async function send(record: PendingLoopCommand): Promise<LoopCommandResult> {
    const binding = productStorageIdentity(),
      epoch = protectedSessionEpoch()
    if (!binding) throw new Error("Reload to verify your session.")
    const current = () =>
      epoch === protectedSessionEpoch() &&
      activeTeam.current === teamId &&
      productStorageIdentity()?.workspaceId === binding.workspaceId &&
      productStorageIdentity()?.userId === binding.userId &&
      productStorageIdentity()?.sessionId === binding.sessionId
    const key = recordKey(binding, teamId, record.key),
      encoded = JSON.stringify(record)
    if (localStorage.getItem(key) !== encoded)
      throw new Error("The pending request changed. Reload before retrying.")
    const result = JSON.parse(
      await persistTeamLoop({
        data: {
          ...binding,
          teamId,
          commandKey: record.key,
          command: record.command,
        },
      })
    ) as LoopCommandResult
    if (!current()) throw new Error("The active session changed.")
    if (localStorage.getItem(key) === encoded) localStorage.removeItem(key)
    setPending(pendingCommands(binding, teamId))
    // A command finishes only after a post-commit view has applied. Focus/poll
    // invalidations may supersede a read, so confirm the next one before exposing
    // actions that require the new revision. Broadcast after this confirmation.
    while (!(await refresh())) {
      if (!current()) throw new Error("The active session changed.")
    }
    if (!current()) throw new Error("The active session changed.")
    window.dispatchEvent(new Event(changed))
    return result
  }
  async function command(raw: LoopCommand) {
    const binding = productStorageIdentity()
    if (!binding || !snapshot || !ready || error)
      throw new Error("Verify current team access before changing Loops.")
    if (pendingCommands(binding, teamId).length)
      throw new Error(
        "Resolve the pending Loop request before making another change."
      )
    const record = pendingSchema.parse({
      key: crypto.randomUUID(),
      command: raw,
    })
    // Preserve exact input and identity before any remote mutation starts.
    localStorage.setItem(
      recordKey(binding, teamId, record.key),
      JSON.stringify(record)
    )
    setPending([record])
    return send(record)
  }
  return {
    snapshot: resolvedTeam === teamId ? snapshot : null,
    ready: ready && resolvedTeam === teamId,
    error: resolvedTeam === teamId ? error : "",
    pending: resolvedTeam === teamId ? pending : [],
    refresh,
    command,
    retry: send,
  }
}

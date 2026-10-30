import * as React from "react"
import { CanonicalEditFeedback } from "./issues/canonical-edit-feedback"
import type {
  DefinitionCommand,
  DefinitionSnapshot,
} from "@/lib/issue-definition-contract"
import {
  hydrateIssueEdits,
  resetIssueEdits,
} from "@/lib/canonical-issue-edit-client"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"
import { refreshCanonicalIssues } from "@/lib/canonical-issue-client"
import { migrateLocalIssues } from "@/lib/canonical-issue-migration"
import {
  loadIssueDefinitions,
  persistIssueDefinitions,
} from "@/lib/issue-definition-state"
import { replaceDefinitionCache } from "@/lib/issue-definition-cache"
import { onPreferenceSessionInvalidated } from "@/lib/preference-session-events"
import { Button } from "@/components/ui/button"

type State = {
  userId: string
  sessionId: string
  workspaceId: string
  snapshots: Array<DefinitionSnapshot>
}
const Context = React.createContext<null | {
  state: State
  save: (
    input: Omit<DefinitionCommand, "workspaceId" | "sessionId" | "commandKey">
  ) => Promise<DefinitionSnapshot>
}>(null)
export function IssueDefinitionProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [state, setState] = React.useState<State | null>(null)
  const [migrationErrors, setMigrationErrors] = React.useState<Array<string>>(
    []
  )
  const importRunning = React.useRef(false)
  const [error, setError] = React.useState("")
  const epoch = React.useRef(0)
  const identityEpoch = React.useRef(0)
  const stateRef = React.useRef<State | null>(null)
  const mounted = React.useRef(false)
  const refresh = React.useCallback(async () => {
    const token = ++epoch.current
    try {
      const next = await loadIssueDefinitions()
      if (!mounted.current || token !== epoch.current) return
      if (
        stateRef.current &&
        (stateRef.current.workspaceId !== next.workspaceId ||
          stateRef.current.sessionId !== next.sessionId)
      )
        ++identityEpoch.current
      stateRef.current = next
      replaceDefinitionCache(next.snapshots)
      await refreshCanonicalIssues(next)
      if (!mounted.current || token !== epoch.current) return
      if (!importRunning.current) {
        importRunning.current = true
        try {
          setMigrationErrors(
            await migrateLocalIssues(
              next.snapshots.flatMap((s) => (s.teamId ? [s.teamId] : []))
            )
          )
        } finally {
          importRunning.current = false
        }
      }
      if (!mounted.current || token !== epoch.current) return
      hydrateIssueEdits()
      setState(next)
      setError("")
    } catch {
      if (!mounted.current || token !== epoch.current) return
      // A transient refresh failure must retain the current session and its edits.
      // Actual identity invalidation is handled by the session event below.
      if (!stateRef.current) setState(null)
      setError("Shared issue definitions could not be loaded. Try again.")
    }
  }, [])
  React.useEffect(() => {
    mounted.current = true
    replaceDefinitionCache([])
    void refresh()
    const unsubscribe = onPreferenceSessionInvalidated((phase) => {
      ++epoch.current
      ++identityEpoch.current
      stateRef.current = null
      replaceDefinitionCache([])
      replaceCanonicalIssues(null)
      resetIssueEdits()
      setState(null)
      if (phase === "settled") void refresh()
    })
    const focus = () => {
      void refresh()
    }
    const timer = window.setInterval(focus, 30_000)
    window.addEventListener("focus", focus)
    return () => {
      mounted.current = false
      ++epoch.current
      unsubscribe()
      window.clearInterval(timer)
      window.removeEventListener("focus", focus)
      replaceDefinitionCache([], false)
      replaceCanonicalIssues(null, false)
      resetIssueEdits()
    }
  }, [refresh])
  async function save(
    input: Omit<DefinitionCommand, "workspaceId" | "sessionId" | "commandKey">
  ) {
    if (!state) throw new Error("Shared definitions are unavailable.")
    // Bind this request to the current session and one durable command identity.
    const data = {
      ...input,
      workspaceId: state.workspaceId,
      sessionId: state.sessionId,
      commandKey: crypto.randomUUID(),
    }
    const token = identityEpoch.current
    let next: DefinitionSnapshot
    try {
      next = await persistIssueDefinitions({ data })
    } catch (error) {
      void refresh()
      throw error
    }
    if (!mounted.current || token !== identityEpoch.current) {
      void refresh()
      throw new Error(
        "The active session changed. Reload to view the saved definitions."
      )
    }
    const previous = stateRef.current
    if (
      !previous ||
      previous.sessionId !== data.sessionId ||
      previous.workspaceId !== data.workspaceId
    )
      throw new Error("The active session changed.")
    ++epoch.current // Discard a refresh that started before this committed write.
    const snapshots = previous.snapshots.map((s) =>
      s.teamId === next.teamId && s.revision <= next.revision ? next : s
    )
    const updated = { ...previous, snapshots }
    stateRef.current = updated
    replaceDefinitionCache(snapshots)
    setState(updated)
    return next
  }
  if (!state)
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <div
          role={error ? "alert" : "status"}
          className="space-y-3 text-sm text-muted-foreground"
        >
          <p>{error || "Loading shared issue definitions…"}</p>
          {error && (
            <Button variant="secondary" onClick={() => void refresh()}>
              Try again
            </Button>
          )}
        </div>
      </main>
    )
  return (
    <Context.Provider value={{ state, save }}>
      {migrationErrors.length > 0 && (
        <aside
          role="alert"
          className="border-b border-border bg-muted p-3 text-sm"
        >
          <p>
            Some local issues could not be shared. Their saved copies are
            preserved.
          </p>
          <details>
            <summary>View import problems ({migrationErrors.length})</summary>
            <ul>
              {migrationErrors.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
          </details>
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>
            Retry import
          </Button>
        </aside>
      )}
      <CanonicalEditFeedback />
      {children}
    </Context.Provider>
  )
}
export function useIssueDefinitions(teamId: string | null) {
  const context = React.useContext(Context)
  if (!context) throw new Error("IssueDefinitionProvider is required.")
  const snapshot = context.state.snapshots.find((s) => s.teamId === teamId)
  if (!snapshot) throw new Error("This team's definitions are unavailable.")
  return { snapshot, save: context.save }
}

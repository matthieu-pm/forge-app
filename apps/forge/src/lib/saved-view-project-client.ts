import { useEffect, useState, useSyncExternalStore } from "react"
import { loadViewProjects } from "./saved-view-functions"
import { viewDefinition } from "./saved-view-contract"
import { newCustomView } from "./custom-views"
import {
  CANONICAL_ISSUES_CHANGED,
  canonicalIssueState,
} from "./canonical-issue-cache"
import { protectedSessionEpoch } from "./protected-session"
import { onPreferenceSessionInvalidated } from "./preference-session-events"
import type { InitiativeProject } from "./initiatives"
import type { ProjectFilter, ProjectPreferences } from "./project-view-contract"

function subscribe(fn: () => void) {
  window.addEventListener(CANONICAL_ISSUES_CHANGED, fn)
  const off = onPreferenceSessionInvalidated(fn)
  return () => {
    off()
    window.removeEventListener(CANONICAL_ISSUES_CHANGED, fn)
  }
}
export function useViewProjectQuery(
  enabled: boolean,
  workspaceId: string,
  userId: string,
  filters: Array<ProjectFilter>,
  display: ProjectPreferences,
  teamId?: string
) {
  useSyncExternalStore(
    subscribe,
    () => `${protectedSessionEpoch()}:${canonicalIssueState()?.sessionId}`,
    () => ""
  )
  const identity = canonicalIssueState(),
    epoch = protectedSessionEpoch()
  const session =
    identity?.workspaceId === workspaceId && identity.userId === userId
      ? identity.sessionId
      : ""
  const definition = enabled
    ? JSON.stringify(
        viewDefinition({
          ...newCustomView("projects", userId, teamId),
          filters,
          display,
        })
      )
    : ""
  const key = `${workspaceId}:${userId}:${session}:${epoch}:${definition}`
  const [state, setState] = useState<{
    key: string
    projects: Array<InitiativeProject>
    error: string
  }>()
  useEffect(() => {
    if (!enabled || !session) return
    let active = true,
      generation = 0
    async function refresh() {
      const token = ++generation
      try {
        const projects = JSON.parse(
          await loadViewProjects({
            data: {
              workspaceId,
              sessionId: session,
              definition: JSON.parse(definition),
            },
          })
        ) as Array<InitiativeProject>
        if (active && token === generation && epoch === protectedSessionEpoch())
          setState({ key, projects, error: "" })
      } catch {
        if (active && token === generation)
          setState({
            key,
            projects: [],
            error:
              "Projects could not be loaded. Review the view filters or refresh to try again.",
          })
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30_000)
    const focus = () => void refresh()
    window.addEventListener("focus", focus)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener("focus", focus)
    }
  }, [enabled, key])
  return state?.key === key
    ? { ...state, loading: false }
    : { projects: [], error: "", loading: enabled && Boolean(session) }
}

import { useEffect, useState, useSyncExternalStore } from "react"
import { loadViewProjectQuery } from "./saved-view-functions"
import { viewDefinition } from "./saved-view-contract"
import { newCustomView } from "./custom-views"
import {
  CANONICAL_ISSUES_CHANGED,
  canonicalIssueReadGeneration,
  canonicalIssueState,
} from "./canonical-issue-cache"
import { protectedSessionEpoch } from "./protected-session"
import { onPreferenceSessionInvalidated } from "./preference-session-events"
import type { SavedProjectQuery } from "./saved-view-contract"
import type { ProjectFilter, ProjectPreferences } from "./project-view-contract"

function subscribe(fn: () => void) {
  window.addEventListener(CANONICAL_ISSUES_CHANGED, fn)
  window.addEventListener("forge:issue-queries-invalidated", fn)
  const off = onPreferenceSessionInvalidated(fn)
  return () => {
    off()
    window.removeEventListener(CANONICAL_ISSUES_CHANGED, fn)
    window.removeEventListener("forge:issue-queries-invalidated", fn)
  }
}
export function useViewProjectQuery(
  enabled: boolean,
  workspaceId: string,
  userId: string,
  filters: Array<ProjectFilter>,
  display: ProjectPreferences,
  teamId?: string
): SavedProjectQuery & { error: string; ready: boolean; loading: boolean } {
  useSyncExternalStore(
    subscribe,
    () =>
      `${protectedSessionEpoch()}:${canonicalIssueReadGeneration()}:${canonicalIssueState()?.sessionId}`,
    () => ""
  )
  const identity = canonicalIssueState(),
    epoch = protectedSessionEpoch(),
    accessGeneration = canonicalIssueReadGeneration()
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
  const key = `${workspaceId}:${userId}:${session}:${epoch}:${accessGeneration}:${definition}`
  const [state, setState] = useState<
    SavedProjectQuery & {
      key: string
      error: string
      loading: boolean
    }
  >()
  useEffect(() => {
    if (!enabled || !session) return
    let active = true,
      generation = 0
    async function refresh() {
      const token = ++generation
      setState({
        key,
        projects: [],
        authorizedProjectIds: [],
        error: "",
        loading: true,
      })
      try {
        const result = JSON.parse(
          await loadViewProjectQuery({
            data: {
              workspaceId,
              sessionId: session,
              definition: JSON.parse(definition),
            },
          })
        ) as SavedProjectQuery
        if (
          active &&
          token === generation &&
          epoch === protectedSessionEpoch() &&
          accessGeneration === canonicalIssueReadGeneration()
        )
          setState({ ...result, key, error: "", loading: false })
      } catch {
        if (active && token === generation)
          setState({
            key,
            projects: [],
            authorizedProjectIds: [],
            loading: false,
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
    ? { ...state, ready: !state.loading && !state.error }
    : {
        projects: [],
        authorizedProjectIds: [],
        error: "",
        ready: false,
        loading: enabled && Boolean(session),
      }
}

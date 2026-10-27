import { useCallback, useMemo, useSyncExternalStore } from "react"
import {
  defaultProjectPreferences,
  projectPreferencesKey,
  projectPreferencesSchema,
} from "./projects"

import {
  ISSUES_CHANGED,
  getIssueStatuses,
  parseIssueStore,
  teamIssuesKey,
} from "./team-issues"
import { teamStatusesStorageKey } from "./team-statuses"
import type { ProjectPreferences } from "./projects"
import type { TeamSummary } from "./team-contract"
import type { InitiativeProject } from "./initiatives"
import type { MilestoneIssue } from "./project-milestones"

export type ProjectIssueStat = {
  count: number
  completed: number
  milestoneIssues?: Array<MilestoneIssue>
}

const changed = "forge:projects-view-changed"
function subscribe(notify: () => void) {
  for (const event of ["storage", "focus", changed])
    window.addEventListener(event, notify)
  return () => {
    for (const event of ["storage", "focus", changed])
      window.removeEventListener(event, notify)
  }
}
export function useProjectPreferences(
  workspaceId: string,
  userId: string,
  teamId?: string
) {
  const key = projectPreferencesKey(workspaceId, userId, teamId)
  const raw = useSyncExternalStore(
    subscribe,
    useCallback(() => {
      try {
        return localStorage.getItem(key) ?? ""
      } catch {
        return "unavailable"
      }
    }, [key]),
    () => ""
  )
  const result = useMemo(() => {
    try {
      return {
        preferences: raw
          ? projectPreferencesSchema.parse(JSON.parse(raw))
          : defaultProjectPreferences(),
        error: "",
      }
    } catch {
      return {
        preferences: defaultProjectPreferences(),
        error:
          "Project display options could not be loaded. Saved preferences have been preserved.",
      }
    }
  }, [raw])
  function save(preferences: ProjectPreferences) {
    if (result.error) return false
    try {
      localStorage.setItem(
        key,
        JSON.stringify(projectPreferencesSchema.parse(preferences))
      )
      window.dispatchEvent(new Event(changed))
      return true
    } catch {
      return false
    }
  }
  return { ...result, save }
}

export function useProjectIssueStats(
  teams: Array<TeamSummary>,
  projects: Array<InitiativeProject>
) {
  const keys = JSON.stringify(teams.map((team) => team.id))
  const raw = useSyncExternalStore(
    useCallback((notify: () => void) => {
      const events = [
        "storage",
        "focus",
        ISSUES_CHANGED,
        "forge:team-statuses-changed",
      ]
      for (const event of events) window.addEventListener(event, notify)
      return () => {
        for (const event of events) window.removeEventListener(event, notify)
      }
    }, []),
    useCallback(() => {
      try {
        return JSON.stringify(
          (JSON.parse(keys) as Array<string>).map((id) => [
            id,
            localStorage.getItem(teamIssuesKey(id)),
            localStorage.getItem(teamStatusesStorageKey(id)),
          ])
        )
      } catch {
        return "unavailable"
      }
    }, [keys]),
    () => "[]"
  )
  return useMemo(() => {
    const stats = new Map<string, ProjectIssueStat>()
    try {
      for (const [teamId, stored] of JSON.parse(raw) as Array<
        [string, string | null]
      >) {
        if (!stored) continue
        const issues = parseIssueStore(stored).issues
        const completed = new Set(
          getIssueStatuses(teamId)
            .filter((status) => status.group === "completed")
            .map((status) => status.id)
        )
        for (const project of projects) {
          const matching = issues.filter(
            (issue) =>
              issue.project === project.id ||
              (project.teamIds.includes(teamId) &&
                issue.project === project.name)
          )
          const current = stats.get(project.id) ?? { count: 0, completed: 0 }
          stats.set(project.id, {
            milestoneIssues: [
              ...(current.milestoneIssues ?? []),
              ...matching.map((issue) => ({
                issue,
                completed: completed.has(issue.status),
              })),
            ],
            count: current.count + matching.length,
            completed:
              current.completed +
              matching.filter((issue) => completed.has(issue.status)).length,
          })
        }
      }
      return { stats, error: "" }
    } catch {
      return {
        stats: new Map<string, ProjectIssueStat>(),
        error:
          "Project issue counts could not be loaded. Saved issues have been preserved.",
      }
    }
  }, [raw, projects])
}

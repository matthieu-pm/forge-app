import { useCallback, useMemo, useSyncExternalStore } from "react"
import {
  DEFINITIONS_CHANGED,
  cachedDefinitions,
  sharedDefinitionsActive,
} from "./issue-definition-cache"

import {
  ISSUES_CHANGED,
  getIssueStatuses,
  issueStoreSnapshot,
  parseIssueStore,
} from "./team-issues"
import { teamStatusesStorageKey } from "./team-statuses"
import type { TeamSummary } from "./team-contract"
import type { InitiativeProject } from "./initiatives"
import type { MilestoneIssue } from "./project-milestones"
import { productStorage } from "@/lib/product-storage"
import { useWorkspaceView } from "@/components/account-preference-provider"

export type ProjectIssueStat = {
  count: number
  completed: number
  milestoneIssues?: Array<MilestoneIssue>
}

export function useProjectPreferences(
  workspaceId: string,
  userId: string,
  teamId?: string
) {
  const sync = useWorkspaceView("projects", teamId ?? "main", {
    workspaceId,
    userId,
  })
  return { preferences: sync.value, error: sync.error, save: sync.save }
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
        DEFINITIONS_CHANGED,
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
            issueStoreSnapshot(id),
            sharedDefinitionsActive()
              ? JSON.stringify(cachedDefinitions(id).value.statuses)
              : productStorage.getItem(teamStatusesStorageKey(id)),
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

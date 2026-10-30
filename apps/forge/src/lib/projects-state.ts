import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useIssueQuery } from "./issue-query-client"
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
import type { IssueQueryPage } from "./issue-query-contract"
import type { TeamSummary } from "./team-contract"
import type { InitiativeProject } from "./initiatives"
import type { MilestoneIssue } from "./project-milestones"
import { productStorage } from "@/lib/product-storage"
import { useWorkspaceView } from "@/components/account-preference-provider"

export type ProjectIssueStat = {
  count: number
  completed: number
  milestoneIssues?: Array<MilestoneIssue>
  milestoneCounts?: IssueQueryPage["rollups"]
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
  const query = useIssueQuery({
    teamIds: teams.map((t) => t.id),
    project: projects.length === 1 ? projects[0].id : undefined,
    limit: 1,
  })
  const local = useMemo(() => {
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
  if (!query.enabled) return local
  const stats = new Map<string, ProjectIssueStat>()
  for (const project of projects) {
    const rollups =
      query.page?.rollups.filter((r) => r.project === project.id) ?? []
    const total = query.page?.projectTotals.find(
      (r) => r.project === project.id
    )
    stats.set(project.id, {
      count: total?.count ?? 0,
      completed: total?.completed ?? 0,
      milestoneCounts: rollups,
    })
  }
  return {
    stats,
    error:
      query.error ||
      (query.page?.facetsTruncated
        ? "Issue breakdowns are limited. Filter to one project for more detail."
        : ""),
  }
}

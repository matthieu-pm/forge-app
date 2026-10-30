import { useCallback, useMemo, useSyncExternalStore } from "react"

import {
  ISSUES_CHANGED,
  initialIssueStore,
  parseIssueStore,
  teamIssuesKey,
} from "./team-issues"
import {
  initialTeamStatuses,
  parseTeamStatuses,
  teamStatusesStorageKey,
} from "./team-statuses"
import {
  initialTeamLabels,
  parseTeamLabels,
  teamLabelsStorageKey,
} from "./team-labels"
import type { MyIssuePreferences } from "./my-issues"
import type { TeamSummary } from "./team-contract"
import { useWorkspaceView } from "@/components/account-preference-provider"

const PREFERENCES_CHANGED = "forge:my-issues-preferences-changed"
function subscribe(notify: () => void) {
  for (const event of ["storage", "focus", ISSUES_CHANGED, PREFERENCES_CHANGED])
    window.addEventListener(event, notify)
  return () => {
    for (const event of [
      "storage",
      "focus",
      ISSUES_CHANGED,
      PREFERENCES_CHANGED,
    ])
      window.removeEventListener(event, notify)
  }
}
export function useMyIssueData(teams: Array<TeamSummary>) {
  const snapshot = useSyncExternalStore(
    subscribe,
    useCallback(() => {
      try {
        return JSON.stringify(
          teams.map((team) =>
            [
              teamIssuesKey(team.id),
              teamStatusesStorageKey(team.id),
              teamLabelsStorageKey(team.id),
            ].map((key) => localStorage.getItem(key))
          )
        )
      } catch {
        return "unavailable"
      }
    }, [teams]),
    () => ""
  )
  return useMemo(() => {
    const errors: Array<string> = []
    const contexts = teams.flatMap((team, index) => {
      if (!snapshot) return []
      try {
        const [issueRaw, statusRaw, labelRaw] = (
          JSON.parse(snapshot) as Array<Array<string | null>>
        )[index]
        const store = issueRaw ? parseIssueStore(issueRaw) : initialIssueStore()
        const statuses = (
          statusRaw ? parseTeamStatuses(statusRaw) : initialTeamStatuses()
        ).statuses
        const labels = (
          labelRaw ? parseTeamLabels(labelRaw) : initialTeamLabels(team.slug)
        ).labels.filter((label) => !label.archived)
        return [
          {
            team,
            issues: store.issues,
            statuses,
            labels: labels.map((label) => label.name),
            labelColors: Object.fromEntries(
              labels.map((label) => [label.name, label.color])
            ),
          },
        ]
      } catch {
        errors.push(
          `${team.name} issues could not be loaded. Saved data has been preserved.`
        )
        return []
      }
    })
    return { contexts, errors, ready: Boolean(snapshot) }
  }, [snapshot, teams])
}
export function useMyIssuePreferences(userId: string, workspaceId?: string) {
  const sync = useWorkspaceView("myIssues", "main", { userId, workspaceId })
  return {
    preferences: sync.value,
    error: sync.error,
    save: (next: MyIssuePreferences) => {
      if (!sync.save(next)) throw new Error("Preferences unavailable")
    },
  }
}

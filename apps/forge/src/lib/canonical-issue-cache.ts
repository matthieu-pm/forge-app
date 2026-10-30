import type { TeamIssue } from "./issue-record-contract"
import type { InitiativeProject } from "./initiatives"

export const CANONICAL_ISSUES_CHANGED = "forge:canonical-issues-changed"
export type CanonicalSnapshot = {
  workspaceId: string
  userId: string
  sessionId: string
  records: Array<{ teamId: string; issue: TeamIssue; legacyId?: string | null }>
  projects: Array<{
    id: string
    name: string
    legacyId: string | null
    properties: Record<string, unknown>
  }>
  cycles: Array<{
    id: string
    teamId: string
    startDate: string
    endDate: string
  }>
}
let state: CanonicalSnapshot | null = null
let active = false
let epoch = 0
const optimistic = new Map<string, TeamIssue>()
export function canonicalIssueEpoch() {
  return epoch
}
export function canonicalIssueState() {
  return state
}
export function canonicalIssuesActive() {
  return active
}
export function replaceCanonicalIssues(
  next: CanonicalSnapshot | null,
  enabled = true
) {
  const changed =
    !next ||
    !state ||
    next.workspaceId !== state.workspaceId ||
    next.sessionId !== state.sessionId
  if (changed) {
    epoch++
    optimistic.clear()
  } else {
    const previous = new Map(state!.records.map((r) => [r.issue.id, r]))
    next.records = next.records.map((r) => {
      const old = previous.get(r.issue.id)
      return old && (old.issue.revision ?? 0) > (r.issue.revision ?? 0)
        ? old
        : r
    })
    for (const id of optimistic.keys())
      if (!next.records.some((r) => r.issue.id === id)) optimistic.delete(id)
  }
  state = next
  active = enabled
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CANONICAL_ISSUES_CHANGED))
    window.dispatchEvent(new Event("forge:team-issues-changed"))
  }
}
export function canonicalProjects(
  workspaceId: string
): Array<InitiativeProject> {
  if (state?.workspaceId !== workspaceId) return []
  return state.projects.map(
    (p) =>
      ({
        ...p.properties,
        id: p.id,
        name: p.name,
        teamIds: (p.properties.teamIds as Array<string> | undefined) ?? [],
        status: p.properties.status ?? "Backlog",
        health: p.properties.health ?? "On track",
      }) as InitiativeProject
  )
}
export function canonicalIssueRows(teamId: string) {
  return (
    state?.records
      .filter((r) => r.teamId === teamId)
      .map((r) => ({ ...r, issue: optimistic.get(r.issue.id) ?? r.issue })) ??
    []
  )
}

export function projectDisplayName(value: string) {
  return (
    state?.projects.find((p) => p.id === value || p.legacyId === value)?.name ??
    value
  )
}

function notifyIssues() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CANONICAL_ISSUES_CHANGED))
    window.dispatchEvent(new Event("forge:team-issues-changed"))
  }
}
export function setOptimisticIssue(issue: TeamIssue) {
  optimistic.set(issue.id, issue)
  notifyIssues()
}
export function clearOptimisticIssue(issueId: string) {
  optimistic.delete(issueId)
  notifyIssues()
}
export function mergeCanonicalIssueRecords(
  records: CanonicalSnapshot["records"]
) {
  if (!state) return
  const byId = new Map(state.records.map((r) => [r.issue.id, r]))
  for (const record of records) {
    const old = byId.get(record.issue.id)
    if (!old || (record.issue.revision ?? 0) >= (old.issue.revision ?? 0))
      byId.set(record.issue.id, record)
  }
  state = { ...state, records: [...byId.values()] }
  notifyIssues()
}

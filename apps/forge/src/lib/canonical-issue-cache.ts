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
const suppressed = new Map<string, number>()
const revisionFloors = new Map<string, number>()
let removalEpoch = 0
let readGeneration = 0
const removedAt = new Map<string, number>()
const requiresAuthorizedRead = new Set<string>()
// Explicit eviction is different from a metadata-only bootstrap refresh. Detail
// hooks may retain an editor across the latter, but never across the former.
export function canonicalIssueRemovalEpoch(id?: string) {
  return id ? (removedAt.get(id) ?? 0) : removalEpoch
}
export function canonicalIssueReadGeneration() {
  return readGeneration
}
export function canonicalSuppressionSnapshot() {
  return [...suppressed.keys()].sort().join(",")
}
export function isCanonicalIssueSuppressed(id: string) {
  return suppressed.has(id)
}
function acceptCanonicalIssueRecord(
  issue: TeamIssue,
  authorizedReadEpoch?: number
) {
  // A delayed mutation acknowledgement may predate access loss. Its receipt is
  // still valid, but only a fresh authorized read may restore the cached row.
  if (
    requiresAuthorizedRead.has(issue.id) &&
    (authorizedReadEpoch === undefined ||
      authorizedReadEpoch < (removedAt.get(issue.id) ?? 0))
  )
    return false
  const revision = issue.revision ?? 0
  if (
    revision < (revisionFloors.get(issue.id) ?? 0) ||
    revision <= (suppressed.get(issue.id) ?? -1)
  )
    return false
  suppressed.delete(issue.id)
  requiresAuthorizedRead.delete(issue.id)
  revisionFloors.set(issue.id, revision)
  return true
}
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
  readGeneration++
  const changed =
    !next ||
    !state ||
    next.workspaceId !== state.workspaceId ||
    next.userId !== state.userId ||
    next.sessionId !== state.sessionId
  if (changed) {
    epoch++
    optimistic.clear()
    suppressed.clear()
    revisionFloors.clear()
    removedAt.clear()
    requiresAuthorizedRead.clear()
    removalEpoch++
  } else if (next.records.length) {
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
  if (!changed) {
    const retained = new Set(next.records.map((r) => r.issue.id))
    for (const record of state!.records)
      if (!retained.has(record.issue.id))
        requiresAuthorizedRead.add(record.issue.id)
  }
  state = next
    ? {
        ...next,
        records: next.records.filter((r) =>
          acceptCanonicalIssueRecord(r.issue)
        ),
      }
    : null
  active = enabled
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("forge:issue-queries-invalidated"))
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
  if (
    isCanonicalIssueSuppressed(issue.id) ||
    (issue.revision ?? 0) < (revisionFloors.get(issue.id) ?? 0)
  )
    return
  optimistic.set(issue.id, issue)
  notifyIssues()
}
export function clearOptimisticIssue(issueId: string) {
  optimistic.delete(issueId)
  notifyIssues()
}
export function mergeCanonicalIssueRecords(
  records: CanonicalSnapshot["records"],
  invalidate = true,
  authorizedReadEpoch?: number
) {
  if (!state) return
  const byId = new Map(state.records.map((r) => [r.issue.id, r]))
  for (const record of records) {
    if (!acceptCanonicalIssueRecord(record.issue, authorizedReadEpoch)) continue
    const old = byId.get(record.issue.id)
    if (!old || (record.issue.revision ?? 0) >= (old.issue.revision ?? 0))
      byId.set(record.issue.id, record)
  }
  state = { ...state, records: [...byId.values()] }
  if (invalidate && typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("forge:issue-queries-invalidated", {
        detail: {
          teamIds: [...new Set(records.map((r) => r.teamId))],
          retainedIssueIds: records.map((r) => r.issue.id),
        },
      })
    )
  notifyIssues()
}

/** A delayed edit/read response must not reintroduce a deleted or archived row.
 * A subsequent authorized restore has a higher revision and clears the fence. */
export function suppressCanonicalIssueRecord(id: string, revision: number) {
  if (revision < (revisionFloors.get(id) ?? 0)) return
  revisionFloors.set(id, revision)
  suppressed.set(id, Math.max(revision, suppressed.get(id) ?? -1))
  removeCanonicalIssueRecords([id])
}

export function restoreCanonicalIssueVisibility(
  id: string,
  revision: number,
  active: boolean
) {
  if (revision < (revisionFloors.get(id) ?? 0)) return
  revisionFloors.set(id, revision)
  if (active) suppressed.delete(id)
  else suppressed.set(id, revision)
  removeCanonicalIssueRecords([id])
  notifyIssues()
}

function discardCanonicalIssueRecords(ids: Array<string>) {
  if (!state || !ids.length) return
  const removed = new Set(ids)
  state = {
    ...state,
    records: state.records.filter((r) => !removed.has(r.issue.id)),
  }
  for (const id of ids) optimistic.delete(id)
  notifyIssues()
}

/** Collection invalidation discards cached rows, including unmounted details.
 * Mounted editors keep their own projection until their authorized read settles.
 * A committed mutation's fresh records are retained through its invalidation. */
export function clearCanonicalIssueQueryRecords(
  teamIds?: Array<string>,
  retainedIssueIds: Array<string> = []
) {
  readGeneration++
  const retained = new Set(retainedIssueIds)
  const ids =
    state?.records
      .filter(
        (r) =>
          (!teamIds || teamIds.includes(r.teamId)) && !retained.has(r.issue.id)
      )
      .map((r) => r.issue.id) ?? []
  for (const id of ids) requiresAuthorizedRead.add(id)
  discardCanonicalIssueRecords(ids)
}

export function removeCanonicalIssueRecords(
  ids: Array<string>,
  options: { requireAuthorizedRead?: boolean } = {}
) {
  if (!state || !ids.length) return
  readGeneration++
  removalEpoch++
  for (const id of ids) {
    removedAt.set(id, removalEpoch)
    if (options.requireAuthorizedRead) requiresAuthorizedRead.add(id)
  }
  discardCanonicalIssueRecords(ids)
}

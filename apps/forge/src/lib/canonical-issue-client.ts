import {
  canonicalIssueEpoch,
  canonicalIssueState,
  replaceCanonicalIssues,
} from "./canonical-issue-cache"
import {
  loadCanonicalIssues,
  persistCanonicalIssue,
} from "./canonical-issue-state"
import { initiativeStoreSchema, initiativesStorageKey } from "./initiatives"
import {
  parseTeamCycles,
  scheduledTeamCycles,
  teamCyclesStorageKey,
} from "./team-cycles"
import type { CreateCanonicalIssue } from "./canonical-issue-contract"
import type { CanonicalSnapshot } from "./canonical-issue-cache"
import type { IssueDraft, TeamIssue } from "./issue-record-contract"
import { productStorage } from "@/lib/product-storage"

export async function refreshCanonicalIssues(identity: {
  workspaceId: string
  sessionId: string
}) {
  const token = canonicalIssueEpoch()
  const state = JSON.parse(await loadCanonicalIssues()) as CanonicalSnapshot
  if (
    state.workspaceId !== identity.workspaceId ||
    state.sessionId !== identity.sessionId
  )
    throw new Error("The active session changed.")
  if (token !== canonicalIssueEpoch())
    throw new Error("The active workspace changed while loading issues.")
  replaceCanonicalIssues(state)
  return state
}
export function prepareIssueRelations(
  teamId: string,
  draft: IssueDraft
): Pick<CreateCanonicalIssue, "projectImport" | "cycleImport"> {
  const state = canonicalIssueState()
  if (!state)
    throw new Error("Shared issues are unavailable. Reload to try again.")
  let projectImport: CreateCanonicalIssue["projectImport"]
  if (
    draft.project &&
    !state.projects.some(
      (p) => p.id === draft.project || p.legacyId === draft.project
    )
  ) {
    const raw = productStorage.getItem(initiativesStorageKey(state.workspaceId))
    if (raw) {
      const local = initiativeStoreSchema.parse(JSON.parse(raw))
      const matches = [
        ...local.workspaceProjects,
        ...local.initiatives.flatMap((i) => i.projects),
      ].filter((p) => p.id === draft.project || p.name === draft.project)
      const unique = [...new Map(matches.map((p) => [p.id, p])).values()]
      if (unique.length === 1) projectImport = unique[0]
    }
  }
  let cycleImport: CreateCanonicalIssue["cycleImport"]
  if (
    draft.cycle &&
    !state.cycles.some(
      (c) => c.teamId === teamId && c.startDate === draft.cycle
    )
  ) {
    const raw = productStorage.getItem(teamCyclesStorageKey(teamId))
    const settings = raw ? parseTeamCycles(raw) : null
    const scheduled = settings
      ? scheduledTeamCycles(settings).find((c) => c.value === draft.cycle)
      : null
    const end = new Date(`${draft.cycle}T12:00:00Z`)
    end.setUTCDate(end.getUTCDate() + (settings?.duration ?? 2) * 7 - 1)
    cycleImport = {
      startDate: draft.cycle,
      endDate: scheduled
        ? new Date(
            scheduled.end.getTime() - scheduled.end.getTimezoneOffset() * 60000
          )
            .toISOString()
            .slice(0, 10)
        : end.toISOString().slice(0, 10),
    }
  }
  return { projectImport, cycleImport }
}
export async function createSharedTeamIssue(
  teamId: string,
  draft: IssueDraft,
  options: { commandKey: string; legacyId?: string; assigneeId?: string | null }
) {
  const before = canonicalIssueState()
  if (!before)
    throw new Error("Shared issues are unavailable. Reload to try again.")
  const data = {
    teamId,
    draft,
    ...options,
    ...prepareIssueRelations(teamId, draft),
    workspaceId: before.workspaceId,
    sessionId: before.sessionId,
  }
  const result = JSON.parse(await persistCanonicalIssue({ data })) as {
    issue: TeamIssue
    records: CanonicalSnapshot["records"]
  }
  const after = canonicalIssueState()
  if (
    after?.workspaceId !== before.workspaceId ||
    after.sessionId !== before.sessionId
  )
    throw new Error(
      "The active session changed. Reload to view the saved issue."
    )
  // A fresh authoritative snapshot includes imported projects/cycles as well.
  await refreshCanonicalIssues(before)
  return result.issue
}

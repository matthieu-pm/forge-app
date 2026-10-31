import { protectedSessionEpoch } from "./protected-session"
import { stableJson } from "./stable-json"
import { onPreferenceSessionInvalidated } from "./preference-session-events"
import {
  canonicalIssueEpoch,
  canonicalIssueReadGeneration,
  canonicalIssueRemovalEpoch,
  canonicalIssueState,
  mergeCanonicalIssueRecords,
  replaceCanonicalIssues,
} from "./canonical-issue-cache"
import {
  loadCanonicalIssues,
  loadIssueDetail,
  persistCanonicalIssue,
} from "./canonical-issue-state"
import { initiativeStoreSchema, initiativesStorageKey } from "./initiatives"
import {
  parseTeamCycles,
  scheduledTeamCycles,
  teamCyclesStorageKey,
} from "./team-cycles"
import { finishCreatedIssueFiles } from "./issue-file-client"
import type { CreateCanonicalIssue } from "./canonical-issue-contract"
import type { CanonicalSnapshot } from "./canonical-issue-cache"
import type { IssueDraft, TeamIssue } from "./issue-record-contract"
import { productStorage, saveProductValue } from "@/lib/product-storage"

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
const preparedCreates = new Map<
  string,
  {
    intent: string
    data: CreateCanonicalIssue & { workspaceId: string; sessionId: string }
  }
>()

export async function createSharedTeamIssue(
  teamId: string,
  draft: IssueDraft,
  options: { commandKey: string; legacyId?: string; assigneeId?: string | null }
) {
  const epoch = canonicalIssueEpoch()
  const protectedEpoch = protectedSessionEpoch()
  const before = canonicalIssueState()
  if (!before)
    throw new Error("Shared issues are unavailable. Reload to try again.")
  const intent = stableJson({
    teamId,
    draft,
    options,
    workspaceId: before.workspaceId,
    userId: before.userId,
  })
  const recoveryKey = `forge:team-issue-create-intent:v1:${teamId}:${options.commandKey}`
  let retained = preparedCreates.get(options.commandKey)
  if (!retained) {
    const raw = productStorage.getItem(recoveryKey)
    if (raw) retained = JSON.parse(raw)
  }
  if (retained && retained.intent !== intent)
    throw new Error(
      "This creation is waiting for confirmation. Retry its original draft before changing it."
    )
  const prepared =
    retained?.data ??
    structuredClone({
      teamId,
      draft,
      ...options,
      ...prepareIssueRelations(teamId, draft),
      workspaceId: before.workspaceId,
      sessionId: before.sessionId,
    })
  const data = {
    ...prepared,
    workspaceId: before.workspaceId,
    sessionId: before.sessionId,
  }
  preparedCreates.set(options.commandKey, { intent, data })
  await saveProductValue(recoveryKey, JSON.stringify({ intent, data }))
  if (
    epoch !== canonicalIssueEpoch() ||
    protectedEpoch !== protectedSessionEpoch()
  )
    throw new Error("The active session changed.")
  const result = JSON.parse(await persistCanonicalIssue({ data })) as {
    issue: TeamIssue
    records: CanonicalSnapshot["records"]
  }
  const after = canonicalIssueState()
  if (
    epoch !== canonicalIssueEpoch() ||
    protectedEpoch !== protectedSessionEpoch() ||
    after?.userId !== before.userId ||
    after?.workspaceId !== before.workspaceId ||
    after.sessionId !== before.sessionId
  )
    throw new Error(
      "The active session changed. Reload to view the saved issue."
    )
  // The confirmed receipt is creation success. Attachment completion is a
  // private, issue-scoped job, never a reason to create a second issue.
  mergeCanonicalIssueRecords(result.records)
  const assertCurrent = () => {
    const current = canonicalIssueState()
    if (
      epoch !== canonicalIssueEpoch() ||
      protectedEpoch !== protectedSessionEpoch() ||
      current?.userId !== before.userId ||
      current?.sessionId !== before.sessionId ||
      current?.workspaceId !== before.workspaceId
    )
      throw new Error("The active session changed.")
  }
  // Acknowledgement cleanup can fail offline after the creation has committed.
  // Keep its exact replay journal without reporting a failed creation.
  try {
    await saveProductValue(recoveryKey, null)
  } catch {
    assertCurrent()
  }
  assertCurrent()
  try {
    await refreshCanonicalIssues(before)
    assertCurrent()
    // The metadata bootstrap discards issue rows. Reauthorize the created ID
    // rather than restoring a receipt projection that may predate access loss.
    const readEpoch = canonicalIssueRemovalEpoch(result.issue.id)
    const readGeneration = canonicalIssueReadGeneration()
    const records = JSON.parse(
      await loadIssueDetail({
        data: {
          workspaceId: before.workspaceId,
          sessionId: before.sessionId,
          id: result.issue.id,
        },
      })
    ) as CanonicalSnapshot["records"]
    assertCurrent()
    if (
      readEpoch === canonicalIssueRemovalEpoch(result.issue.id) &&
      readGeneration === canonicalIssueReadGeneration()
    )
      mergeCanonicalIssueRecords(records, false, readEpoch)
  } catch {
    assertCurrent()
  }
  assertCurrent()
  mergeCanonicalIssueRecords(result.records)
  if (!options.legacyId && draft.attachments?.length) {
    try {
      await finishCreatedIssueFiles(
        teamId,
        result.issue.id,
        draft.attachments,
        options.commandKey,
        true
      )
    } catch {
      assertCurrent()
      // The source was saved with the issue transaction. Its UI offers retry or discard.
    }
  }
  assertCurrent()

  preparedCreates.delete(options.commandKey)
  return (
    canonicalIssueState()?.records.find((r) => r.issue.id === result.issue.id)
      ?.issue ?? result.issue
  )
}

if (typeof window !== "undefined")
  onPreferenceSessionInvalidated(() => preparedCreates.clear())

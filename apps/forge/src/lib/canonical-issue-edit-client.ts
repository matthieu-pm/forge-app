import { prepareIssueRelations } from "./canonical-issue-client"
import {
  editIssueBatchSchema,
  issueChangesSchema,
} from "./canonical-issue-edit-contract"
import {
  canonicalIssueEpoch,
  canonicalIssueRows,
  canonicalIssueState,
  clearOptimisticIssue,
  mergeCanonicalIssueRecords,
  setOptimisticIssue,
} from "./canonical-issue-cache"
import {
  loadIssueDetail,
  persistCanonicalIssueEdits,
} from "./canonical-issue-state"
import { productStorage, saveProductValue } from "./product-storage"
import type { CanonicalSnapshot } from "./canonical-issue-cache"
import type {
  EditIssueBatch,
  IssueChanges,
} from "./canonical-issue-edit-contract"
import type { TeamIssue } from "./issue-record-contract"

export const ISSUE_EDITS_CHANGED = "forge:issue-edits-changed"
type Pending = {
  input: EditIssueBatch
  sourceKey: string
  preparedRebase?: boolean
}
let queue: Array<Pending> = [],
  running = false,
  error = "",
  conflict = false,
  epoch = 0
function notify() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(ISSUE_EDITS_CHANGED))
}
const keyFor = (batch: EditIssueBatch) =>
  `forge:team-issue-edit-drafts:v1:${batch.teamId}:${batch.commandKey}`
export function resetIssueEdits() {
  epoch++
  queue = []
  running = false
  error = ""
  conflict = false
  notify()
}
export function hasPendingIssueEdits() {
  return queue.length > 0
}
export function issueEditSnapshot() {
  return JSON.stringify({
    pending: queue.length,
    running,
    error,
    conflict,
    drafts: queue.flatMap((q) =>
      q.input.edits.map((e) => ({
        ...e,
        title:
          canonicalIssueState()?.records.find((r) => r.issue.id === e.issueId)
            ?.issue.title ?? "Issue",
        latest: canonicalIssueState()?.records.find(
          (r) => r.issue.id === e.issueId
        )?.issue,
      }))
    ),
  })
}
export function hydrateIssueEdits() {
  const state = canonicalIssueState()
  if (!state) return
  for (let index = 0; index < productStorage.length; index++) {
    const key = productStorage.key(index)
    if (!key?.startsWith("forge:team-issue-edit-drafts:v1:")) continue
    const raw = productStorage.getItem(key)
    if (!raw) continue
    try {
      const stored = JSON.parse(raw)
      const { requiresReview, ...original } = stored
      const input = editIssueBatchSchema.parse(original)
      if (queue.some((q) => q.input.commandKey === input.commandKey)) continue
      queue.push({ input, sourceKey: key })
      if (requiresReview === true) {
        conflict = true
        error =
          "Some saved issue edits require review. Review the latest versions before applying the remaining edits."
        continue
      }
      error =
        "Saved issue edits are waiting. Retry them or use the latest shared version."
    } catch {
      /* Preserve unsupported saved drafts for a future client. */
    }
  }
  notify()
}
function optimisticFor(
  before: TeamIssue,
  changes: IssueChanges,
  triageDecision?: "accept" | "decline"
): TeamIssue {
  const now = new Date().toISOString()
  return {
    ...before,
    ...changes,
    ...(triageDecision ? { triage: false, snoozed: false } : {}),
    subIssues: [],
    revision: (before.revision ?? 0) + 1,
    updatedAt: now,
    statusChangedAt:
      changes.status && changes.status !== before.status
        ? now
        : before.statusChangedAt,
  }
}
export function enqueueIssueEdits(
  teamId: string,
  edits: Array<{
    before: TeamIssue
    changes: IssueChanges
    triageDecision?: "accept" | "decline"
  }>
) {
  if (!edits.length) return
  const input = editIssueBatchSchema.parse({
    commandKey: crypto.randomUUID(),
    teamId,
    edits: edits.map(({ before, changes, triageDecision }) => ({
      issueId: before.id,
      expectedRevision: before.revision ?? 0,
      changes,
      ...(triageDecision ? { triageDecision } : {}),
      ...prepareIssueRelations(teamId, { ...before, ...changes }),
    })),
  })
  const sourceKey = keyFor(input)
  queue.push({ input, sourceKey })
  // Persist every batch independently, including batches behind a blocked head.
  productStorage.setItem(sourceKey, JSON.stringify(input))
  for (const edit of edits)
    setOptimisticIssue(
      optimisticFor(
        canonicalIssueRows(teamId).find((r) => r.issue.id === edit.before.id)
          ?.issue ?? edit.before,
        edit.changes,
        edit.triageDecision
      )
    )
  notify()
  void flushIssueEdits()
}
export async function flushIssueEdits() {
  const identity = canonicalIssueState()
  if (running || !identity || conflict) return
  running = true
  error = ""
  notify()
  const token = epoch,
    identityToken = canonicalIssueEpoch()
  try {
    while (
      queue.length &&
      token === epoch &&
      identityToken === canonicalIssueEpoch()
    ) {
      const pending = queue[0]
      await saveProductValue(pending.sourceKey, JSON.stringify(pending.input))
      const response = JSON.parse(
        await persistCanonicalIssueEdits({
          data: {
            ...pending.input,
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
          },
        })
      ) as {
        status: "saved" | "conflict"
        records: CanonicalSnapshot["records"]
      }
      if (token !== epoch || identityToken !== canonicalIssueEpoch()) return
      mergeCanonicalIssueRecords(response.records)
      if (response.status === "conflict") {
        conflict = true
        for (const item of queue) item.preparedRebase = false
        error =
          "These issues changed in another session. Your edits are retained for review."
        for (const item of queue)
          for (const edit of item.input.edits)
            clearOptimisticIssue(edit.issueId)
        break
      }
      await saveProductValue(pending.sourceKey, null)
      if (token !== epoch || identityToken !== canonicalIssueEpoch()) return
      queue.shift()
      for (const edit of pending.input.edits)
        if (
          !queue.some((q) =>
            q.input.edits.some((e) => e.issueId === edit.issueId)
          )
        )
          clearOptimisticIssue(edit.issueId)
      notify()
    }
  } catch (failure) {
    if (token === epoch)
      error =
        failure instanceof Error &&
        !/^(\[|Failed query|SQL)/.test(failure.message)
          ? failure.message
          : "Issue edits could not be saved. Your draft is still available to retry."
  } finally {
    if (token === epoch) {
      running = false
      notify()
    }
  }
}
export async function useLatestIssueVersions() {
  if (running) return
  const token = epoch,
    discarded = [...queue]
  running = true
  notify()
  let ready = false
  try {
    for (const pending of discarded) {
      await saveProductValue(pending.sourceKey, null)
      if (token !== epoch) return
    }
    queue = queue.filter((pending) => !discarded.includes(pending))
    for (const pending of discarded)
      for (const edit of pending.input.edits)
        if (
          !queue.some((item) =>
            item.input.edits.some((next) => next.issueId === edit.issueId)
          )
        )
          clearOptimisticIssue(edit.issueId)
    conflict = false
    error = ""
    ready = true
  } catch {
    if (token === epoch)
      error = "Saved edits could not be cleared. Retry when connected."
  } finally {
    if (token === epoch) {
      running = false
      notify()
    }
  }
  if (ready && token === epoch) void flushIssueEdits()
}
/** Drop only decisions that can no longer apply, retaining unrelated drafts for
 * explicit revision review. A known conflict is required before changing inputs. */
export async function discardUnavailableTriageDecisions() {
  if (running || !conflict) return
  const state = canonicalIssueState()
  if (!state) return
  const token = epoch
  const latest = new Map(state.records.map((r) => [r.issue.id, r.issue]))
  const identityToken = canonicalIssueEpoch()
  running = true
  notify()
  try {
    // A bounded cache miss is unknown. Recheck missing decisions under current
    // authorization before treating them as decided or unavailable after reload.
    const unknown = [
      ...new Set(
        queue.flatMap((pending) =>
          pending.input.edits
            .filter((edit) => edit.triageDecision && !latest.has(edit.issueId))
            .map((edit) => edit.issueId)
        )
      ),
    ]
    const details = await Promise.all(
      unknown.map(async (id) => ({
        id,
        records: JSON.parse(
          await loadIssueDetail({
            data: {
              workspaceId: state.workspaceId,
              sessionId: state.sessionId,
              id,
            },
          })
        ) as CanonicalSnapshot["records"],
      }))
    )
    if (token !== epoch || identityToken !== canonicalIssueEpoch()) return
    const unavailable = new Set<string>()
    for (const detail of details) {
      const record = detail.records.find((r) => r.issue.id === detail.id)
      if (record) latest.set(detail.id, record.issue)
      else unavailable.add(detail.id)
    }
    mergeCanonicalIssueRecords(details.flatMap((detail) => detail.records))
    let discarded = 0
    for (const pending of [...queue]) {
      const edits = pending.input.edits.filter(
        (edit) =>
          !edit.triageDecision ||
          (!unavailable.has(edit.issueId) &&
            latest.get(edit.issueId)?.triage !== false)
      )
      if (edits.length === pending.input.edits.length) continue
      discarded += pending.input.edits.length - edits.length
      // requiresReview survives reload; never automatically submit a shortened batch.
      const retained = { ...pending.input, edits }
      await saveProductValue(
        pending.sourceKey,
        edits.length
          ? JSON.stringify({ ...retained, requiresReview: true })
          : null
      )
      if (token !== epoch || identityToken !== canonicalIssueEpoch()) return
      if (edits.length) {
        pending.input = retained
        pending.preparedRebase = false
      } else queue = queue.filter((item) => item !== pending)
    }
    error = queue.length
      ? discarded
        ? "Unavailable triage decisions were discarded. Review your remaining edits before applying them."
        : "These triage issues are still pending. Review the latest versions before applying your edits."
      : ""
    conflict = queue.length > 0
  } catch {
    if (token === epoch)
      error =
        "Triage decisions could not be cleared. Your saved drafts are preserved."
  } finally {
    if (token === epoch) {
      running = false
      notify()
    }
  }
}

export async function applyEditsToLatest() {
  // An uncertain response must replay its original command before any rebase.
  if (running || !conflict) return
  const state = canonicalIssueState()
  if (!state) return
  const token = epoch,
    versions = new Map(state.records.map((r) => [r.issue.id, r.issue]))
  running = true
  notify()
  let ready = false
  try {
    for (const pending of queue) {
      if (!pending.preparedRebase) {
        pending.input = {
          ...pending.input,
          commandKey: crypto.randomUUID(),
          edits: pending.input.edits.map((edit) => {
            const before = versions.get(edit.issueId)
            if (!before) throw new Error("An issue is no longer available.")
            if (edit.triageDecision && !before.triage)
              throw new Error(
                "This issue has already left triage. Use the latest shared version."
              )
            return { ...edit, expectedRevision: before.revision ?? 0 }
          }),
        }
        pending.preparedRebase = true
      }
      for (const edit of pending.input.edits) {
        const before = versions.get(edit.issueId)
        if (before)
          versions.set(
            edit.issueId,
            optimisticFor(before, edit.changes, edit.triageDecision)
          )
      }
      // Replace the same durable draft slot. Never expose two generations after
      // a partial save or a reload, and retain the prepared identity on retry.
      await saveProductValue(pending.sourceKey, JSON.stringify(pending.input))
      if (token !== epoch) return
    }
    conflict = false
    error = ""
    for (const pending of queue)
      for (const edit of pending.input.edits) {
        const before = state.records.find(
          (record) => record.issue.id === edit.issueId
        )?.issue
        if (before)
          setOptimisticIssue(
            optimisticFor(before, edit.changes, edit.triageDecision)
          )
      }
    ready = true
  } catch (failure) {
    if (token === epoch)
      error =
        failure instanceof Error
          ? failure.message
          : "Edits could not be prepared. Your saved drafts are preserved."
  } finally {
    if (token === epoch) {
      running = false
      notify()
    }
  }
  if (ready && token === epoch) void flushIssueEdits()
}

export function changesBetween(
  before: TeamIssue,
  after: TeamIssue
): IssueChanges {
  const changes: Record<string, unknown> = {}
  for (const key of Object.keys(issueChangesSchema.shape)) {
    if (
      JSON.stringify(before[key as keyof TeamIssue]) !==
      JSON.stringify(after[key as keyof TeamIssue])
    )
      changes[key] = after[key as keyof TeamIssue]
  }
  if (
    JSON.stringify(before.comments) !== JSON.stringify(after.comments) ||
    JSON.stringify(before.reactions) !== JSON.stringify(after.reactions) ||
    before.subscribers !== after.subscribers
  )
    throw new Error(
      "Use the discussion and subscription controls to make this change."
    )
  return issueChangesSchema.parse(changes)
}

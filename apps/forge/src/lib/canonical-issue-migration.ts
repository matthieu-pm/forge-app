import {
  legacyIssueFingerprint,
  legacyProjectFingerprint,
} from "./canonical-issue-contract"
import { initiativeStoreSchema, initiativesStorageKey } from "./initiatives"
import { importCanonicalProjectState } from "./canonical-issue-state"
import {
  createSharedTeamIssue,
  refreshCanonicalIssues,
} from "./canonical-issue-client"
import { canonicalIssueState } from "./canonical-issue-cache"
import { getDefaultIssueStatus, readLocalIssueStore } from "./team-issues"
import {
  cycleIssueRecord,
  cycleIssuesKey,
  parseCycleIssues,
} from "./cycle-issues"
import { parseTriageIssues, triageIssuesKey } from "./triage-issues"
import { blankIssueDraft } from "./issue-record-contract"
import type { IssueDraft, TeamIssue } from "./issue-record-contract"
import { productStorage } from "@/lib/product-storage"

// Browser source records are preserved. The durable per-team legacy identity is
// the checkpoint, so reloads and other tabs can resume without duplicate writes.
export async function migrateLocalIssues(teamIds: Array<string>) {
  const failures: Array<string> = []
  const state = canonicalIssueState()
  if (state) {
    const raw = productStorage.getItem(initiativesStorageKey(state.workspaceId))
    if (raw)
      try {
        const sources = initiativeStoreSchema.parse(JSON.parse(raw))
        const projects = [
          ...new Map(
            [
              ...sources.workspaceProjects,
              ...sources.initiatives.flatMap((i) => i.projects),
            ].map((p) => [p.id, p])
          ).values(),
        ]
        for (const project of projects)
          if (
            !state.projects.some(
              (p) => p.id === project.id || p.legacyId === project.id
            )
          ) {
            try {
              await importCanonicalProjectState({
                data: {
                  workspaceId: state.workspaceId,
                  sessionId: state.sessionId,
                  commandKey: `legacy-project:${project.id}`,
                  project,
                },
              })
            } catch {
              failures.push(
                `${project.name}: this project could not be published. Its source copy is preserved on the server.`
              )
            }
          }
        for (const project of projects) {
          const existing = state.projects.find(
            (p) => p.id === project.id || p.legacyId === project.id
          )
          if (
            existing &&
            existing.properties.legacyFingerprint !==
              (await legacyProjectFingerprint(project))
          )
            failures.push(
              `${project.name}: a different shared version exists. This source snapshot is preserved on the server.`
            )
        }
        await refreshCanonicalIssues(state)
      } catch {
        failures.push(
          "Saved projects could not be read. Their source copies are preserved on the server."
        )
      }
  }
  for (const teamId of teamIds) {
    let records: Array<TeamIssue> = []
    try {
      const local = readLocalIssueStore(teamId).issues
      const cycle = parseCycleIssues(
        productStorage.getItem(cycleIssuesKey(teamId)) ?? "[]"
      ).map(cycleIssueRecord)
      const triage = parseTriageIssues(
        productStorage.getItem(triageIssuesKey(teamId)) ?? "[]"
      ).map((i) => ({
        ...blankIssueDraft(getDefaultIssueStatus(teamId)),
        ...i,
        triage: true,
        creator: "",
        updatedAt: i.createdAt,
        statusChangedAt: i.createdAt,
        suggestedLabel: "",
        completedAt: null,
        recurrenceSpawned: false,
      }))
      records = [
        ...new Map(
          [...cycle, ...triage, ...local].map((i) => [i.id, i])
        ).values(),
      ]
    } catch {
      failures.push(
        "Some saved issues could not be read. Their local data has been preserved."
      )
      continue
    }
    const pending = new Map(records.map((i) => [i.id, i]))
    while (pending.size) {
      const next = [...pending.values()].find(
        (i) => !i.parentId || !pending.has(i.parentId)
      )
      if (!next) {
        failures.push(
          "Some local issues have a circular parent relationship. Repair their local data before importing."
        )
        break
      }
      pending.delete(next.id)
      const existing = canonicalIssueState()?.records.find(
        (r) => r.teamId === teamId && r.legacyId === next.id
      )
      if (existing) {
        if (
          existing.issue.legacyFingerprint !==
          (await legacyIssueFingerprint(
            { ...next, subIssues: [] },
            next.assignee || null
          ))
        )
          failures.push(
            `${next.title}: a different shared version already exists. This source snapshot is preserved on the server.`
          )
        continue
      }
      try {
        const draft: IssueDraft = { ...next, subIssues: [] }
        await createSharedTeamIssue(teamId, draft, {
          commandKey: `legacy:${teamId}:${next.id}`,
          legacyId: next.id,
          assigneeId: next.assignee || null,
        })
      } catch (error) {
        failures.push(
          `${next.title}: ${error instanceof Error ? error.message : "Import failed."} The local copy is preserved.`
        )
      }
    }
  }
  return failures
}

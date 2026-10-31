import { useCallback, useMemo, useSyncExternalStore } from "react"
import { z } from "zod"
import {
  canonicalIssueEpoch,
  canonicalIssueRows,
  canonicalIssuesActive,
} from "./canonical-issue-cache"
import { createSharedTeamIssue } from "./canonical-issue-client"
import { blankIssueDraft } from "./issue-record-contract"
import {
  getDefaultIssueStatus,
  readIssueStore,
  saveTeamIssue,
} from "./team-issues"
import { triageDraftSchema, triagePriorities } from "./triage-record-contract"
import type { TeamIssue } from "./issue-record-contract"
import type { TriageDraft } from "./triage-record-contract"

export { triagePriorities, triageDraftSchema } from "./triage-record-contract"
export type { TriageDraft } from "./triage-record-contract"

export const triageDraftKey = (teamId: string) =>
  `forge:triage-draft:v1:${teamId}`
const schema = triageDraftSchema.extend({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(10000),
  priority: z.enum(triagePriorities),
  dueDate: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/),
  snoozed: z.boolean(),
  createdAt: z.string().datetime(),
})
export type TriageIssue = z.infer<typeof schema>
export const triageIssuesKey = (teamId: string) =>
  `forge:triage-issues:v1:${teamId}`
export const parseTriageIssues = (raw: string) =>
  z.array(schema).parse(JSON.parse(raw))
const changed = "forge:triage-issues-changed"
const pendingTriage = new Map<string, { signature: string; key: string }>()

export function useTriageIssues(teamId: string) {
  const raw = useSyncExternalStore(
    useCallback((notify) => {
      window.addEventListener("storage", notify)
      window.addEventListener(changed, notify)
      window.addEventListener("forge:team-issues-changed", notify)
      return () => {
        window.removeEventListener("storage", notify)
        window.removeEventListener(changed, notify)
        window.removeEventListener("forge:team-issues-changed", notify)
      }
    }, []),
    () => {
      try {
        if (canonicalIssuesActive())
          return JSON.stringify(
            canonicalIssueRows(teamId)
              .filter((r) => r.issue.triage)
              .map((r) => ({ ...r.issue, snoozed: r.issue.snoozed }))
          )
        return "unavailable"
      } catch {
        return "unavailable"
      }
    },
    () => "[]"
  )
  const state = useMemo(() => {
    try {
      return { issues: parseTriageIssues(raw), error: null }
    } catch {
      return {
        issues: [],
        error:
          "Shared triage could not be loaded. Reload to try again. Your saved data has been preserved.",
      }
    }
  }, [raw])
  async function save(
    draft: TriageDraft,
    id?: string,
    snoozed?: boolean,
    baseline?: TeamIssue
  ) {
    if (canonicalIssuesActive()) {
      if (id) {
        const old = readIssueStore(teamId).issues.find((i) => i.id === id)
        if (!old) throw new Error("This issue is no longer available.")
        const updated = saveTeamIssue(
          teamId,
          { ...(baseline ?? old), ...draft, snoozed: snoozed ?? old.snoozed },
          { id, baseline: baseline ?? old }
        )
        return schema.parse(updated)
      }
      const signature = JSON.stringify({ draft, epoch: canonicalIssueEpoch() })
      if (pendingTriage.get(teamId)?.signature !== signature)
        pendingTriage.set(teamId, { signature, key: crypto.randomUUID() })
      const issue = await createSharedTeamIssue(
        teamId,
        {
          ...blankIssueDraft(getDefaultIssueStatus(teamId)),
          ...draft,
          triage: true,
          snoozed: false,
        },
        { commandKey: pendingTriage.get(teamId)!.key }
      )
      pendingTriage.delete(teamId)
      return schema.parse({ ...issue, snoozed: false })
    }
    throw new Error("Shared triage is unavailable. Reload to try again.")
  }
  return { ...state, save }
}

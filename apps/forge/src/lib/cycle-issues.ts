import { useCallback, useMemo, useSyncExternalStore } from "react"
import { z } from "zod"
import {
  ISSUES_CHANGED,
  blankIssueDraft,
  getIssueStatuses,
  issueDraftSchema,
  parseIssueStore,
  readIssueStore,
  saveTeamIssue,
  spawnRecurringIssues,
  teamIssuesKey,
  writeIssueStore,
} from "./team-issues"
import type { IssueDraft, TeamIssue } from "./team-issues"

const issueSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  cycle: z.string().min(1),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(10000),
  status: z.string().min(1),
  priority: z.enum(["No priority", "Urgent", "High", "Medium", "Low"]),
  createdAt: z.string().datetime(),
})
export type CycleIssue = z.infer<typeof issueSchema>
export type CycleIssueDraft = Pick<
  CycleIssue,
  "title" | "description" | "status" | "priority"
>
export const cycleIssuesKey = (teamId: string) =>
  `forge:cycle-issues:v1:${teamId}`
export const parseCycleIssues = (raw: string) =>
  z.array(issueSchema).parse(JSON.parse(raw))
const eventName = "forge:cycle-issues-changed"

// Older cycle-only records receive the same row shape without rewriting saved data.
export function cycleIssueRecord(issue: CycleIssue): TeamIssue {
  return {
    ...blankIssueDraft(issue.status),
    ...issue,
    updatedAt: issue.createdAt,
    statusChangedAt: issue.createdAt,
    creator: "",
    suggestedLabel: "",
    completedAt: null,
    recurrenceSpawned: false,
  }
}
export function patchCycleIssues(
  teamId: string,
  cycle: string,
  ids: Array<string>,
  patch: Partial<IssueDraft>
) {
  const legacy = parseCycleIssues(
    localStorage.getItem(cycleIssuesKey(teamId)) ?? "[]"
  )
  const statuses = getIssueStatuses(teamId)
  if (patch.status && !statuses.some((status) => status.id === patch.status))
    throw new Error("Choose a status from this team's workflow.")
  const unique = [...new Set(ids)]
  if (unique.length === 1) {
    const canonical = readIssueStore(teamId).issues.find(
      (issue) => issue.id === unique[0]
    )
    if (canonical) {
      if (canonical.cycle !== cycle)
        throw new Error(
          "This issue is no longer in this cycle. Reload and try again."
        )
      return saveTeamIssue(
        teamId,
        {
          ...canonical,
          ...patch,
          descriptionDoc:
            patch.description !== undefined &&
            patch.description !== canonical.description
              ? null
              : canonical.descriptionDoc,
        },
        { id: canonical.id }
      )
    }
  }
  const now = new Date().toISOString()
  return writeIssueStore(teamId, (state) => {
    const updated = new Map<string, TeamIssue>()
    for (const id of new Set(ids)) {
      const canonical = state.issues.find((issue) => issue.id === id)
      const source = canonical ?? legacy.find((issue) => issue.id === id)
      if (!source || source.cycle !== cycle)
        throw new Error(
          "This issue is no longer in this cycle. Reload and try again."
        )
      const issue = canonical ?? cycleIssueRecord(source)
      const draft = issueDraftSchema.parse({ ...issue, ...patch })
      const status = statuses.find((value) => value.id === draft.status)
      updated.set(id, {
        ...issue,
        ...draft,
        updatedAt: now,
        statusChangedAt:
          draft.status !== issue.status ? now : issue.statusChangedAt,
        completedAt:
          status?.group === "completed" ? (issue.completedAt ?? now) : null,
        descriptionDoc:
          draft.description === issue.description ? draft.descriptionDoc : null,
        activity: [
          ...issue.activity,
          ...(
            [
              "status",
              "priority",
              "assignee",
              "labels",
              "project",
              "cycle",
            ] as const
          )
            .filter(
              (field) =>
                patch[field] !== undefined && patch[field] !== issue[field]
            )
            .map((field) => ({
              id: crypto.randomUUID(),
              author: "You",
              createdAt: now,
              field,
              from: issue[field] ?? "",
              to: draft[field] ?? "",
              text:
                field === "status"
                  ? `changed status to ${status?.name ?? draft.status}`
                  : `updated ${field}`,
            })),
        ],
      })
    }
    const added = [...updated.values()].filter(
      (issue) => !state.issues.some((value) => value.id === issue.id)
    )
    return spawnRecurringIssues(
      {
        ...state,
        issues: [
          ...state.issues.map((issue) => updated.get(issue.id) ?? issue),
          ...added,
        ],
        nextNumber: Math.max(
          state.nextNumber,
          ...added.map((issue) => issue.number + 1)
        ),
      },
      statuses,
      now
    )
  })
}

export function useCycleIssues(teamId: string, cycle: string) {
  const key = cycleIssuesKey(teamId)
  const raw = useSyncExternalStore(
    useCallback((notify) => {
      window.addEventListener("storage", notify)
      window.addEventListener(eventName, notify)
      window.addEventListener(ISSUES_CHANGED, notify)
      return () => {
        window.removeEventListener("storage", notify)
        window.removeEventListener(eventName, notify)
        window.removeEventListener(ISSUES_CHANGED, notify)
      }
    }, []),
    () => {
      try {
        return JSON.stringify([
          localStorage.getItem(key) ?? "[]",
          localStorage.getItem(teamIssuesKey(teamId)),
        ])
      } catch {
        return "unavailable"
      }
    },
    () => '["[]",null]'
  )
  const { records, error } = useMemo(() => {
    try {
      const [legacyRaw, canonicalRaw] = JSON.parse(raw) as [
        string,
        string | null,
      ]
      const legacy = parseCycleIssues(legacyRaw)
      const canonical = canonicalRaw ? parseIssueStore(canonicalRaw).issues : []
      // An issue moved out of a cycle must also suppress its older cycle snapshot.
      const canonicalIds = new Set(canonical.map((issue) => issue.id))
      return {
        records: [
          ...legacy
            .filter((issue) => !canonicalIds.has(issue.id))
            .map(cycleIssueRecord),
          ...canonical,
        ].filter((issue) => issue.cycle === cycle),
        error: null,
      }
    } catch {
      return {
        records: [],
        error:
          "Saved cycle issues could not be loaded. Your saved data has been preserved.",
      }
    }
  }, [raw, cycle])

  function save(draft: CycleIssueDraft, id?: string) {
    if (error) throw new Error(error)
    if (id) {
      const canonical = readIssueStore(teamId).issues.find(
        (issue) => issue.id === id
      )
      if (canonical) {
        if (canonical.cycle !== cycle)
          throw new Error(
            "This issue has moved to another cycle. Reload and try again."
          )
        return issueSchema.parse(
          saveTeamIssue(
            teamId,
            {
              ...canonical,
              ...draft,
              descriptionDoc:
                draft.description === canonical.description
                  ? canonical.descriptionDoc
                  : null,
            },
            { id }
          )
        )
      }
    }
    // Re-read before writing so another window's latest issues are preserved.
    const current = parseCycleIssues(localStorage.getItem(key) ?? "[]")
    const previous = id
      ? current.find((issue) => issue.id === id && issue.cycle === cycle)
      : undefined
    if (id && !previous)
      throw new Error(
        "This issue is no longer available. Reload and try again."
      )
    const issue = issueSchema.parse({
      ...previous,
      ...draft,
      id: previous?.id ?? crypto.randomUUID(),
      number:
        previous?.number ??
        Math.max(0, ...current.map((item) => item.number)) + 1,
      cycle,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    })
    localStorage.setItem(
      key,
      JSON.stringify(
        previous
          ? current.map((item) => (item.id === id ? issue : item))
          : [...current, issue]
      )
    )
    window.dispatchEvent(new Event(eventName))
    return issue
  }
  return {
    issues: records.map((issue) => issueSchema.parse(issue)),
    records,
    error,
    save,
    patch: (ids: Array<string>, changes: Partial<IssueDraft>) => {
      if (error) throw new Error(error)
      return patchCycleIssues(teamId, cycle, ids, changes)
    },
  }
}

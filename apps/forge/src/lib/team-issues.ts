import type { IssueChanges } from "./canonical-issue-edit-contract"
import {
  changesBetween,
  enqueueIssueEdits,
} from "./canonical-issue-edit-client"
import { useCallback, useMemo, useSyncExternalStore } from "react"
import { z } from "zod"
import {
  canonicalIssueRows,
  canonicalIssuesActive,
  projectDisplayName,
} from "./canonical-issue-cache"
import {
  cachedDefinitions,
  sharedDefinitionsActive,
  sharedIssueLabels,
} from "./issue-definition-cache"
import { canTransition } from "./issue-definition-contract"
import {
  defaultIssueDisplay,
  displaySchema,
  emptyIssueFilters,
  filtersSchema,
} from "./issue-view-contract"
import {
  blankIssueDraft,
  issueDraftSchema,
  issueSchema,
} from "./issue-record-contract"
import type { TeamStatus } from "@/lib/team-statuses"
import type {
  IssueDisplay,
  IssueField,
  IssueFilters,
} from "./issue-view-contract"
import type { IssueDraft, TeamIssue } from "./issue-record-contract"
import {
  initialTeamStatuses,
  parseTeamStatuses,
  teamStatusesStorageKey,
} from "@/lib/team-statuses"
import { issuePullRequests } from "@/lib/issue-pull-requests"
import { triagePriorities } from "@/lib/triage-record-contract"
import { productStorage } from "@/lib/product-storage"

export { triagePriorities as issuePriorities }
export * from "./issue-view-contract"
export {
  issueDraftSchema,
  blankIssueDraft,
  issueSchema,
} from "./issue-record-contract"
export type { IssueDraft, TeamIssue } from "./issue-record-contract"
const viewSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(60),
  scope: z.enum(["active", "backlog", "all"]),
  filters: filtersSchema,
  display: displaySchema,
})
export type IssueView = z.infer<typeof viewSchema>
const storeSchema = z.object({
  version: z.literal(1),
  issues: z.array(issueSchema),
  drafts: z.array(
    z.object({ id: z.string(), draft: issueDraftSchema, updatedAt: z.string() })
  ),
  views: z.array(viewSchema),
  display: displaySchema,
  defaultDisplay: displaySchema,
  filters: filtersSchema,
  favorite: z.boolean(),
  notifications: z.array(z.string()),
  nextNumber: z.number().int().positive(),
})
export type IssueStore = z.infer<typeof storeSchema>
export const initialIssueStore = (): IssueStore => ({
  version: 1,
  issues: [],
  drafts: [],
  views: [],
  display: defaultIssueDisplay(),
  defaultDisplay: defaultIssueDisplay(),
  filters: emptyIssueFilters(),
  favorite: false,
  notifications: [],
  nextNumber: 1,
})
export const teamIssuesKey = (teamId: string) =>
  `forge:team-issues:v1:${teamId}`
export const parseIssueStore = (raw: string) =>
  storeSchema.parse(JSON.parse(raw))
export const ISSUES_CHANGED = "forge:team-issues-changed"
export function readLocalIssueStore(teamId: string): IssueStore {
  const raw = productStorage.getItem(teamIssuesKey(teamId))
  return raw ? parseIssueStore(raw) : initialIssueStore()
}
export function readIssueStore(teamId: string): IssueStore {
  const local = readLocalIssueStore(teamId)
  if (!canonicalIssuesActive()) return local
  const records = canonicalIssueRows(teamId)
  const rawFavorites = productStorage.getItem(
    `forge:team-issue-favorites:v1:${teamId}`
  )
  const favorites = new Set<string>(
    rawFavorites
      ? JSON.parse(rawFavorites)
      : records
          .filter((r) =>
            local.issues.some((i) => i.id === r.legacyId && i.favorite)
          )
          .map((r) => r.issue.id)
  )
  return {
    ...local,
    issues: records.map((r) => ({
      ...r.issue,
      favorite: favorites.has(r.issue.id),
    })),
  }
}
export function issueStoreSnapshot(teamId: string) {
  if (!canonicalIssuesActive())
    return productStorage.getItem(teamIssuesKey(teamId)) ?? ""
  return JSON.stringify(readIssueStore(teamId))
}
export function writeIssueStore(
  teamId: string,
  update: (current: IssueStore) => IssueStore
) {
  const previous = readIssueStore(teamId)
  const next = storeSchema.parse(update(previous))
  const canonicalEdits: Array<{ before: TeamIssue; changes: IssueChanges }> = []
  if (canonicalIssuesActive()) {
    for (const old of previous.issues) {
      const changed = next.issues.find((i) => i.id === old.id)
      if (!changed)
        throw new Error("Deleting shared issues is not available yet.")
      const changes = changesBetween(old, changed)
      if (Object.keys(changes).length)
        canonicalEdits.push({ before: old, changes })
    }
    const known = new Set(previous.issues.map((i) => i.id))
    if (next.issues.some((i) => !known.has(i.id)))
      throw new Error("Create shared issues through the issue composer.")
  }
  if (sharedDefinitionsActive()) {
    const definitions = cachedDefinitions(teamId).value
    const labels = sharedIssueLabels(teamId).labels.filter((l) => !l.archived)
    for (const issue of next.issues) {
      const old = previous.issues.find((i) => i.id === issue.id)
      if (!old || old.status !== issue.status) {
        if (!definitions.statuses.statuses.some((s) => s.id === issue.status))
          throw new Error("Choose a status from this team's workflow.")
        if (
          old &&
          !canTransition(definitions.transitions, old.status, issue.status)
        )
          throw new Error(
            "This status transition is not allowed by the team workflow."
          )
      }
      const added = (issue.labels ?? "")
        .split(",")
        .map((l) => l.trim())
        .filter(
          (l) =>
            l &&
            !(old?.labels ?? "")
              .split(",")
              .map((n) => n.trim())
              .includes(l)
        )
      if (added.some((name) => !labels.some((l) => l.name === name)))
        throw new Error("Choose active labels available to this team.")
    }
  }
  if (
    canonicalIssuesActive() &&
    next.issues.some(
      (i) => i.favorite !== previous.issues.find((p) => p.id === i.id)?.favorite
    )
  )
    productStorage.setItem(
      `forge:team-issue-favorites:v1:${teamId}`,
      JSON.stringify(next.issues.filter((i) => i.favorite).map((i) => i.id))
    )
  if (canonicalEdits.length) enqueueIssueEdits(teamId, canonicalEdits)
  const local = canonicalIssuesActive()
    ? {
        ...next,
        issues: readLocalIssueStore(teamId).issues.map(
          (old) => next.issues.find((i) => i.id === old.id) ?? old
        ),
      }
    : next
  productStorage.setItem(teamIssuesKey(teamId), JSON.stringify(local))
  window.dispatchEvent(new Event(ISSUES_CHANGED))
  return next
}
export function getIssueStatuses(teamId: string): Array<TeamStatus> {
  if (sharedDefinitionsActive())
    return cachedDefinitions(teamId).value.statuses.statuses
  const raw = productStorage.getItem(teamStatusesStorageKey(teamId))
  return (raw ? parseTeamStatuses(raw) : initialTeamStatuses()).statuses
}
export function saveTeamIssue(
  teamId: string,
  draft: IssueDraft,
  options: {
    id?: string
    draftId?: string
    creator?: string
    baseline?: TeamIssue
  } = {}
) {
  if (canonicalIssuesActive() && !options.id)
    throw new Error("Create shared issues through the issue composer.")
  if (canonicalIssuesActive() && options.id) {
    const current = readIssueStore(teamId).issues.find(
      (i) => i.id === options.id
    )
    if (!current) throw new Error("This issue is no longer available.")
    const before = options.baseline ?? current
    const next = issueSchema.parse({
      ...before,
      ...draft,
      title: draft.title.trim(),
    })
    const changes = changesBetween(before, next)
    if (before.favorite !== next.favorite) {
      const favorites = readIssueStore(teamId)
        .issues.filter((i) => (i.id === before.id ? next.favorite : i.favorite))
        .map((i) => i.id)
      productStorage.setItem(
        `forge:team-issue-favorites:v1:${teamId}`,
        JSON.stringify(favorites)
      )
    }
    if (Object.keys(changes).length)
      enqueueIssueEdits(teamId, [{ before, changes }])
    return readIssueStore(teamId).issues.find((i) => i.id === before.id)!
  }
  let saved: TeamIssue | undefined
  const statuses = getIssueStatuses(teamId)
  const status = statuses.find((item) => item.id === draft.status)
  if (!status) throw new Error("Choose a status from this team’s workflow.")
  writeIssueStore(teamId, (store) => {
    const previous = store.issues.find((issue) => issue.id === options.id)
    if (options.id && !previous)
      throw new Error(
        "This issue is no longer available. Reload and try again."
      )
    if (
      draft.parentId &&
      !store.issues.some((issue) => issue.id === draft.parentId)
    )
      throw new Error("The parent issue is no longer available.")
    const now = new Date().toISOString()
    const completed = status.group === "completed"
    const beforeRequests = issuePullRequests(previous?.links ?? [])
    const afterRequests = issuePullRequests(draft.links)
    const requestActivity = [
      ...afterRequests
        .filter(
          (request) => !beforeRequests.some((item) => item.key === request.key)
        )
        .map((request) => ({ request, action: "linked" as const })),
      ...beforeRequests
        .filter(
          (request) => !afterRequests.some((item) => item.key === request.key)
        )
        .map((request) => ({ request, action: "unlinked" as const })),
    ].map(({ request, action }) => ({
      id: crypto.randomUUID(),
      author: options.creator ?? "You",
      createdAt: now,
      text: `${action} ${request.title}`,
      linkAction: action,
      link: {
        title: request.title,
        url: request.url,
        pullRequest: request.pullRequest,
      },
    }))
    saved = issueSchema.parse({
      ...draft,
      subIssues: [],
      id: previous?.id ?? crypto.randomUUID(),
      number: previous?.number ?? store.nextNumber,
      title: draft.title.trim(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      statusChangedAt:
        previous?.status === draft.status ? previous.statusChangedAt : now,
      creator: previous?.creator ?? options.creator ?? "You",
      subscribers:
        previous?.subscribers ?? (draft.subscribers || options.creator || ""),
      suggestedLabel: /bug|broken|error|crash|test issue/i.test(
        `${draft.title} ${draft.description}`
      )
        ? "Bug"
        : "",
      completedAt: completed ? (previous?.completedAt ?? now) : null,
      recurrenceSpawned: previous?.recurrenceSpawned ?? false,
      activity: previous
        ? [
            ...previous.activity,
            ...requestActivity,
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
                (field) => (previous[field] ?? "") !== (draft[field] ?? "")
              )
              .map((field) => ({
                id: crypto.randomUUID(),
                author: options.creator ?? "You",
                createdAt: now,
                field,
                from: previous[field] ?? "",
                to: draft[field] ?? "",
                text:
                  field === "status"
                    ? `changed status to ${status.name}`
                    : field === "priority"
                      ? `set priority to ${draft.priority}`
                      : field === "project"
                        ? draft.project
                          ? `added to project ${draft.project}`
                          : "removed the project"
                        : field === "cycle"
                          ? draft.cycle
                            ? `added to the cycle starting ${draft.cycle}`
                            : "removed from the cycle"
                          : `updated ${field}`,
              })),
          ]
        : [...draft.activity, ...requestActivity],
    })
    let nextNumber = options.id ? store.nextNumber : store.nextNumber + 1
    const children = draft.subIssues.map((title) =>
      issueSchema.parse({
        ...blankIssueDraft(draft.status),
        id: crypto.randomUUID(),
        number: nextNumber++,
        title,
        parentId: saved!.id,
        createdAt: now,
        updatedAt: now,
        statusChangedAt: now,
        creator: options.creator ?? "You",
        suggestedLabel: "",
        completedAt: completed ? now : null,
      })
    )
    return spawnRecurringIssues(
      {
        ...store,
        nextNumber,
        drafts: store.drafts.filter((item) => item.id !== options.draftId),
        issues: [
          ...(previous
            ? store.issues.map((item) =>
                item.id === previous.id ? saved! : item
              )
            : [...store.issues, saved]),
          ...children,
        ],
      },
      statuses,
      now
    )
  })
  return saved!
}
export function moveTeamIssue(
  sourceId: string,
  targetId: string,
  issueId: string
) {
  if (canonicalIssuesActive())
    throw new Error("Moving shared issues between teams is not available yet.")
  if (sourceId === targetId) return
  const source = readIssueStore(sourceId)
  const root = source.issues.find((issue) => issue.id === issueId)
  if (!root) throw new Error("Issue no longer exists")
  const ids = new Set([issueId])
  let size = 0
  while (size !== ids.size) {
    size = ids.size
    source.issues.forEach((issue) => {
      if (ids.has(issue.parentId)) ids.add(issue.id)
    })
  }
  const before = readIssueStore(targetId)
  const fromStatuses = getIssueStatuses(sourceId)
  const toStatuses = getIssueStatuses(targetId)
  writeIssueStore(targetId, (target) => {
    if (target.issues.some((issue) => ids.has(issue.id)))
      throw new Error("Issue already exists in that team")
    const moved = source.issues
      .filter((issue) => ids.has(issue.id))
      .map((issue, index) => {
        const from = fromStatuses.find((status) => status.id === issue.status)
        const nextStatus =
          toStatuses.find((status) => status.name === from?.name) ??
          toStatuses.find((status) => status.group === from?.group) ??
          toStatuses[0]
        return {
          ...issue,
          parentId: issue.id === issueId ? "" : issue.parentId,
          cycle: "",
          number: target.nextNumber + index,
          status: nextStatus.id,
        }
      })
    return {
      ...target,
      issues: [...target.issues, ...moved],
      nextNumber: target.nextNumber + moved.length,
    }
  })
  try {
    writeIssueStore(sourceId, (store) => ({
      ...store,
      issues: store.issues.filter((issue) => !ids.has(issue.id)),
    }))
  } catch (error) {
    writeIssueStore(targetId, () => before)
    throw error
  }
}

export function spawnRecurringIssues(
  store: IssueStore,
  statuses: Array<TeamStatus>,
  now: string
): IssueStore {
  if (canonicalIssuesActive()) return store
  const pending =
    statuses.find((status) => status.group === "unstarted") ??
    statuses.find((status) => status.group === "backlog")
  if (!pending) return store
  let nextNumber = store.nextNumber
  const additions: Array<TeamIssue> = []
  const issues = store.issues.map((issue) => {
    if (!issue.recurrence || !issue.completedAt || issue.recurrenceSpawned)
      return issue
    const date = new Date(`${issue.dueDate || now.slice(0, 10)}T12:00:00Z`)
    if (issue.recurrence === "monthly") {
      const day = date.getUTCDate()
      date.setUTCDate(1)
      date.setUTCMonth(date.getUTCMonth() + 1)
      const end = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
      ).getUTCDate()
      date.setUTCDate(Math.min(day, end))
    } else
      date.setUTCDate(
        date.getUTCDate() + (issue.recurrence === "weekly" ? 7 : 1)
      )
    additions.push({
      ...issue,
      id: crypto.randomUUID(),
      number: nextNumber++,
      status: pending.id,
      dueDate: date.toISOString().slice(0, 10),
      completedAt: null,
      recurrenceSpawned: false,
      comments: [],
      reactions: [],
      activity: [],
      favorite: false,
      createdAt: now,
      updatedAt: now,
      statusChangedAt: now,
    })
    return { ...issue, recurrenceSpawned: true }
  })
  return { ...store, nextNumber, issues: [...issues, ...additions] }
}
export function saveIssueDraft(
  teamId: string,
  draft: IssueDraft,
  id: string = crypto.randomUUID()
) {
  writeIssueStore(teamId, (store) => ({
    ...store,
    drafts: [
      ...store.drafts.filter((item) => item.id !== id),
      {
        id,
        draft: issueDraftSchema.parse(draft),
        updatedAt: new Date().toISOString(),
      },
    ],
  }))
  return id
}
export function useIssueStore(teamId: string) {
  const subscribe = useCallback((notify: () => void) => {
    window.addEventListener("storage", notify)
    window.addEventListener(ISSUES_CHANGED, notify)
    return () => {
      window.removeEventListener("storage", notify)
      window.removeEventListener(ISSUES_CHANGED, notify)
    }
  }, [])
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return issueStoreSnapshot(teamId)
      } catch {
        return "unavailable"
      }
    },
    () => ""
  )
  return useMemo(() => {
    try {
      return {
        store: raw ? parseIssueStore(raw) : initialIssueStore(),
        error: null,
      }
    } catch {
      return {
        store: initialIssueStore(),
        error:
          "Saved issues could not be loaded. Your saved data has been preserved.",
      }
    }
  }, [raw])
}
export function issueFieldValue(issue: TeamIssue, field: IssueField): string {
  if (field === "content") return `${issue.title}\n${issue.description}`
  if (field === "links")
    return issue.links.map((link) => `${link.title} ${link.url}`).join(",")
  if (field === "autoClosed") return issue.autoClosed ? "Yes" : "No"
  if (field === "createdAt" || field === "updatedAt")
    return issue[field].slice(0, 10)
  return issue[field] ?? ""
}
export function matchesIssueFilters(issue: TeamIssue, filters: IssueFilters) {
  const results = filters.rules.map((rule) => {
    const value = issueFieldValue(issue, rule.field).trim().toLocaleLowerCase()
    const expected = rule.value.trim().toLocaleLowerCase()
    const parts = ["labels", "subscribers"].includes(rule.field)
      ? value.split(",").map((part) => part.trim())
      : [value]
    switch (rule.operator) {
      case "is":
        return parts.includes(expected)
      case "isNot":
        return !parts.includes(expected)
      case "contains":
        return value.includes(expected)
      case "notContains":
        return !value.includes(expected)
      case "set":
        return Boolean(value)
      case "notSet":
        return !value
      case "before":
        return Boolean(value) && value < expected
      case "after":
        return Boolean(value) && value > expected
    }
  })
  return (
    !results.length ||
    (filters.match === "all" ? results.every(Boolean) : results.some(Boolean))
  )
}
export function issueInScope(
  issue: TeamIssue,
  scope: string,
  statuses: Array<TeamStatus>
) {
  const group = statuses.find((status) => status.id === issue.status)?.group
  return (
    scope === "all" ||
    (scope === "backlog"
      ? group === "backlog"
      : group === "unstarted" || group === "started")
  )
}
export function visibleIssues(
  issues: Array<TeamIssue>,
  scope: string,
  statuses: Array<TeamStatus>,
  filters: IssueFilters,
  display: IssueDisplay
) {
  const selected = issues.filter(
    (issue) =>
      issueInScope(issue, scope, statuses) &&
      matchesIssueFilters(issue, filters) &&
      (display.showSubIssues || !issue.parentId)
  )
  const included = new Set(selected.map((issue) => issue.id))
  if (display.showSubIssues && display.nested === "Show all") {
    let added = true
    while (added) {
      added = false
      for (const issue of issues)
        if (!included.has(issue.id) && included.has(issue.parentId)) {
          included.add(issue.id)
          added = true
        }
    }
  }
  const visible = issues.filter((issue) => included.has(issue.id))
  return [...visible].sort((a, b) => {
    if (display.completedByRecency && a.completedAt && b.completedAt)
      return b.completedAt.localeCompare(a.completedAt)
    let order = 0
    if (display.order === "Priority") {
      const rank = { Urgent: 0, High: 1, Medium: 2, Low: 3, "No priority": 4 }
      order = rank[a.priority] - rank[b.priority]
    } else if (display.order === "Status")
      order =
        statuses.findIndex((item) => item.id === a.status) -
        statuses.findIndex((item) => item.id === b.status)
    else {
      const key = {
        Created: "createdAt",
        Updated: "updatedAt",
        "Due date": "dueDate",
        Title: "title",
      }[display.order] as "createdAt" | "updatedAt" | "dueDate" | "title"
      order = (a[key] || "\uffff").localeCompare(b[key] || "\uffff")
    }
    return (display.descending ? -order : order) || a.number - b.number
  })
}
export function issueGroupValue(
  issue: TeamIssue,
  group: IssueDisplay["group"],
  statuses: Array<TeamStatus>,
  members: Array<{ id: string; name: string }>
) {
  if (group === "Status")
    return (
      statuses.find((status) => status.id === issue.status)?.name ??
      issue.status
    )
  if (group === "Priority") return issue.priority
  if (group === "Assignee")
    return (
      members.find((member) => member.id === issue.assignee)?.name ??
      (issue.assignee || "Unassigned")
    )
  if (group === "Project")
    return issue.project ? projectDisplayName(issue.project) : "No project"
  if (group === "Labels")
    return issue.labels?.split(",")[0]?.trim() || "No label"
  return "All issues"
}

export function getDefaultIssueStatus(teamId: string) {
  if (sharedDefinitionsActive())
    return cachedDefinitions(teamId).value.statuses.defaultId
  const raw = productStorage.getItem(teamStatusesStorageKey(teamId))
  return (raw ? parseTeamStatuses(raw) : initialTeamStatuses()).defaultId
}

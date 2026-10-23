import { z } from "zod"
import type { InboxEntry } from "./inbox-state"

export const inboxPreferencesSchema = z.object({
  priorityEnabled: z.boolean().default(false),
  priorityInclude: z.enum(["all", "direct", "mentions"]).default("all"),
  badgeCount: z.enum(["all", "priority", "none"]).default("all"),
  groupBy: z.enum(["none", "project", "type"]).default("none"),
  ordering: z.enum(["newest", "oldest"]).default("newest"),
  showSnoozed: z.boolean().default(false),
  unreadFirst: z.boolean().default(false),
})
export type InboxPreferences = z.infer<typeof inboxPreferencesSchema>
export const defaultInboxPreferences = inboxPreferencesSchema.parse({})
export type InboxFilters = Record<
  "type" | "from" | "project" | "priority" | "status",
  Array<string>
>
export const emptyInboxFilters = (): InboxFilters => ({
  type: [],
  from: [],
  project: [],
  priority: [],
  status: [],
})
export const notificationTypes = [
  { value: "assignment", label: "Assignments" },
  { value: "mention", label: "Mentions" },
  { value: "comment", label: "Comments" },
  { value: "status", label: "Status changes" },
  { value: "system", label: "System notifications" },
]
export const inboxStatusTypes = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
] as const
export function inboxStatus(entry: InboxEntry): string {
  if (!entry.issue) return ""
  if (entry.issue.statusType) return entry.issue.statusType
  const status = entry.issue.status.toLowerCase()
  if (inboxStatusTypes.includes(status as (typeof inboxStatusTypes)[number]))
    return status
  if (["todo", "to do", "open"].includes(status)) return "unstarted"
  if (["in progress", "in review"].includes(status)) return "started"
  if (["done", "closed"].includes(status)) return "completed"
  if (status === "cancelled") return "canceled"
  return status
}
export function matchesInboxFilters(
  entry: InboxEntry,
  filters: InboxFilters
): boolean {
  const includes = (values: Array<string>, value: string) =>
    !values.length || values.includes(value)
  return (
    (entry.issue
      ? entry.events.some(
          (event) =>
            includes(filters.type, event.kind) &&
            includes(filters.from, event.actorId)
        )
      : includes(filters.type, "system") && !filters.from.length) &&
    includes(filters.project, entry.issue?.project ?? "") &&
    (!filters.priority.length ||
      (!!entry.issue &&
        includes(
          filters.priority,
          entry.issue.priority.toLowerCase() || "no priority"
        ))) &&
    includes(filters.status, inboxStatus(entry))
  )
}
export function isPriorityEntry(
  entry: InboxEntry,
  preferences: InboxPreferences
): boolean {
  if (preferences.priorityInclude === "all") return true
  return entry.events.some(
    (event) =>
      event.kind === "mention" ||
      (preferences.priorityInclude === "direct" && event.kind === "assignment")
  )
}
export function inboxGroup(
  entry: InboxEntry,
  groupBy: InboxPreferences["groupBy"]
): string {
  if (groupBy === "none") return ""
  if (!entry.unread) return "Read"
  if (groupBy === "project") return entry.issue?.project ?? "No project"
  return notificationTypes.find(
    (type) => type.value === (entry.events.at(-1)?.kind ?? "system")
  )!.label
}
/** Flatten groups once so keyboard traversal and visual order always agree. */
export function arrangeInbox(
  entries: Array<InboxEntry>,
  preferences: InboxPreferences
): Array<InboxEntry> {
  const ordered = [...entries].sort((a, b) => {
    if (preferences.unreadFirst || preferences.groupBy !== "none") {
      const unread = Number(b.unread) - Number(a.unread)
      if (unread) return unread
    }
    const time = (b.events.at(-1)?.createdAt ?? "").localeCompare(
      a.events.at(-1)?.createdAt ?? ""
    )
    return preferences.ordering === "oldest" ? -time : time
  })
  if (preferences.groupBy === "none") return ordered
  const groups = new Map<string, Array<InboxEntry>>()
  for (const entry of ordered) {
    const group = inboxGroup(entry, preferences.groupBy)
    groups.set(group, [...(groups.get(group) ?? []), entry])
  }
  return [...groups.values()].flat()
}

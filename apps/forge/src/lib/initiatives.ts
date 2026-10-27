import { z } from "zod"
import { documentSchema } from "./template-contract"
import { projectUpdateScheduleSchema } from "./project-updates-settings"

export const initiativeStatuses = [
  "Proposed",
  "Planned",
  "Active",
  "Completed",
  "Canceled",
] as const
export const initiativePriorities = [
  "No priority",
  "Urgent",
  "High",
  "Medium",
  "Low",
] as const
export const initiativeHealthValues = [
  "On track",
  "At risk",
  "Off track",
  "Update missing",
] as const
export type InitiativeView = "active" | "planned" | "all"

export function validInitiativeTarget(value: string) {
  if (!value) return true
  if (/^\d{4}(-(Q[1-4]|H[12]))?$/.test(value)) return true
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return true
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  )
}
const iconSchema = z.object({
  kind: z.enum(["icon", "emoji"]),
  value: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
})
const attachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  data: z
    .string()
    .regex(/^data:/)
    .max(3_000_000),
})
const reactionSchema = z.object({
  emoji: z.string().max(20),
  userIds: z.array(z.string()),
})
export const initiativeCommentSchema = z.object({
  id: z.string(),
  text: z.string().trim().min(1).max(20000),
  authorId: z.string(),
  createdAt: z.string().datetime(),
  attachments: z.array(attachmentSchema).default([]),
  reactions: z.array(reactionSchema).default([]),
})
export const initiativeUpdatesSchema = z.array(
  z.object({
    id: z.string(),
    text: z.string().trim().min(1).max(20000),
    health: z.enum(["On track", "At risk", "Off track"]),
    authorId: z.string(),
    createdAt: z.string().datetime(),
    attachments: z.array(attachmentSchema).default([]),
    reactions: z.array(reactionSchema).default([]),
    comments: z.array(initiativeCommentSchema).default([]),
  })
)
export const initiativeResourcesSchema = z
  .array(
    z.object({
      id: z.string(),
      title: z.string().trim().min(1).max(200),
      url: z
        .string()
        .url()
        .refine((value) => /^https?:/.test(value))
        .optional(),
      body: documentSchema.optional(),
    })
  )
  .default([])

export const initiativeProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  status: z.enum([
    "Backlog",
    "Planned",
    "Active",
    "Paused",
    "Completed",
    "Canceled",
  ]),
  teamIds: z.array(z.string()),
  health: z.enum(initiativeHealthValues),
  summary: z.string().max(2000).optional(),
  creatorId: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  description: documentSchema.optional(),
  icon: iconSchema.optional(),
  priority: z.enum(initiativePriorities).optional(),
  leadId: z.string().optional(),
  memberIds: z.array(z.string()).optional(),
  startDate: z.string().refine(validInitiativeTarget).optional(),
  targetDate: z.string().refine(validInitiativeTarget).optional(),
  labelIds: z.array(z.string()).optional(),
  dependencyIds: z.array(z.string()).optional(),
  slackChannelUrl: z
    .string()
    .max(2000)
    .refine((value) => {
      if (!value) return true
      try {
        const url = new URL(value)
        return (
          url.protocol === "https:" &&
          (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"))
        )
      } catch {
        return false
      }
    }, "Enter an HTTPS Slack channel URL.")
    .optional(),
  updates: initiativeUpdatesSchema.optional(),
  comments: z.array(initiativeCommentSchema).optional(),
  resources: initiativeResourcesSchema.removeDefault().optional(),
  milestones: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().trim().min(1).max(200),
        completed: z.boolean(),
        targetDate: z.string().refine(validInitiativeTarget).optional(),
        description: documentSchema.optional(),
        aliases: z.array(z.string()).optional(),
        descriptionHistory: z
          .array(
            z.object({
              description: documentSchema,
              createdAt: z.string().datetime(),
            })
          )
          .optional(),
      })
    )
    .optional(),
  milestoneEvents: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        authorId: z.string(),
        createdAt: z.string().datetime(),
      })
    )
    .optional(),
})
export type InitiativeProject = z.infer<typeof initiativeProjectSchema>
export type InitiativeComment = z.infer<typeof initiativeCommentSchema>
export const initiativeSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  summary: z.string().max(2000),
  description: documentSchema.default(null),
  icon: iconSchema,
  status: z.enum(initiativeStatuses),
  priority: z.enum(initiativePriorities),
  ownerId: z.string(),
  creatorId: z.string(),
  targetDate: z
    .string()
    .refine(validInitiativeTarget, "Enter a date, month, year, or quarter."),
  labelIds: z.array(z.string()),
  teamIds: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  updates: initiativeUpdatesSchema,
  projects: z.array(initiativeProjectSchema).default([]),
  comments: z.array(initiativeCommentSchema).default([]),
  resources: initiativeResourcesSchema,
  views: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().trim().min(1).max(80),
        status: initiativeProjectSchema.shape.status.optional(),
      })
    )
    .default([]),
})
export type Initiative = z.infer<typeof initiativeSchema>
export const initiativeStoreSchema = z.object({
  version: z.literal(1),
  nextNumber: z.number().int().positive().default(1),
  initiatives: z.array(initiativeSchema),
  workspaceProjects: z.array(initiativeProjectSchema).default([]),
})
export type InitiativeStore = z.infer<typeof initiativeStoreSchema>
export const emptyInitiatives = (): InitiativeStore => ({
  version: 1,
  nextNumber: 1,
  initiatives: [],
  workspaceProjects: [],
})
export const initiativesStorageKey = (workspaceId: string) =>
  `forge:workspace:${workspaceId}:initiatives:v1`
export const initiativePreferencesKey = (workspaceId: string, userId: string) =>
  `forge:workspace:${workspaceId}:initiatives-view:v1:${userId}`
export const initiativesSettingsStorageKey = (workspaceId: string) =>
  `forge:workspace:${workspaceId}:initiatives-settings:v1`
export const initiativesSettingsSchema = z.object({
  enabled: z.boolean(),
  schedule: projectUpdateScheduleSchema,
})
export const defaultInitiativesSettings = {
  enabled: true,
  schedule: "none" as const,
}

export const initiativeProperties = [
  "ID",
  "Description",
  "Owner",
  "Status",
  "Priority",
  "Contributing teams",
  "Health",
  "Projects",
  "Active projects",
  "Target date",
  "Created",
  "Updated",
  "Completed",
  "Labels",
] as const
export type InitiativeProperty = (typeof initiativeProperties)[number]
export const initiativePreferencesSchema = z.object({
  grouping: z.enum([
    "No grouping",
    "Status",
    "Priority",
    "Owner",
    "Contributing team",
    "Health",
  ]),
  ordering: z.enum([
    "Manual",
    "Name",
    "Priority",
    "Owner",
    "Target",
    "Health",
    "Created",
    "Updated",
  ]),
  descending: z.boolean(),
  properties: z.array(z.enum(initiativeProperties)),
  sidebar: z.boolean(),
  sidebarTab: z.enum(["Owner", "Contributing team", "Health"]),
  favoriteIds: z.array(z.string()).default([]),
  subscribedIds: z.array(z.string()).default([]),
  detailSidebar: z.boolean().default(false),
})
export type InitiativePreferences = z.infer<typeof initiativePreferencesSchema>
export const defaultInitiativePreferences = (): InitiativePreferences => ({
  grouping: "No grouping",
  ordering: "Manual",
  descending: false,
  properties: [
    "Description",
    "Priority",
    "Owner",
    "Target date",
    "Projects",
    "Health",
    "Active projects",
  ],
  sidebar: false,
  sidebarTab: "Owner",
  favoriteIds: [],
  subscribedIds: [],
  detailSidebar: false,
})

export type InitiativePerson = {
  id: string
  name: string
  image?: string | null
}
export const initiativeFilterFields = [
  "Status",
  "Priority",
  "Owner",
  "Creator",
  "Contributing teams",
  "Labels",
  "Health",
  "Target date",
  "Created",
  "Updated",
  "Name",
] as const
export type InitiativeFilter = {
  id: string
  field: (typeof initiativeFilterFields)[number]
  operator:
    "is" | "is not" | "contains" | "is set" | "is not set" | "before" | "after"
  value: string
}
export type InitiativeFilters = {
  match: "all" | "any"
  rules: Array<InitiativeFilter>
}
export const emptyInitiativeFilters = (): InitiativeFilters => ({
  match: "all",
  rules: [],
})

export function blankInitiative(
  creatorId: string,
  view: InitiativeView = "active"
): Omit<Initiative, "number"> {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    name: "",
    summary: "",
    description: null,
    icon: { kind: "icon", value: "Target01Icon", color: "#eb5757" },
    status: view === "planned" ? "Planned" : "Active",
    priority: "No priority",
    ownerId: "",
    creatorId,
    targetDate: "",
    labelIds: [],
    teamIds: [],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    updates: [],
    projects: [],
    comments: [],
    resources: [],
    views: [],
  }
}
export function patchInitiative(
  item: Initiative,
  patch: Partial<Initiative>,
  now = new Date().toISOString()
): Initiative {
  const status = patch.status ?? item.status
  return initiativeSchema.parse({
    ...item,
    ...patch,
    id: item.id,
    number: item.number,
    createdAt: item.createdAt,
    creatorId: item.creatorId,
    updatedAt: now,
    completedAt: status === "Completed" ? (item.completedAt ?? now) : null,
  })
}
export function addInitiative(
  state: InitiativeStore,
  draft: Omit<Initiative, "number">
): InitiativeStore {
  const number = Math.max(
    state.nextNumber,
    1,
    ...state.initiatives.map((item) => item.number + 1)
  )
  return initiativeStoreSchema.parse({
    ...state,
    nextNumber: number + 1,
    initiatives: [
      ...state.initiatives,
      {
        ...draft,
        number,
        completedAt:
          draft.status === "Completed" ? new Date().toISOString() : null,
      },
    ],
  })
}
export function targetLabel(value: string) {
  if (!value) return "Target date"
  const quarter = value.match(/^(\d{4})-Q([1-4])$/)
  if (quarter) return `Q${quarter[2]} ${quarter[1]}`
  const half = value.match(/^(\d{4})-H([12])$/)
  if (half) return `H${half[2]} ${half[1]}`
  if (/^\d{4}$/.test(value)) return value
  const date = new Date(
    `${value.length === 7 ? `${value}-01` : value}T12:00:00`
  )
  return date.toLocaleDateString(undefined, {
    month: "short",
    ...(value.length === 10 ? { day: "numeric" as const } : {}),
    year: "numeric",
  })
}
export function targetTimestamp(value: string) {
  if (!value) return Infinity
  const quarter = value.match(/^(\d{4})-Q([1-4])$/)
  if (quarter)
    return Date.UTC(Number(quarter[1]), Number(quarter[2]) * 3, 0, 23, 59, 59)
  const half = value.match(/^(\d{4})-H([12])$/)
  if (half) return Date.UTC(Number(half[1]), Number(half[2]) * 6, 0, 23, 59, 59)
  if (/^\d{4}$/.test(value)) return Date.UTC(Number(value), 11, 31, 23, 59, 59)
  if (value.length === 7)
    return Date.UTC(
      Number(value.slice(0, 4)),
      Number(value.slice(5)),
      0,
      23,
      59,
      59
    )
  return Date.parse(`${value}T23:59:59Z`)
}
export function initiativeHealth(
  item: Initiative,
  schedule = "none",
  now = Date.now()
): (typeof initiativeHealthValues)[number] {
  const latest = item.updates.at(-1)
  if (!latest) return "Update missing"
  const weeks = schedule === "none" ? 0 : Number.parseInt(schedule, 10)
  return weeks && now - Date.parse(latest.createdAt) > weeks * 7 * 86_400_000
    ? "Update missing"
    : latest.health
}
export function contributingTeamIds(item: Initiative) {
  return [
    ...new Set([
      ...item.teamIds,
      ...item.projects.flatMap((project) => project.teamIds),
    ]),
  ]
}
export function initiativeMatches(
  item: Initiative,
  filters: InitiativeFilters,
  schedule = "none",
  now = Date.now()
) {
  function matches(rule: InitiativeFilter) {
    const values =
      rule.field === "Status"
        ? [item.status]
        : rule.field === "Priority"
          ? [item.priority]
          : rule.field === "Owner"
            ? [item.ownerId]
            : rule.field === "Creator"
              ? [item.creatorId]
              : rule.field === "Contributing teams"
                ? contributingTeamIds(item)
                : rule.field === "Labels"
                  ? item.labelIds
                  : rule.field === "Health"
                    ? [initiativeHealth(item, schedule, now)]
                    : rule.field === "Target date"
                      ? [item.targetDate]
                      : rule.field === "Created"
                        ? [item.createdAt.slice(0, 10)]
                        : rule.field === "Updated"
                          ? [item.updatedAt.slice(0, 10)]
                          : [`${item.name} ${item.summary}`]
    if (rule.operator === "is set") return values.some(Boolean)
    if (rule.operator === "is not set") return !values.some(Boolean)
    if (rule.operator === "contains")
      return values.some((value) =>
        value.toLowerCase().includes(rule.value.toLowerCase())
      )
    if (rule.operator === "before" || rule.operator === "after") {
      if (!values[0]) return false
      const left =
        rule.field === "Target date"
          ? targetTimestamp(values[0])
          : Date.parse(values[0])
      const right = Date.parse(
        `${rule.value}T${rule.operator === "before" ? "00:00:00" : "23:59:59"}Z`
      )
      return rule.operator === "before" ? left < right : left > right
    }
    return rule.operator === "is not"
      ? !values.includes(rule.value)
      : values.includes(rule.value)
  }
  return (
    !filters.rules.length ||
    (filters.match === "all"
      ? filters.rules.every(matches)
      : filters.rules.some(matches))
  )
}
export function visibleInitiatives(
  items: Array<Initiative>,
  view: InitiativeView,
  filters: InitiativeFilters,
  preferences: InitiativePreferences,
  people: Array<InitiativePerson>,
  schedule = "none"
) {
  const result = items.filter(
    (item) =>
      (view === "all" ||
        (view === "active"
          ? item.status === "Active"
          : item.status === "Planned" || item.status === "Proposed")) &&
      initiativeMatches(item, filters, schedule)
  )
  const value = (item: Initiative): string | number =>
    preferences.ordering === "Priority"
      ? initiativePriorities.indexOf(item.priority) || 5
      : preferences.ordering === "Owner"
        ? (people.find((person) => person.id === item.ownerId)?.name ?? "")
        : preferences.ordering === "Target"
          ? targetTimestamp(item.targetDate)
          : preferences.ordering === "Health"
            ? initiativeHealth(item, schedule)
            : preferences.ordering === "Created"
              ? item.createdAt
              : preferences.ordering === "Updated"
                ? item.updatedAt
                : item.name
  if (preferences.ordering !== "Manual")
    result.sort((a, b) => {
      const left = value(a),
        right = value(b)
      return (
        (preferences.descending ? -1 : 1) *
        (typeof left === "number" && typeof right === "number"
          ? left === right
            ? 0
            : left < right
              ? -1
              : 1
          : String(left).localeCompare(String(right)))
      )
    })
  return result
}

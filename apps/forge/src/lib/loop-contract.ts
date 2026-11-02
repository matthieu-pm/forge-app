import { z } from "zod"

export const LOOP_ENTITIES = [
  "issue",
  "project",
  "initiative",
  "cycle",
  "team",
] as const
export const LOOP_FIELDS = [
  "id",
  "title",
  "name",
  "status",
  "priority",
  "assignee",
  "creator",
  "agent",
  "project",
  "cycle",
  "team",
  "labels",
  "owner",
  "lead",
  "targetDate",
  "description",
  "projects",
  "members",
  "triage",
  "milestones",
] as const
export const LOOP_EVENT_NAMES = [
  "created",
  "updated",
  "changed",
  "added",
  "removed",
  "comment",
  "update",
  "triage",
  "started",
  "completed",
] as const
export const loopLeafConditionSchema = z
  .object({
    field: z.enum(LOOP_FIELDS),
    operator: z.enum(["is", "isNot", "any", "none", "contains"]),
    values: z.array(z.string().min(1).max(1000)).min(1).max(50),
  })
  .strict()
  .superRefine((condition, ctx) => {
    if (
      condition.operator === "contains" &&
      (!condition.values.every((v) => v.trim()) ||
        condition.values.length !== 1)
    )
      ctx.addIssue({
        code: "custom",
        message: "Text matching needs one nonempty value.",
      })
  })
export type LoopLeafCondition = z.infer<typeof loopLeafConditionSchema>
export type LoopCondition =
  | LoopLeafCondition
  | { operator: "and" | "or"; conditions: Array<LoopCondition> }
function boundedConditionSchema(depth: number): z.ZodType<LoopCondition> {
  if (depth >= 4) return loopLeafConditionSchema
  return z.union([
    loopLeafConditionSchema,
    z
      .object({
        operator: z.enum(["and", "or"]),
        conditions: z
          .array(boundedConditionSchema(depth + 1))
          .min(1)
          .max(8),
      })
      .strict(),
  ])
}
export const loopConditionSchema = boundedConditionSchema(0)
export function loopConditionLeaves(
  conditions: Array<LoopCondition>
): Array<LoopLeafCondition> {
  return conditions.flatMap((condition) =>
    "conditions" in condition
      ? loopConditionLeaves(condition.conditions)
      : [condition]
  )
}
export const eventProperties = {
  issue: [
    "status",
    "priority",
    "assignee",
    "agent",
    "project",
    "cycle",
    "team",
    "labels",
  ],
  project: [
    "status",
    "lead",
    "priority",
    "labels",
    "targetDate",
    "description",
    "milestones",
  ],
  initiative: ["status", "owner", "projects", "targetDate", "description"],
  cycle: [],
  team: ["members"],
} as const
export const loopEventTriggerSchema = z
  .object({
    kind: z.literal("event"),
    entity: z.enum(LOOP_ENTITIES),
    event: z.enum(LOOP_EVENT_NAMES),
    property: z.enum(LOOP_FIELDS).optional(),
    values: z.array(z.string().max(1000)).max(50).optional(),
    commentMode: z
      .enum(["any", "newThread", "contains", "mentions"])
      .optional(),
    commentText: z.string().trim().min(1).max(1000).optional(),
    mentionIds: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
  })
  .strict()
  .superRefine((trigger, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message })
    if (trigger.event === "changed") {
      if (
        !trigger.property ||
        !(eventProperties[trigger.entity] as ReadonlyArray<string>).includes(
          trigger.property
        )
      )
        bad("Choose a supported property for this entity.")
    } else if (["added", "removed"].includes(trigger.event)) {
      if (
        trigger.property !==
          (trigger.entity === "team" ? "members" : "labels") ||
        !["issue", "project", "team"].includes(trigger.entity)
      )
        bad("Choose a supported collection change.")
    } else if (trigger.property !== undefined || trigger.values !== undefined)
      bad("This trigger does not accept property qualifiers.")
    if (
      trigger.event === "update" &&
      !["project", "initiative"].includes(trigger.entity)
    )
      bad("Posted updates apply only to projects and initiatives.")
    if (
      trigger.event !== "comment" &&
      (trigger.commentMode !== undefined ||
        trigger.commentText !== undefined ||
        trigger.mentionIds !== undefined)
    )
      bad("Only comment triggers accept comment matching rules.")
    if (trigger.event === "comment") {
      if (trigger.commentMode === "contains" && !trigger.commentText)
        bad("Enter text to match in comments.")
      if (trigger.commentMode === "mentions" && !trigger.mentionIds?.length)
        bad("Select at least one mentioned member.")
      if (
        trigger.commentMode !== "contains" &&
        trigger.commentText !== undefined
      )
        bad("Text matching applies only to the contains rule.")
      if (
        trigger.commentMode !== "mentions" &&
        trigger.mentionIds !== undefined
      )
        bad("Mentioned members apply only to the mentions rule.")
    }
    if (trigger.event === "triage" && trigger.entity !== "issue")
      bad("Triage applies only to issues.")
    if (
      ["started", "completed"].includes(trigger.event) &&
      trigger.entity !== "cycle"
    )
      bad("Lifecycle triggers apply only to cycles.")
    if (
      trigger.event === "comment" &&
      !["issue", "project", "initiative"].includes(trigger.entity)
    )
      bad("This entity has no supported comments.")
    if (
      trigger.event === "updated" &&
      !["issue", "project", "initiative"].includes(trigger.entity)
    )
      bad("Choose a supported entity update trigger.")
  })
export const loopScheduleTriggerSchema = z
  .object({
    kind: z.literal("schedule"),
    unit: z.enum(["hours", "days", "weeks", "months", "years"]),
    interval: z.number().int().min(1).max(1000),
    startAt: z.iso.datetime(),
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value }).format()
          return true
        } catch {
          return false
        }
      }, "Choose a valid timezone."),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  })
  .strict()
  .superRefine((trigger, ctx) => {
    if (trigger.unit === "weeks" && !trigger.weekdays?.length)
      ctx.addIssue({ code: "custom", message: "Select at least one weekday." })
    if (
      trigger.weekdays &&
      (trigger.unit !== "weeks" ||
        new Set(trigger.weekdays).size !== trigger.weekdays.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Weekdays must be unique and apply only to weekly schedules.",
      })
  })
export const loopTriggerSchema = z
  .union([
    loopEventTriggerSchema,
    loopScheduleTriggerSchema,
    z.object({ kind: z.literal("webhook") }).strict(),
  ])
  .transform(
    (trigger) =>
      Object.fromEntries(
        Object.entries(trigger).filter(([, value]) => value !== undefined)
      ) as typeof trigger
  )
export const loopConditionFields = {
  issue: [
    "id",
    "title",
    "description",
    "status",
    "priority",
    "assignee",
    "creator",
    "agent",
    "project",
    "cycle",
    "team",
    "labels",
    "triage",
  ],
  project: [
    "id",
    "name",
    "description",
    "status",
    "priority",
    "lead",
    "creator",
    "team",
    "labels",
    "targetDate",
    "members",
  ],
  initiative: [
    "id",
    "name",
    "description",
    "status",
    "priority",
    "owner",
    "creator",
    "projects",
    "targetDate",
  ],
  cycle: ["id", "name", "team"],
  team: ["id", "name", "members"],
} as const
export const loopFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    description: z.string().trim().max(255),
    instructions: z.string().trim().min(1).max(20000),
    trigger: loopTriggerSchema,
    conditions: z.array(loopConditionSchema).max(8),
    reasoning: z.enum(["auto", "low", "medium", "high"]),
    teamAccess: z.enum(["this-team", "all-public-teams"]),
  })
  .strict()
  .superRefine((fields, ctx) => {
    if (fields.trigger.kind === "event") {
      const supported = loopConditionFields[
        fields.trigger.entity
      ] as ReadonlyArray<string>
      if (
        loopConditionLeaves(fields.conditions).some(
          (condition) => !supported.includes(condition.field)
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Choose conditions supported by this entity.",
        })
    }
    if (loopConditionLeaves(fields.conditions).length > 8)
      ctx.addIssue({
        code: "custom",
        message:
          "A Loop supports at most eight conditions, including grouped conditions.",
      })
    if (fields.trigger.kind !== "event" && fields.conditions.length)
      ctx.addIssue({
        code: "custom",
        message: "Only entity triggers support conditions.",
      })
  })
export type LoopFields = z.infer<typeof loopFieldsSchema>
export type LoopTrigger = z.infer<typeof loopTriggerSchema>
export type LoopEntity = (typeof LOOP_ENTITIES)[number]
export type SharedLoop = LoopFields & {
  id: string
  revision: number
  enabled: boolean
  enabledById: string | null
  updatedAt: string
}
export type LoopRun = {
  id: string
  loopId: string
  state: string
  createdAt: string
  errorCode: string | null
  threadId: string | null
  result: string | null
  approvals?: Array<{ id: string; inputHash: string; summary: string }>
}
export type LoopVersion = {
  loopId: string
  revision: number
  fields: LoopFields
  publishedAt: string
}
export type LoopSnapshot = {
  loops: Array<SharedLoop>
  runs: Array<LoopRun>
  enabled: boolean
  choices?: Record<string, Array<{ id: string; name: string }>>
  versions?: Array<LoopVersion>
}
const identity = {
  id: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
}
export const loopCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      id: z.uuid(),
      fields: loopFieldsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("save"),
      ...identity,
      fields: loopFieldsSchema,
    })
    .strict(),
  z.object({ action: z.literal("delete"), ...identity }).strict(),
  z.object({ action: z.literal("enable"), ...identity }).strict(),
  z.object({ action: z.literal("disable"), ...identity }).strict(),
  z.object({ action: z.literal("rotate-webhook"), ...identity }).strict(),
  z
    .object({
      action: z.literal("approve"),
      ...identity,
      runId: z.uuid(),
      approvalId: z.uuid(),
      inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("deny"),
      ...identity,
      runId: z.uuid(),
      approvalId: z.uuid(),
      inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({ action: z.literal("cancel-run"), ...identity, runId: z.uuid() })
    .strict(),
  z
    .object({
      action: z.literal("run-now"),
      ...identity,
      entityId: z.uuid().optional(),
    })
    .strict(),
])
export type LoopCommand = z.infer<typeof loopCommandSchema>
export type LoopCommandResult =
  | { status: "saved"; id: string; revision: number; webhookSecret?: string }
  | { status: "conflict"; current: SharedLoop | null }
  | { status: "rejected"; message: string }
export function loopTriggerLabel(trigger: LoopTrigger) {
  if (trigger.kind === "webhook") return "Authenticated webhook"
  if (trigger.kind === "schedule")
    return `Every ${trigger.interval} ${trigger.unit} · ${trigger.timeZone}`
  return `${trigger.entity[0].toUpperCase()}${trigger.entity.slice(1)} · ${trigger.property ? trigger.property + " " : ""}${trigger.event}`
}

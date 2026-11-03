import { z } from "zod"

export const slaDurationSchema = z.discriminatedUnion("unit", [
  z
    .object({
      unit: z.literal("hour"),
      value: z.number().int().min(1).max(8760),
    })
    .strict(),
  z
    .object({ unit: z.literal("day"), value: z.number().int().min(1).max(365) })
    .strict(),
  z
    .object({
      unit: z.literal("business-day"),
      value: z.number().int().min(1).max(365),
    })
    .strict(),
  z
    .object({ unit: z.literal("week"), value: z.number().int().min(1).max(52) })
    .strict(),
])
const filters = z
  .object({
    teamIds: z.array(z.uuid()).min(1).max(100).optional(),
    priorities: z
      .array(z.enum(["Urgent", "High", "Medium", "Low", "No priority"]))
      .min(1)
      .max(5)
      .optional(),
    statusIds: z.array(z.string().min(1).max(255)).min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (v) => Object.values(v).some((value) => value !== undefined),
    "Choose at least one condition."
  )
const ruleBase = { id: z.uuid(), enabled: z.boolean(), filters }
export const sharedSlaRuleSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...ruleBase,
      action: z.literal("apply"),
      duration: slaDurationSchema,
      startMode: z.enum(["ruleMatch", "issueCreation"]),
    })
    .strict(),
  z.object({ ...ruleBase, action: z.literal("remove") }).strict(),
])
export const sharedSlaPolicySchema = z
  .object({
    enabled: z.boolean(),
    workWeek: z.enum(["mon-fri", "sun-thu"]),
    rules: z.array(sharedSlaRuleSchema).max(100),
  })
  .strict()
  .refine(
    (v) => new Set(v.rules.map((r) => r.id)).size === v.rules.length,
    "Rule identities must be unique."
  )
export const slaPolicyCommandSchema = z
  .object({
    workspaceId: z.string().min(1).max(255),
    sessionId: z.string().min(1).max(255),
    commandKey: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    values: sharedSlaPolicySchema,
  })
  .strict()
export const slaReadSchema = z
  .object({ workspaceId: z.string().min(1), sessionId: z.string().min(1) })
  .strict()
export const slaReconciliationSchema = slaReadSchema
  .extend({
    commandKey: z.uuid(),
    commitmentId: z.uuid(),
    decision: z.enum(["breach-owed", "not-owed"]),
    evidence: z.string().trim().min(10).max(500),
  })
  .strict()
export type SharedSlaPolicy = z.infer<typeof sharedSlaPolicySchema>
export type SharedSlaRule = z.infer<typeof sharedSlaRuleSchema>
export type SlaPolicyCommand = z.infer<typeof slaPolicyCommandSchema>
export type SlaPolicySnapshot = {
  revision: number
  values: SharedSlaPolicy
  canManage: boolean
  teams: Array<{ id: string; name: string; timezone: string }>
  statuses: Array<{ id: string; teamId: string; name: string }>
  reconciliation: Array<{ id: string; issueId: string; deadline: string }>
}
export const initialSharedSlaPolicy = (): SharedSlaPolicy => ({
  enabled: false,
  workWeek: "mon-fri",
  rules: [],
})
export function starterSlaRules(): SharedSlaPolicy["rules"] {
  return [
    {
      id: crypto.randomUUID(),
      enabled: true,
      action: "apply",
      filters: { priorities: ["Urgent"] },
      duration: { unit: "hour", value: 24 },
      startMode: "ruleMatch",
    },
    {
      id: crypto.randomUUID(),
      enabled: true,
      action: "apply",
      filters: { priorities: ["High"] },
      duration: { unit: "week", value: 1 },
      startMode: "ruleMatch",
    },
    {
      id: crypto.randomUUID(),
      enabled: true,
      action: "remove",
      filters: { priorities: ["Medium", "Low", "No priority"] },
    },
  ]
}
export const issueSlaSnapshotSchema = z.object({
  id: z.uuid(),
  deadline: z.string(),
  anchor: z.string(),
  timezone: z.string(),
  status: z.enum([
    "low-risk",
    "moderate-risk",
    "high-risk",
    "breached",
    "achieved",
    "failed",
    "reconciliation",
  ]),
  completedAt: z.string().nullable(),
})
export type IssueSlaSnapshot = z.infer<typeof issueSlaSnapshotSchema>

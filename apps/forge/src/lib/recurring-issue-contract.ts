import { z } from "zod"
import { occurrenceAt } from "./recurrence-calendar"
import {
  emptyTemplate,
  templatePayloadSchema,
  templateQuerySchema,
} from "./template-contract"
import type { TemplateDraft } from "./template-contract"

export const recurrenceTimezoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value })
      return true
    } catch {
      return false
    }
  }, "Choose a valid timezone.")
export const recurrenceTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a valid local time.")
export const recurrenceUnitSchema = z.enum(["day", "week", "month", "year"])
export const recurringIssuePayloadSchema = templatePayloadSchema
  .pick({
    icon: true,
    title: true,
    content: true,
    properties: true,
    subIssues: true,
  })
  .extend({
    title: z
      .string()
      .trim()
      .min(1, "Give your recurring issue a title.")
      .max(200),
    firstDue: z.string().refine((value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
      const date = new Date(`${value}T12:00:00Z`)
      return (
        Number.isFinite(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
      )
    }, "Choose a valid first due date."),
    interval: z.number().int().min(1).max(100),
    unit: recurrenceUnitSchema,
    timezone: recurrenceTimezoneSchema.optional(),
    generationTime: recurrenceTimeSchema.optional(),
  })
  .refine((payload) => {
    try {
      return Number.isFinite(occurrenceAt(payload, 1).getTime())
    } catch {
      return false
    }
  }, "Choose an earlier first due date or a shorter repeat interval.")
export type RecurringIssueDraft = Pick<
  TemplateDraft,
  "icon" | "title" | "content" | "properties" | "subIssues"
> & {
  firstDue: string
  timezone?: string
  generationTime?: string
  interval: number
  unit: z.infer<typeof recurrenceUnitSchema>
}
export type SavedRecurringIssue = {
  id: string
  payload: RecurringIssueDraft
  createdAt: string
  updatedAt: string
  state?: "inactive" | "active" | "disabled" | "paused" | "deleted"
  ownerId?: string
  nextAt?: string | null
  lastReason?: string | null
  recentEvents?: Array<{
    reason: string
    fromDate: string | null
    toDate: string | null
    count: number
  }>
  skippedCount?: number
}
export const saveRecurringIssueSchema = templateQuerySchema
  .extend({
    commandKey: z.string().uuid(),
    enabled: z.boolean().optional(),
    takeOwnership: z.boolean().optional(),
    id: z.string().uuid().optional(),
    updatedAt: z.string().datetime().optional(),
    payload: recurringIssuePayloadSchema,
  })
  .refine(
    (input) => JSON.stringify(input.payload).length <= 8_000_000,
    "Issue content is too large. Use smaller attachments."
  )

export function emptyRecurringIssue(
  teamId: string,
  timezone: string,
  now = new Date()
): RecurringIssueDraft {
  const template = emptyTemplate("issue", teamId)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const part = (type: string) => parts.find((p) => p.type === type)!.value
  const date = new Date(
    `${part("year")}-${part("month")}-${part("day")}T12:00:00Z`
  )
  date.setUTCDate(date.getUTCDate() + 7)
  return {
    icon: template.icon,
    title: "",
    content: null,
    properties: template.properties,
    subIssues: [],
    firstDue: date.toISOString().slice(0, 10),
    timezone,
    generationTime: "09:00",
    interval: 1,
    unit: "week",
  }
}
export function recurrenceLabel(
  draft: Pick<RecurringIssueDraft, "interval" | "unit">
) {
  return draft.interval === 1
    ? `Every ${draft.unit}`
    : `Every ${draft.interval} ${draft.unit}s`
}
export function formatDueDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`))
}

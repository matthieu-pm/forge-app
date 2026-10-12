import { z } from "zod"
import {
  emptyTemplate,
  templatePayloadSchema,
  templateQuerySchema,
} from "./template-contract"
import type { TemplateDraft } from "./template-contract"

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
  })
export type RecurringIssueDraft = Pick<
  TemplateDraft,
  "icon" | "title" | "content" | "properties" | "subIssues"
> & {
  firstDue: string
  interval: number
  unit: z.infer<typeof recurrenceUnitSchema>
}
export type SavedRecurringIssue = {
  id: string
  payload: RecurringIssueDraft
  createdAt: string
  updatedAt: string
}
export const saveRecurringIssueSchema = templateQuerySchema
  .extend({
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

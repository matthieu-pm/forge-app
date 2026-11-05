import "@tanstack/react-start/server-only"
import { and, eq, gt, gte, inArray, lte } from "drizzle-orm"
import { z } from "zod"
import { canonicalTemplateIssueCommand } from "../templates/canonical-template-issue.server"
import { commandInputHash } from "../commands/command-input"
import { executeCommandInTransaction } from "../commands/execute-command.server"
import type { Actor } from "../actor"
import type { Transaction, teamRecurringIssues } from "@/db"
import type { RecurringIssueDraft } from "@/lib/recurring-issue-contract"
import { recurringIssueEvents, recurringIssueOccurrences } from "@/db"
import { recurringIssuePayloadSchema } from "@/lib/recurring-issue-contract"
import {
  occurrenceAt,
  recurrenceDate,
  recurrenceIndexOnDate,
} from "@/lib/recurrence-calendar"

export type ScheduleRow = typeof teamRecurringIssues.$inferSelect
const skippedRangeReasons = [
  "before-activation",
  "disabled-period",
  "downtime-latest-only",
  "schedule-edited",
] as const

export async function dateWasSkipped(
  tx: Transaction,
  scheduleId: string,
  date: string
) {
  const ranges = await tx
    .select({ calendar: recurringIssueEvents.calendar })
    .from(recurringIssueEvents)
    .where(
      and(
        eq(recurringIssueEvents.scheduleId, scheduleId),
        gt(recurringIssueEvents.count, 0),
        inArray(recurringIssueEvents.reason, [...skippedRangeReasons]),
        lte(recurringIssueEvents.fromDate, date),
        gte(recurringIssueEvents.toDate, date)
      )
    )
  return ranges.some(({ calendar }) => {
    // Older range records lack cadence metadata and must remain excluded.
    if (!calendar) return true
    const index = recurrenceIndexOnDate(calendar, date)
    return (
      index !== null && index >= calendar.fromIndex && index <= calendar.toIndex
    )
  })
}

export async function dateWasSettled(
  tx: Transaction,
  scheduleId: string,
  date: string
) {
  const [occurrence] = await tx
    .select({ id: recurringIssueOccurrences.id })
    .from(recurringIssueOccurrences)
    .where(
      and(
        eq(recurringIssueOccurrences.scheduleId, scheduleId),
        eq(recurringIssueOccurrences.dueDate, date)
      )
    )
  return Boolean(occurrence) || (await dateWasSkipped(tx, scheduleId, date))
}

export async function reserveOccurrence(
  tx: Transaction,
  schedule: ScheduleRow,
  index: number
) {
  const payload = recurringIssuePayloadSchema.parse(schedule.payload)
  const dueDate = recurrenceDate(payload, index)
  const skipped = await dateWasSkipped(tx, schedule.id, dueDate)
  const inserted = await tx
    .insert(recurringIssueOccurrences)
    .values({
      workspaceId: schedule.workspaceId,
      scheduleId: schedule.id,
      dueDate,
      scheduledAt: occurrenceAt(payload, index),
      snapshot: payload,
      state: skipped ? "skipped" : "pending",
      reason: skipped ? "previously-skipped" : null,
      revision: commandInputHash({
        payload,
        updatedAt: schedule.updatedAt.toISOString(),
      }),
    })
    .onConflictDoNothing()
    .returning()
  if (inserted[0]) return inserted[0]
  return (
    await tx
      .select()
      .from(recurringIssueOccurrences)
      .where(
        and(
          eq(recurringIssueOccurrences.scheduleId, schedule.id),
          eq(recurringIssueOccurrences.dueDate, dueDate)
        )
      )
  )[0]
}
export async function recordSkipped(
  tx: Transaction,
  schedule: ScheduleRow,
  reason: (typeof skippedRangeReasons)[number],
  from: number,
  to: number,
  payload: RecurringIssueDraft = schedule.payload
) {
  if (to < from) return 0
  const count = to - from + 1
  await tx.insert(recurringIssueEvents).values({
    workspaceId: schedule.workspaceId,
    scheduleId: schedule.id,
    reason,
    calendar: {
      firstDue: payload.firstDue,
      unit: payload.unit,
      interval: payload.interval,
      fromIndex: from,
      toIndex: to,
    },
    count,
    fromDate: recurrenceDate(payload, from),
    toDate: recurrenceDate(payload, to),
  })
  return count
}

export async function generateOccurrence(
  tx: Transaction,
  actor: Actor,
  occurrence: typeof recurringIssueOccurrences.$inferSelect
) {
  if (occurrence.state !== "pending") return occurrence.issueId
  const payload = recurringIssuePayloadSchema.parse(occurrence.snapshot)
  const result = await executeCommandInTransaction(tx, {
    actor,
    commandKey: occurrence.id,
    operation: "recurring.generate@1",
    status: 201,
    input: { occurrenceId: occurrence.id, revision: occurrence.revision },
    parse: (value) => z.object({ issueId: z.uuid() }).strict().parse(value),
    authorize: async () => {},
    run: async (connection, current) => {
      const events: Array<{ topic: string; payload: Record<string, unknown> }> =
        []
      async function create(
        title: string,
        content: RecurringIssueDraft["content"],
        properties: RecurringIssueDraft["properties"],
        parentId = ""
      ) {
        if (properties.teamIds.length !== 1)
          throw new Error("Choose one team for each recurring issue.")
        const command = await canonicalTemplateIssueCommand(
          connection,
          current,
          {
            commandKey: occurrence.id,
            teamId: properties.teamIds[0],
            title,
            content,
            properties,
            dueDate: occurrence.dueDate,
            parentId,
          }
        )
        await command.authorize(connection, current, undefined)
        const created = await command.run(connection, current)
        events.push(...created.events)
        return created.value.issueId
      }
      const issueId = await create(
        payload.title,
        payload.content,
        payload.properties
      )
      for (const child of payload.subIssues)
        await create(child.title, child.content, child.properties, issueId)
      await connection
        .update(recurringIssueOccurrences)
        .set({ state: "created", issueId })
        .where(eq(recurringIssueOccurrences.id, occurrence.id))
      return {
        value: { issueId },
        resource: { type: "issue", id: issueId },
        events,
      }
    },
  })
  return result.value.issueId
}

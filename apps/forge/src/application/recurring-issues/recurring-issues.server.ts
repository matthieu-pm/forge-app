import "@tanstack/react-start/server-only"
import { and, desc, eq, ne, sql } from "drizzle-orm"
import { z } from "zod"
import { requireFeatureWrite } from "../features/features.server"
import { currentCommandActor } from "../commands/command-actor.server"
import { TemplateValidationError } from "../templates/template-forms"
import { executeCommand } from "../commands/execute-command.server"
import {
  dateWasSettled,
  generateOccurrence,
  recordSkipped,
  reserveOccurrence,
} from "./occurrences.server"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type {
  RecurringIssueDraft,
  SavedRecurringIssue,
} from "@/lib/recurring-issue-contract"
import { withoutUndefined } from "@/lib/canonical-json"
import { saveRecurringIssueSchema } from "@/lib/recurring-issue-contract"
import { readableTeamCondition } from "@/application/resource-policy.server"
import {
  ApplicationAccessError,
  canManageTeams,
} from "@/application/authorization"
import {
  db,
  organizations,
  recurringIssueEvents,
  recurringIssueOccurrences,
  teamRecurringIssues,
  teams,
} from "@/db"
import {
  nextRecurrenceIndex,
  occurrenceAt,
  recurrenceDate,
} from "@/lib/recurrence-calendar"

async function scope(
  tx: Transaction,
  actor: Actor,
  slug: string,
  write = false
) {
  requireFeatureWrite(actor, "recurringIssues")
  if (
    write &&
    (actor.authentication.kind !== "session" || !canManageTeams(actor))
  )
    throw new ApplicationAccessError(
      "Only workspace owners and admins can manage recurring issues."
    )
  const team = (
    await tx
      .select()
      .from(teams)
      .where(
        and(
          eq(teams.slug, slug),
          eq(teams.workspaceId, actor.workspaceId),
          readableTeamCondition(actor, teams.id)
        )
      )
      .for("share")
  )[0]
  if (!team)
    throw new ApplicationAccessError("You do not have access to this team.")
  return team
}
async function lockWorkspace(tx: Transaction, workspaceId: string) {
  await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, workspaceId))
    .for("no key update")
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId},4040))`
  )
}
export async function loadRecurringIssues(
  actor: Actor,
  slug: string
): Promise<Array<SavedRecurringIssue>> {
  return db.transaction(async (tx) => {
    actor = await currentCommandActor(tx, actor)
    const team = await scope(tx, actor, slug)
    const records = await tx
      .select()
      .from(teamRecurringIssues)
      .where(
        and(
          eq(teamRecurringIssues.workspaceId, actor.workspaceId),
          eq(teamRecurringIssues.teamId, team.id),
          ne(teamRecurringIssues.state, "deleted")
        )
      )
      .orderBy(desc(teamRecurringIssues.createdAt))
    const result: Array<SavedRecurringIssue> = []
    for (const record of records) {
      result.push({
        id: record.id,
        payload: record.payload,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
        state: record.state,
        ownerId: record.createdByUserId,
        nextAt: record.nextAt?.toISOString() ?? null,
        lastReason: record.lastReason,
        skippedCount: record.skippedCount,
        recentEvents: (
          await tx
            .select()
            .from(recurringIssueEvents)
            .where(eq(recurringIssueEvents.scheduleId, record.id))
            .orderBy(desc(recurringIssueEvents.createdAt))
            .limit(10)
        ).map((event) => ({
          reason: event.reason,
          fromDate: event.fromDate,
          toDate: event.toDate,
          count: event.count,
        })),
      })
    }
    return result
  })
}
export async function saveRecurringIssue(
  actor: Actor,
  raw: {
    commandKey: string
    slug: string
    id?: string
    updatedAt?: string
    payload: RecurringIssueDraft
    enabled?: boolean
    takeOwnership?: boolean
  }
) {
  const input = saveRecurringIssueSchema.parse(raw)
  const result = await executeCommand({
    actor,
    commandKey: input.commandKey,
    operation: "recurring.save@1",
    input: withoutUndefined(input),
    status: 200,
    parse: (value) => z.object({ id: z.uuid() }).strict().parse(value),
    authorize: async (tx, current) => {
      await scope(tx, current, input.slug, true)
    },
    run: async (tx, current) => {
      await lockWorkspace(tx, current.workspaceId)
      const team = await scope(tx, current, input.slug, true)
      const existing = input.id
        ? (
            await tx
              .select()
              .from(teamRecurringIssues)
              .where(
                and(
                  eq(teamRecurringIssues.id, input.id),
                  eq(teamRecurringIssues.workspaceId, current.workspaceId),
                  eq(teamRecurringIssues.teamId, team.id),
                  ne(teamRecurringIssues.state, "deleted")
                )
              )
              .for("update")
          )[0]
        : undefined
      if (input.id && !existing)
        throw new ApplicationAccessError(
          "Recurring issue not found in this team."
        )
      if (existing && existing.updatedAt.toISOString() !== input.updatedAt)
        throw new TemplateValidationError(
          "This recurring issue changed in another window. Reload before saving."
        )
      const now = (await tx.execute(sql`select clock_timestamp() as now`))
        .rows[0].now as string
      const clock = new Date(now)
      const payload = {
        ...input.payload,
        timezone:
          input.payload.timezone ?? existing?.payload.timezone ?? team.timezone,
        generationTime: input.payload.generationTime ?? "09:00",
      }
      if (
        payload.properties.teamIds.length !== 1 ||
        payload.properties.teamIds[0] !== team.id
      )
        throw new ApplicationAccessError(
          "Choose this team for the recurring issue."
        )
      const enabled =
        input.enabled ?? (existing ? existing.state === "active" : true)
      const owner = input.takeOwnership
        ? current.userId
        : (existing?.createdByUserId ?? current.userId)
      let skipped = existing?.skippedCount ?? 0
      const changedSchedule =
        existing &&
        ["firstDue", "interval", "unit", "timezone", "generationTime"].some(
          (key) =>
            payload[key as keyof typeof payload] !==
            existing.payload[key as keyof RecurringIssueDraft]
        )
      const resuming = existing && enabled && existing.state !== "active"
      const reset = !existing?.activatedAt || changedSchedule || resuming
      let nextIndex = reset
        ? nextRecurrenceIndex(
            payload,
            clock,
            existing?.activatedAt && changedSchedule ? 0 : 1
          )
        : existing.nextIndex
      if (existing?.activatedAt && reset) {
        skipped += await recordSkipped(
          tx,
          existing,
          resuming ? "disabled-period" : "schedule-edited",
          existing.nextIndex,
          nextRecurrenceIndex(existing.payload, clock, existing.nextIndex) - 1
        )
        while (
          await dateWasSettled(
            tx,
            existing.id,
            recurrenceDate(payload, nextIndex)
          )
        )
          nextIndex++
      }
      const revisionTime = existing
        ? new Date(Math.max(clock.getTime(), existing.updatedAt.getTime() + 1))
        : clock
      const [schedule] = existing
        ? await tx
            .update(teamRecurringIssues)
            .set({
              payload,
              state: enabled ? "active" : "disabled",
              createdByUserId: owner,
              activatedAt: enabled
                ? (existing.activatedAt ?? clock)
                : existing.activatedAt,
              nextIndex,
              nextAt: enabled ? occurrenceAt(payload, nextIndex) : null,
              updatedAt: revisionTime,
              skippedCount: skipped,
              lastReason: null,
            })
            .where(eq(teamRecurringIssues.id, existing.id))
            .returning()
        : await tx
            .insert(teamRecurringIssues)
            .values({
              workspaceId: current.workspaceId,
              teamId: team.id,
              createdByUserId: owner,
              payload,
              state: enabled ? "active" : "disabled",
              activatedAt: enabled ? clock : null,
              nextIndex,
              nextAt: enabled ? occurrenceAt(payload, nextIndex) : null,
            })
            .returning()
      if (!enabled) {
        const pending = await tx
          .update(recurringIssueOccurrences)
          .set({ state: "skipped", reason: "schedule-disabled" })
          .where(
            and(
              eq(recurringIssueOccurrences.scheduleId, schedule.id),
              eq(recurringIssueOccurrences.state, "pending")
            )
          )
          .returning()
        const dates = pending.map((item) => item.dueDate).sort()
        await tx.insert(recurringIssueEvents).values({
          workspaceId: current.workspaceId,
          scheduleId: schedule.id,
          reason: "schedule-disabled",
          count: pending.length,
          fromDate: dates[0] ?? null,
          toDate: dates.at(-1) ?? null,
        })
        skipped += pending.length
        await tx
          .update(teamRecurringIssues)
          .set({ skippedCount: skipped })
          .where(eq(teamRecurringIssues.id, schedule.id))
      }
      if (enabled && !existing?.activatedAt) {
        const first = await reserveOccurrence(tx, schedule, 0)
        try {
          await generateOccurrence(
            tx,
            {
              ...current,
              userId: owner,
              authentication: { kind: "recurring", scheduleId: schedule.id },
            },
            first
          )
        } catch (error) {
          if (
            error instanceof ApplicationAccessError ||
            error instanceof TemplateValidationError ||
            (error instanceof Error && error.constructor === Error)
          )
            throw new TemplateValidationError(error.message)
          throw error
        }
        skipped += await recordSkipped(
          tx,
          schedule,
          "before-activation",
          1,
          nextIndex - 1
        )
        await tx
          .update(teamRecurringIssues)
          .set({ skippedCount: skipped })
          .where(eq(teamRecurringIssues.id, schedule.id))
      }
      return {
        value: { id: schedule.id },
        resource: { type: "recurring-schedule", id: schedule.id },
        events: [],
      }
    },
  })
  return result.value
}
export async function deleteRecurringIssue(
  actor: Actor,
  input: { slug: string; id: string; updatedAt: string }
) {
  return db.transaction(async (tx) => {
    actor = await currentCommandActor(tx, actor)
    await lockWorkspace(tx, actor.workspaceId)
    const team = await scope(tx, actor, input.slug, true)
    const [schedule] = await tx
      .update(teamRecurringIssues)
      .set({
        state: "deleted",
        nextAt: null,
        updatedAt: new Date(),
        lastReason: "schedule-deleted",
      })
      .where(
        and(
          eq(teamRecurringIssues.id, input.id),
          eq(teamRecurringIssues.workspaceId, actor.workspaceId),
          eq(teamRecurringIssues.teamId, team.id),
          eq(teamRecurringIssues.updatedAt, new Date(input.updatedAt)),
          ne(teamRecurringIssues.state, "deleted")
        )
      )
      .returning()
    if (!schedule)
      throw new Error(
        "This recurring issue changed in another window. Reload before deleting."
      )
    await tx
      .update(recurringIssueOccurrences)
      .set({ state: "skipped", reason: "schedule-deleted" })
      .where(
        and(
          eq(recurringIssueOccurrences.scheduleId, schedule.id),
          eq(recurringIssueOccurrences.state, "pending")
        )
      )
    return { ok: true }
  })
}

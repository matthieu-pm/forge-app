import "@tanstack/react-start/server-only"
import { and, eq, isNull, lte, or, sql } from "drizzle-orm"
import { loopsEnabled } from "./loop-access.server"
import { enqueueLoopRun } from "./loops.server"
import { loopMatchEvents, normalizeLoopSnapshot } from "./loop-context.server"
import { executeNextLoopRun } from "./loop-execution.server"
import type { LoopEntity } from "@/lib/loop-contract"
import type { LoopExecutor } from "./loop-execution.server"
import {
  loopScheduleStart,
  matchesLoopEvent,
  nextLoopScheduledAt,
} from "@/lib/loop-matching"
import { commandInputHash } from "@/application/commands/command-input"
import { db, issueCycles, loopEvents, loopRuns, teamLoops, teams } from "@/db"

export async function enqueueNativeLoopEvents(
  limit = 100,
  workspaceId?: string
) {
  if (!loopsEnabled()) return 0
  let processed = 0
  for (let i = 0; i < limit; i++) {
    const done = await db.transaction(async (tx) => {
      const event = (
        await tx
          .select()
          .from(loopEvents)
          .where(
            and(
              isNull(loopEvents.processedAt),
              workspaceId ? eq(loopEvents.workspaceId, workspaceId) : undefined
            )
          )
          .orderBy(loopEvents.createdAt, loopEvents.id)
          .for("update", { skipLocked: true })
          .limit(1)
      )[0]
      if (!event) return false
      const source = (
        await tx
          .select()
          .from(teams)
          .where(
            and(
              eq(teams.id, event.teamId),
              eq(teams.workspaceId, event.workspaceId),
              isNull(teams.deletedAt)
            )
          )
      )[0]
      const loops = source
        ? await tx
            .select()
            .from(teamLoops)
            .where(
              and(
                eq(teamLoops.workspaceId, event.workspaceId),
                eq(teamLoops.enabled, true),
                isNull(teamLoops.deletedAt),
                lte(teamLoops.enabledAt, event.createdAt),
                or(
                  eq(teamLoops.teamId, event.teamId),
                  source.visibility === "workspace"
                    ? sql`${teamLoops.fields}->>'teamAccess'='all-public-teams'`
                    : sql`false`
                )
              )
            )
        : []
      const matches = loopMatchEvents(
        event.entity as LoopEntity,
        event.event,
        event.before,
        event.after
      )
      for (const loop of loops) {
        const match = matches.find((m) => matchesLoopEvent(loop.fields, m))
        if (!match) continue
        const key = `native:${commandInputHash({ entity: event.entity, entityId: event.entityId, event: event.event, before: event.before, after: event.after, at: event.createdAt.toISOString() })}`
        await enqueueLoopRun(tx, loop, key, {
          kind: "native",
          entity: event.entity,
          entityId: event.entityId,
          trigger: match.event,
          context: match.after,
          ...(match.comment ? { comment: match.comment } : {}),
        })
      }
      await tx
        .update(loopEvents)
        .set({ processedAt: new Date() })
        .where(eq(loopEvents.id, event.id))
      return true
    })
    if (!done) break
    processed++
  }
  return processed
}
export async function enqueueScheduledLoops(
  now = new Date(),
  workspaceId?: string
) {
  if (!loopsEnabled()) return 0
  return db.transaction(async (tx) => {
    const loops = await tx
      .select()
      .from(teamLoops)
      .where(
        and(
          eq(teamLoops.enabled, true),
          isNull(teamLoops.deletedAt),
          workspaceId ? eq(teamLoops.workspaceId, workspaceId) : undefined
        )
      )
      .for("update", { skipLocked: true })
    let count = 0
    for (const loop of loops) {
      const trigger = loop.fields.trigger
      if (
        trigger.kind === "schedule" &&
        loop.nextRunAt &&
        loop.nextRunAt <= now
      ) {
        await enqueueLoopRun(
          tx,
          loop,
          `schedule:${loop.nextRunAt.toISOString()}`,
          { kind: "schedule", scheduledAt: loop.nextRunAt.toISOString() }
        )
        await tx
          .update(teamLoops)
          .set({ nextRunAt: nextLoopScheduledAt(trigger, now) })
          .where(eq(teamLoops.id, loop.id))
        count++
      } else if (
        trigger.kind === "event" &&
        trigger.entity === "cycle" &&
        ["started", "completed"].includes(trigger.event)
      ) {
        const cycles = await tx
          .select({ cycle: issueCycles, team: teams })
          .from(issueCycles)
          .innerJoin(
            teams,
            and(
              eq(teams.id, issueCycles.teamId),
              eq(teams.workspaceId, issueCycles.workspaceId)
            )
          )
          .where(
            and(
              eq(issueCycles.workspaceId, loop.workspaceId),
              isNull(teams.deletedAt),
              loop.fields.teamAccess === "this-team"
                ? eq(issueCycles.teamId, loop.teamId)
                : eq(teams.visibility, "workspace")
            )
          )
        for (const { cycle } of cycles) {
          const endNextDay = new Date(`${cycle.endDate}T12:00:00Z`)
          endNextDay.setUTCDate(endNextDay.getUTCDate() + 1)
          const boundary =
            trigger.event === "started"
              ? cycle.startDate
              : endNextDay.toISOString().slice(0, 10)
          const instant = new Date(
            loopScheduleStart(`${boundary}T00:00`, cycle.timezone)
          )
          if (instant > now || !loop.enabledAt || instant < loop.enabledAt)
            continue
          const after = normalizeLoopSnapshot(
            "cycle",
            cycle as unknown as Record<string, unknown>
          )
          if (
            !matchesLoopEvent(loop.fields, {
              entity: "cycle",
              event: trigger.event as "started" | "completed",
              before: null,
              after,
            })
          )
            continue
          await enqueueLoopRun(
            tx,
            loop,
            `cycle:${cycle.id}:${trigger.event}:${boundary}`,
            {
              kind: "cycle",
              entity: "cycle",
              entityId: cycle.id,
              context: after,
            }
          )
          count++
        }
      }
    }
    return count
  })
}
export async function dispatchLoops(
  options: {
    limit?: number
    workspaceId?: string
    now?: Date
    executor?: LoopExecutor
    enqueueOnly?: boolean
  } = {}
) {
  if (!loopsEnabled())
    return { enabled: false, events: 0, scheduled: 0, executed: 0 }
  const limit = Math.max(1, Math.min(options.limit ?? 10, 100)),
    now = options.now ?? new Date()
  // A dead process cannot be assumed to have sent no provider request.
  await db
    .update(loopRuns)
    .set({
      state: "uncertain",
      errorCode: "WORKER_LEASE_EXPIRED",
      finishedAt: now,
    })
    .where(
      and(
        eq(loopRuns.state, "running"),
        lte(loopRuns.leaseAt, new Date(now.getTime() - 20 * 60_000)),
        options.workspaceId
          ? eq(loopRuns.workspaceId, options.workspaceId)
          : undefined
      )
    )
  const events = await enqueueNativeLoopEvents(limit * 10, options.workspaceId),
    scheduled = await enqueueScheduledLoops(now, options.workspaceId)
  let executed = 0
  for (let i = 0; i < (options.enqueueOnly ? 0 : limit); i++) {
    if (!(await executeNextLoopRun(options.executor, options.workspaceId)))
      break
    executed++
  }
  return { enabled: true, events, scheduled, executed }
}

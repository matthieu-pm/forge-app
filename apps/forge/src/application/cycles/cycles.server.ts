import "@tanstack/react-start/server-only"
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type {
  SharedCycleSnapshot,
  TeamCyclesSettings,
} from "@/lib/team-cycles-contract"
import { db, issueCycles, issues, productState, teams } from "@/db"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import {
  readableIssueCondition,
  readableTeamCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"
import {
  cycleTimezoneSchema,
  initialTeamCycles,
  parseTeamCycles,
  teamCyclesStorageKey,
} from "@/lib/team-cycles-contract"
import { addCycleDays, cycleToday, nextCycleDate } from "@/lib/cycle-calendar"

export async function lockTeamCycles(tx: Transaction, teamId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${teamId.toLowerCase()}, 4055))`
  )
}
// The caller owns the cycle lock before reading settings. Existing windows are immutable.
export async function ensureTeamCycles(
  tx: Transaction,
  workspaceId: string,
  teamId: string,
  settings: TeamCyclesSettings,
  timezone: string,
  now = new Date()
) {
  if (!settings.enabled) return
  timezone = cycleTimezoneSchema.parse(timezone)
  const today = cycleToday(timezone, now)
  const latest = (
    await tx
      .select()
      .from(issueCycles)
      .where(eq(issueCycles.teamId, teamId))
      .orderBy(desc(issueCycles.startDate))
      .limit(1)
  )[0]
  const future = await tx
    .select({ id: issueCycles.id })
    .from(issueCycles)
    .where(
      and(
        eq(issueCycles.teamId, teamId),
        sql`${issueCycles.startDate} > (${now.toISOString()}::timestamptz AT TIME ZONE ${issueCycles.timezone})::date::text`
      )
    )
    .limit(6)
  let next = latest
    ? nextCycleDate(
        addCycleDays(latest.endDate, settings.cooldown * 7 + 1),
        settings.startDay,
        false
      )
    : nextCycleDate(today, settings.startDay)
  if (next <= today) next = nextCycleDate(today, settings.startDay)
  for (let i = future.length; i < settings.futureCycles; i++) {
    const endDate = addCycleDays(next, settings.duration * 7 - 1)
    await tx
      .insert(issueCycles)
      .values({ workspaceId, teamId, startDate: next, endDate, timezone })
      .onConflictDoNothing()
    next = addCycleDays(endDate, settings.cooldown * 7 + 1)
  }
}
export async function readTeamCycles(
  actor: Actor,
  teamId: string,
  number?: number
): Promise<SharedCycleSnapshot> {
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    requireResourceScope(current, "issues:read")
    const team = (
      await tx
        .select()
        .from(teams)
        .where(
          and(eq(teams.id, teamId), readableTeamCondition(current, teams.id))
        )
        .for("share")
    )[0]
    if (!team) throw new ApplicationAccessError()
    await lockTeamCycles(tx, teamId)
    const row = (
      await tx
        .select()
        .from(productState)
        .where(
          and(
            eq(productState.workspaceId, current.workspaceId),
            eq(productState.ownerId, "workspace"),
            eq(productState.key, teamCyclesStorageKey(teamId))
          )
        )
    )[0]
    const stored = row?.encodedValue
      ? parseTeamCycles(JSON.parse(row.encodedValue))
      : initialTeamCycles()
    const settings = {
      ...stored,
      timezone: cycleTimezoneSchema.parse(stored.timezone ?? team.timezone),
    }
    await ensureTeamCycles(
      tx,
      current.workspaceId,
      teamId,
      settings,
      settings.timezone
    )
    // Bounded recent history plus the requested stable cycle number.
    const recent = await tx
      .select()
      .from(issueCycles)
      .where(
        and(
          eq(issueCycles.teamId, teamId),
          eq(issueCycles.workspaceId, current.workspaceId)
        )
      )
      .orderBy(desc(issueCycles.startDate))
      .limit(100)
    if (number && !recent.some((c) => c.number === number)) {
      const selected = (
        await tx
          .select()
          .from(issueCycles)
          .where(
            and(eq(issueCycles.teamId, teamId), eq(issueCycles.number, number))
          )
      )[0]
      if (selected) recent.push(selected)
    }
    const totals = await tx
      .select({
        cycleId: issues.cycleId,
        count: sql<number>`count(*)::int`,
        completed: sql<number>`count(*) FILTER (WHERE EXISTS (SELECT 1 FROM issue_statuses s WHERE s.workspace_id = ${issues.workspaceId} AND s.team_id = ${issues.teamId} AND s.id = ${issues.statusId} AND s.status_group = 'completed'))::int`,
      })
      .from(issues)
      .where(
        and(
          eq(issues.teamId, teamId),
          eq(issues.workspaceId, current.workspaceId),
          isNull(issues.archivedAt),
          isNull(issues.deletedAt),
          readableIssueCondition(current, issues.id)
        )
      )
      .groupBy(issues.cycleId)
    const counts = new Map(totals.map((t) => [t.cycleId, t]))
    const rows = recent.sort((a, b) => a.startDate.localeCompare(b.startDate))
    const now = new Date()
    const firstFuture = rows.find(
      (c) => c.startDate > cycleToday(c.timezone, now)
    )?.id
    return {
      workspaceId: current.workspaceId,
      userId: current.userId,
      sessionId:
        current.authentication.kind === "session"
          ? current.authentication.sessionId
          : "",
      settings,
      revision: row?.revision ?? 0,
      canManage: hasWorkspaceRole(current, ["owner", "admin"]),
      cycles: rows.map((c) => ({
        ...c,
        issueCount: counts.get(c.id)?.count ?? 0,
        completedCount: counts.get(c.id)?.completed ?? 0,
        state:
          c.endDate < cycleToday(c.timezone, now)
            ? "Past"
            : c.startDate <= cycleToday(c.timezone, now)
              ? "Current"
              : c.id === firstFuture
                ? "Upcoming"
                : "Planned",
      })),
    }
  })
}

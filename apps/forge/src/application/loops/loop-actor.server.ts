import "@tanstack/react-start/server-only"
import { and, eq, isNull } from "drizzle-orm"
import { loopsEnabled } from "./loop-access.server"
import { LOOP_RUN_WALL_CLOCK_MS } from "./loop-execution-policy"
import type { Actor, ApiScope } from "@/application/actor"
import type { Transaction } from "@/db"
import { loopRuns, teamLoops, teams, workspaceSecuritySettings } from "@/db"
import { ApplicationAccessError } from "@/application/authorization"

export const loopPrincipalId = (loopId: string) => `forge-loop:${loopId}`

const scopes: Array<ApiScope> = [
  "teams:read",
  "teams:write",
  "issues:read",
  "issues:write",
  "projects:read",
  "projects:write",
  "agents:read",
  "agents:write",
  "agents:approve",
  "model-connections:read",
]
export async function currentLoopActor(
  tx: Transaction,
  actor: Actor,
  runId: string
): Promise<Actor> {
  if (!loopsEnabled()) throw new ApplicationAccessError()
  const row = (
    await tx
      .select({ run: loopRuns, loop: teamLoops, team: teams })
      .from(loopRuns)
      .innerJoin(
        teamLoops,
        and(
          eq(teamLoops.id, loopRuns.loopId),
          eq(teamLoops.workspaceId, loopRuns.workspaceId)
        )
      )
      .innerJoin(
        teams,
        and(
          eq(teams.id, teamLoops.teamId),
          eq(teams.workspaceId, teamLoops.workspaceId)
        )
      )
      .where(
        and(
          eq(loopRuns.id, runId),
          eq(loopRuns.workspaceId, actor.workspaceId),
          isNull(teams.deletedAt)
        )
      )
      .for("share")
  )[0]
  const cancelling =
    actor.authentication.kind === "loop" &&
    actor.loopScope?.cancelling === true &&
    row?.run.pendingDecision?.action === "cancel-run"
  if (
    !row ||
    (row.run.pendingDecision?.action === "cancel-run" && !cancelling) ||
    ((!row.loop.enabled || row.loop.deletedAt) && !cancelling) ||
    (!cancelling &&
      (row.run.startedAt ?? row.run.leaseAt ?? row.run.createdAt).getTime() +
        LOOP_RUN_WALL_CLOCK_MS <=
        Date.now()) ||
    loopPrincipalId(row.loop.id) !== actor.userId ||
    (actor.authentication.kind === "agent" &&
      actor.authentication.runId !== row.run.agentRunId) ||
    !["running", "waiting-for-approval"].includes(row.run.state) ||
    (actor.authentication.kind === "loop" &&
      actor.authentication.loopId !== row.loop.id)
  )
    throw new ApplicationAccessError()
  if (!cancelling && row.run.event.kind === "webhook") {
    const security = (
      await tx
        .select({
          external: workspaceSecuritySettings.externalLoopSourcesEnabled,
        })
        .from(workspaceSecuritySettings)
        .where(eq(workspaceSecuritySettings.workspaceId, actor.workspaceId))
        .for("share")
    )[0]
    if (!security?.external) throw new ApplicationAccessError()
  }
  const scoped: Actor = {
    ...actor,
    workspaceRole: "member",
    scopes: cancelling
      ? ["agents:read", "agents:write"]
      : actor.scopes
        ? scopes.filter((s) => actor.scopes!.includes(s))
        : scopes,
    loopScope: {
      loopId: row.loop.id,
      runId,
      teamId: row.loop.teamId,
      ...(cancelling ? { cancelling: true } : {}),
      allPublic:
        row.team.visibility === "workspace" &&
        row.run.fields.teamAccess === "all-public-teams" &&
        row.loop.fields.teamAccess === "all-public-teams",
    },
  }
  const event = row.run.event
  if (
    !cancelling &&
    typeof event.entity === "string" &&
    ["issue", "project", "initiative", "cycle", "team"].includes(
      event.entity
    ) &&
    typeof event.entityId === "string"
  ) {
    const { authorizedLoopEntity, loopActivityContext } =
      await import("./loop-context.server")
    const raw = await authorizedLoopEntity(
      tx,
      scoped,
      event.entity as Parameters<typeof authorizedLoopEntity>[2],
      event.entityId,
      row.loop.teamId
    )
    loopActivityContext(raw, event)
  }
  return scoped
}
export async function linkedLoopActor(
  tx: Transaction,
  actor: Actor,
  agentRunId: string
) {
  const row = (
    await tx
      .select({ id: loopRuns.id })
      .from(loopRuns)
      .where(eq(loopRuns.agentRunId, agentRunId))
  )[0]
  return row ? currentLoopActor(tx, actor, row.id) : null
}

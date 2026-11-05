import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import { agentRuns, agentThreads, apiKeys, members, sessions } from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import {
  FORGE_API_KEY_CONFIG_ID,
  permissionsToScopes,
} from "@/application/api-keys/api-key-contract"

/** Lock the live authority until commit, including replays; never trust a stale role. */
export async function currentCommandActor(
  tx: Transaction,
  actor: Actor
): Promise<Actor> {
  const authentication = actor.authentication
  let scopes = actor.scopes
  let loopRunId: string | undefined
  if (authentication.kind === "recurring") {
    const { currentRecurringActor } =
      await import("../recurring-issues/recurring-actor.server")
    return currentRecurringActor(tx, actor, authentication.scheduleId)
  }
  if (authentication.kind === "loop") {
    const { currentLoopActor } =
      await import("@/application/loops/loop-actor.server")
    return currentLoopActor(tx, actor, authentication.runId)
  }
  if (authentication.kind === "apiKey") {
    const key = (
      await tx
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, authentication.credentialId))
        .for("share")
    ).at(0)
    if (
      !key ||
      !key.enabled ||
      key.configId !== FORGE_API_KEY_CONFIG_ID ||
      key.referenceId !== actor.userId ||
      (key.expiresAt && key.expiresAt <= new Date())
    )
      throw new ApplicationAccessError()
    try {
      const metadata = JSON.parse(key.metadata ?? "null") as {
        workspaceId?: string
      } | null
      if (metadata?.workspaceId !== actor.workspaceId)
        throw new ApplicationAccessError()
      const current = permissionsToScopes(JSON.parse(key.permissions ?? "null"))
      scopes = current.filter((scope) => actor.scopes?.includes(scope))
    } catch {
      throw new ApplicationAccessError()
    }
  } else if (authentication.kind === "session") {
    const session = (
      await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, authentication.sessionId))
        .for("share")
    ).at(0)
    if (
      !session ||
      session.userId !== actor.userId ||
      session.expiresAt <= new Date() ||
      session.activeOrganizationId !== actor.workspaceId
    )
      throw new ApplicationAccessError()
  } else {
    const run = (
      await tx
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, authentication.runId))
        .for("share")
    ).at(0)
    if (
      !run ||
      run.initiatedByUserId !== actor.userId ||
      !["running", "waiting-for-approval"].includes(run.state)
    )
      throw new ApplicationAccessError()
    const thread = (
      await tx
        .select()
        .from(agentThreads)
        .where(
          and(
            eq(agentThreads.id, run.threadId),
            eq(agentThreads.workspaceId, actor.workspaceId)
          )
        )
        .for("share")
    ).at(0)
    if (!thread) throw new ApplicationAccessError()
    if (typeof run.requestedSelection.loopRunId === "string")
      loopRunId = run.requestedSelection.loopRunId
  }
  if (loopRunId) {
    const { currentLoopActor } =
      await import("@/application/loops/loop-actor.server")
    return currentLoopActor(tx, actor, loopRunId)
  }
  const membership = (
    await tx
      .select()
      .from(members)
      .where(
        and(
          eq(members.organizationId, actor.workspaceId),
          eq(members.userId, actor.userId)
        )
      )
      .for("share")
  ).at(0)
  if (!membership) throw new ApplicationAccessError()
  return { ...actor, workspaceRole: membership.role, scopes }
}

export function commandPrincipal(actor: Actor) {
  if (actor.authentication.kind === "recurring")
    return `recurring:${actor.authentication.scheduleId}`
  if (actor.authentication.kind === "loop")
    return `loop:${actor.authentication.loopId}:${actor.authentication.runId}`
  return actor.authentication.kind === "apiKey"
    ? `apiKey:${actor.authentication.credentialId}`
    : actor.authentication.kind === "agent"
      ? `agent:${actor.authentication.runId}:${actor.userId}`
      : `user:${actor.userId}`
}

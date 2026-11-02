import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import { agentApprovals, db, loopRuns } from "@/db"
import { requireCurrentActor } from "@/application/resource-policy.server"
import { ApplicationAccessError } from "@/application/authorization"
/** Shared automation is never a personal conversation, including for its configurator. */
export async function authorizeLoopAgentThread(actor: Actor, threadId: string) {
  actor = await requireCurrentActor(actor)
  const run = (
    await db
      .select({ id: loopRuns.id })
      .from(loopRuns)
      .where(
        and(
          eq(loopRuns.threadId, threadId),
          eq(loopRuns.workspaceId, actor.workspaceId)
        )
      )
      .limit(1)
  )[0]
  if (run && actor.loopScope?.runId !== run.id)
    throw new ApplicationAccessError(
      "Use the shared Loop run history to review this automation."
    )
}
export async function authorizeLoopAgentApproval(
  actor: Actor,
  approvalId: string
) {
  const row = (
    await db
      .select({ threadId: loopRuns.threadId })
      .from(agentApprovals)
      .innerJoin(loopRuns, eq(loopRuns.agentRunId, agentApprovals.runId))
      .where(
        and(
          eq(agentApprovals.id, approvalId),
          eq(loopRuns.workspaceId, actor.workspaceId)
        )
      )
      .limit(1)
  )[0]
  if (row) await authorizeLoopAgentThread(actor, row.threadId)
}

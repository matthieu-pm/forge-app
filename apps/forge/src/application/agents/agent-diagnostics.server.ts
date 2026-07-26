import "@tanstack/react-start/server-only"

import { and, eq, gte } from "drizzle-orm"

import type { Actor } from "@/application/actor"
import { requireAgentRead } from "@/application/agents/agent-authorization"
import { summarizeAgentDiagnostics } from "@/application/agents/agent-diagnostics"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import {
  agentApprovals,
  agentCapabilityInvocations,
  agentEvents,
  agentRuns,
  agentThreads,
  db,
} from "@/db"

export async function getAgentDiagnostics(actor: Actor, since: Date) {
  requireAgentRead(actor)
  if (!hasWorkspaceRole(actor, ["owner", "admin"])) {
    throw new ApplicationAccessError(
      "Only a workspace owner or admin can read agent diagnostics."
    )
  }

  const [runs, events, approvals, invocations] = await Promise.all([
    db
      .select({
        id: agentRuns.id,
        state: agentRuns.state,
        executionKind: agentRuns.executionKind,
        requestedSelection: agentRuns.requestedSelection,
        resolvedModelId: agentRuns.resolvedModelId,
        reasoningEffort: agentRuns.reasoningEffort,
        routingReason: agentRuns.routingReason,
        inputTokens: agentRuns.inputTokens,
        outputTokens: agentRuns.outputTokens,
        cachedInputTokens: agentRuns.cachedInputTokens,
        costMicros: agentRuns.costMicros,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
      })
      .from(agentRuns)
      .innerJoin(agentThreads, eq(agentRuns.threadId, agentThreads.id))
      .where(
        and(
          eq(agentThreads.workspaceId, actor.workspaceId),
          gte(agentRuns.createdAt, since)
        )
      ),
    db
      .select({
        runId: agentEvents.runId,
        type: agentEvents.type,
        payload: agentEvents.payloadJson,
        occurredAt: agentEvents.occurredAt,
      })
      .from(agentEvents)
      .innerJoin(agentThreads, eq(agentEvents.threadId, agentThreads.id))
      .where(
        and(
          eq(agentThreads.workspaceId, actor.workspaceId),
          gte(agentEvents.occurredAt, since)
        )
      ),
    db
      .select({ state: agentApprovals.state })
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.workspaceId, actor.workspaceId),
          gte(agentApprovals.requestedAt, since)
        )
      ),
    db
      .select({
        outcome: agentCapabilityInvocations.outcome,
        durationMs: agentCapabilityInvocations.durationMs,
      })
      .from(agentCapabilityInvocations)
      .where(
        and(
          eq(agentCapabilityInvocations.workspaceId, actor.workspaceId),
          gte(agentCapabilityInvocations.createdAt, since)
        )
      ),
  ])

  return summarizeAgentDiagnostics({
    since,
    runs,
    events,
    approvals,
    invocations,
  })
}

import "@tanstack/react-start/server-only"

import { and, eq, isNull } from "drizzle-orm"
import { DrizzleAgentApprovalStore } from "./drizzle-approval-store.server"
import { DrizzleAgentStore } from "./drizzle-agent-store.server"
import { DrizzleAgentEventStore } from "./drizzle-event-store.server"
import type { Actor } from "@/application/actor"
import type {
  CapabilityInvocation,
  CapabilityResult,
} from "@/application/agents/capability-contract"
import type { CapabilityExecutionContext } from "@/application/agents/capability-gateway.server"
import type { Transaction } from "@/db"
import { agentCapabilityInvocations, teams } from "@/db"
import {
  ApplicationAccessError,
  canManageTeams,
  hasScope,
} from "@/application/authorization"
import {
  ApprovalError,
  ApprovalService,
  hashApprovalInput,
} from "@/application/agents/approval-service.server"
import {
  CommandConflictError,
  executeCommand,
} from "@/application/commands/execute-command.server"
import {
  teamSummarySchema,
  updateTeamInputSchema,
} from "@/application/teams/team-schemas"
import { readableTeamCondition } from "@/application/resource-policy.server"
import { updateTeam } from "@/application/teams/teams.server"

export type ConsumeCommandApproval = (
  tx: Transaction,
  actor: Actor,
  invocation: CapabilityInvocation,
  context: CapabilityExecutionContext
) => Promise<void>

/** The only registered SQL write. New capabilities must add a transaction adapter. */
export async function executeCapabilityCommand(
  actor: Actor,
  invocation: CapabilityInvocation,
  context: CapabilityExecutionContext,
  consume: ConsumeCommandApproval
): Promise<CapabilityResult> {
  if (
    invocation.capabilityId !== "teams.update" ||
    invocation.capabilityVersion !== "1"
  )
    return {
      ok: false,
      errorCode: "CAPABILITY_NOT_FOUND",
      errorMessage: "No transactional write adapter is registered.",
    }
  if (!invocation.idempotencyKey)
    return {
      ok: false,
      errorCode: "IDEMPOTENCY_KEY_REQUIRED",
      errorMessage: "Write capabilities require an idempotency key.",
    }
  try {
    const input = updateTeamInputSchema.parse(invocation.input)
    const execution = await executeCommand({
      actor,
      commandKey: invocation.idempotencyKey,
      operation: `capability:${invocation.capabilityId}@${invocation.capabilityVersion}:${context.runId}`,
      input: invocation.input,
      status: 200,
      parse: (v) => teamSummarySchema.parse(v),
      authorize: async (tx, current, value) => {
        if (
          !canManageTeams(current) ||
          !hasScope(current, "teams:read") ||
          (current.authentication.kind === "agent" &&
            current.authentication.runId !== context.runId)
        )
          throw new ApplicationAccessError()
        const rows = await tx
          .select()
          .from(teams)
          .where(
            and(
              readableTeamCondition(current, teams.id),
              value ? eq(teams.id, value.id) : eq(teams.slug, input.slug),
              isNull(teams.deletedAt)
            )
          )
          .for(value ? "share" : "update")
        if (!rows.at(0)) throw new ApplicationAccessError()
      },
      legacy: async (tx) => {
        const old = (
          await tx
            .select()
            .from(agentCapabilityInvocations)
            .where(
              and(
                eq(agentCapabilityInvocations.workspaceId, actor.workspaceId),
                eq(agentCapabilityInvocations.userId, actor.userId),
                eq(agentCapabilityInvocations.runId, context.runId),
                eq(
                  agentCapabilityInvocations.capabilityId,
                  invocation.capabilityId
                ),
                eq(
                  agentCapabilityInvocations.capabilityVersion,
                  invocation.capabilityVersion
                ),
                eq(
                  agentCapabilityInvocations.idempotencyKey,
                  invocation.idempotencyKey!
                )
              )
            )
            .for("share")
        ).at(0)
        if (!old) return null
        if (old.inputHash !== hashApprovalInput(invocation.input))
          throw new CommandConflictError(
            "reused",
            "The invocation key was used with different input."
          )
        const result = old.resultJson as CapabilityResult | null
        if (old.state !== "completed" || !result?.ok)
          throw new CommandConflictError(
            "ambiguous",
            "The legacy invocation requires reconciliation."
          )
        return { value: teamSummarySchema.parse(result.value) }
      },
      run: async (tx, current) => {
        await consume(tx, current, invocation, context)
        const result = await updateTeam(
          current,
          { slug: input.slug },
          input.settings,
          tx
        )
        if (!result.ok) throw new Error(result.code)
        const value = teamSummarySchema.parse(result.team)
        if (
          new TextEncoder().encode(JSON.stringify(value)).byteLength >
          64 * 1024
        )
          throw new Error("CAPABILITY_RESULT_TOO_LARGE")
        return {
          value,
          resource: { type: "team", id: value.id },
          events: [
            { topic: "teams.updated.v1", payload: { teamId: value.id } },
          ],
        }
      },
    })
    return { ok: true, value: execution.value }
  } catch (error) {
    if (error instanceof CommandConflictError)
      return {
        ok: false,
        errorCode:
          error.reason === "reused"
            ? "IDEMPOTENCY_KEY_CONFLICT"
            : "IDEMPOTENCY_RECONCILIATION_REQUIRED",
        errorMessage: error.message,
      }
    if (error instanceof ApprovalError)
      return { ok: false, errorCode: error.code, errorMessage: error.message }
    if (error instanceof ApplicationAccessError)
      return { ok: false, errorCode: "FORBIDDEN", errorMessage: error.message }
    if (error instanceof Error && error.name === "ZodError")
      return {
        ok: false,
        errorCode: "INVALID_CAPABILITY_INPUT",
        errorMessage: "The capability input or output is invalid.",
      }
    return {
      ok: false,
      errorCode: "CAPABILITY_EXECUTION_FAILED",
      errorMessage: "The capability execution failed.",
    }
  }
}

export const consumeCapabilityCommandApproval: ConsumeCommandApproval = async (
  tx,
  current,
  call,
  execution
) => {
  const approvals = new ApprovalService({
    approvals: new DrizzleAgentApprovalStore(tx),
    agents: new DrizzleAgentStore(),
    events: new DrizzleAgentEventStore(),
  })
  const binding = {
    runId: execution.runId,
    capabilityId: call.capabilityId,
    capabilityVersion: call.capabilityVersion,
    capabilityInput: call.input,
  }
  const approvalId =
    call.approvalId ??
    (await approvals.findApprovedForInvocation(current, binding))?.id
  if (!approvalId)
    throw new ApprovalError(
      "APPROVAL_NOT_FOUND",
      "This capability requires an approval."
    )
  await approvals.consume(current, { ...binding, approvalId })
}

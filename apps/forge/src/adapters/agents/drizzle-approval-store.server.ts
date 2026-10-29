import "@tanstack/react-start/server-only"

import { and, eq } from "drizzle-orm"

import type { DatabaseExecutor } from "@/db"
import type { AgentApprovalStore } from "@/application/agents/approval-store"
import type {
  AgentApprovalRecord,
  ApprovalState,
} from "@/application/agents/approval-contract"
import { agentApprovals, db } from "@/db"

function toRecord(
  approval: typeof agentApprovals.$inferSelect
): AgentApprovalRecord {
  return {
    ...approval,
    risk: approval.risk as AgentApprovalRecord["risk"],
    state: approval.state as ApprovalState,
  }
}

export class DrizzleAgentApprovalStore implements AgentApprovalStore {
  constructor(private readonly executor: DatabaseExecutor = db) {}
  async create(record: AgentApprovalRecord) {
    const rows = await this.executor
      .insert(agentApprovals)
      .values(record)
      .onConflictDoNothing({ target: agentApprovals.id })
      .returning()
    const inserted = rows.at(0)
    if (inserted) return toRecord(inserted)
    const existing = await this.get(record.id)
    if (!existing) throw new Error("The approval could not be created.")
    return existing
  }

  async get(approvalId: string) {
    const rows = await this.executor
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.id, approvalId))
      .limit(1)
    const approval = rows.at(0)
    return approval ? toRecord(approval) : null
  }

  async findApproved(input: {
    workspaceId: string
    runId: string
    requestedForUserId: string
    capabilityId: string
    capabilityVersion: string
    inputHash: string
  }) {
    const rows = await this.executor
      .select()
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.workspaceId, input.workspaceId),
          eq(agentApprovals.runId, input.runId),
          eq(agentApprovals.requestedForUserId, input.requestedForUserId),
          eq(agentApprovals.capabilityId, input.capabilityId),
          eq(agentApprovals.capabilityVersion, input.capabilityVersion),
          eq(agentApprovals.inputHash, input.inputHash),
          eq(agentApprovals.state, "approved")
        )
      )
      .limit(1)
    const approval = rows.at(0)
    return approval ? toRecord(approval) : null
  }

  async listApprovedProgramGrants(input: {
    workspaceId: string
    runId: string
    requestedForUserId: string
  }) {
    const rows = await this.executor
      .select()
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.workspaceId, input.workspaceId),
          eq(agentApprovals.runId, input.runId),
          eq(agentApprovals.requestedForUserId, input.requestedForUserId),
          eq(agentApprovals.capabilityId, "program.execute"),
          eq(agentApprovals.state, "approved")
        )
      )
    return rows.map(toRecord)
  }

  async compareAndSetState(input: {
    approvalId: string
    expectedState: ApprovalState
    nextState: ApprovalState
    resolvedAt?: Date
    resolvedByUserId?: string
  }) {
    const rows = await this.executor
      .update(agentApprovals)
      .set({
        state: input.nextState,
        ...(input.resolvedAt ? { resolvedAt: input.resolvedAt } : {}),
        ...(input.resolvedByUserId
          ? { resolvedByUserId: input.resolvedByUserId }
          : {}),
      })
      .where(
        and(
          eq(agentApprovals.id, input.approvalId),
          eq(agentApprovals.state, input.expectedState)
        )
      )
      .returning()
    const approval = rows.at(0)
    return approval ? toRecord(approval) : null
  }
}

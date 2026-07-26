import type { AgentApprovalStore } from "@/application/agents/approval-store"
import type {
  AgentApprovalRecord,
  ApprovalState,
} from "@/application/agents/approval-contract"

export class InMemoryAgentApprovalStore implements AgentApprovalStore {
  readonly approvals = new Map<string, AgentApprovalRecord>()

  async create(record: AgentApprovalRecord) {
    const existing = this.approvals.get(record.id)
    if (existing) return existing
    this.approvals.set(record.id, record)
    return record
  }

  async get(approvalId: string) {
    return this.approvals.get(approvalId) ?? null
  }

  async findApproved(input: {
    workspaceId: string
    runId: string
    requestedForUserId: string
    capabilityId: string
    capabilityVersion: string
    inputHash: string
  }) {
    return (
      [...this.approvals.values()].find(
        (approval) =>
          approval.workspaceId === input.workspaceId &&
          approval.runId === input.runId &&
          approval.requestedForUserId === input.requestedForUserId &&
          approval.capabilityId === input.capabilityId &&
          approval.capabilityVersion === input.capabilityVersion &&
          approval.inputHash === input.inputHash &&
          approval.state === "approved"
      ) ?? null
    )
  }

  async listApprovedProgramGrants(input: {
    workspaceId: string
    runId: string
    requestedForUserId: string
  }) {
    return [...this.approvals.values()].filter(
      (approval) =>
        approval.workspaceId === input.workspaceId &&
        approval.runId === input.runId &&
        approval.requestedForUserId === input.requestedForUserId &&
        approval.capabilityId === "program.execute" &&
        approval.state === "approved"
    )
  }

  async compareAndSetState(input: {
    approvalId: string
    expectedState: ApprovalState
    nextState: ApprovalState
    resolvedAt?: Date
    resolvedByUserId?: string
  }) {
    const record = this.approvals.get(input.approvalId)
    if (!record || record.state !== input.expectedState) return null
    const updated: AgentApprovalRecord = {
      ...record,
      state: input.nextState,
      resolvedAt: input.resolvedAt ?? record.resolvedAt,
      resolvedByUserId: input.resolvedByUserId ?? record.resolvedByUserId,
    }
    this.approvals.set(updated.id, updated)
    return updated
  }
}

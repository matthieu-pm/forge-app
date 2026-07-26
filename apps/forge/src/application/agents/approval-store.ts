import type {
  AgentApprovalRecord,
  ApprovalState,
} from "@/application/agents/approval-contract"

export interface AgentApprovalStore {
  create: (record: AgentApprovalRecord) => Promise<AgentApprovalRecord>
  get: (approvalId: string) => Promise<AgentApprovalRecord | null>
  findApproved: (input: {
    workspaceId: string
    runId: string
    requestedForUserId: string
    capabilityId: string
    capabilityVersion: string
    inputHash: string
  }) => Promise<AgentApprovalRecord | null>
  listApprovedProgramGrants: (input: {
    workspaceId: string
    runId: string
    requestedForUserId: string
  }) => Promise<Array<AgentApprovalRecord>>
  compareAndSetState: (input: {
    approvalId: string
    expectedState: ApprovalState
    nextState: ApprovalState
    resolvedAt?: Date
    resolvedByUserId?: string
  }) => Promise<AgentApprovalRecord | null>
}

import type { CapabilityResult } from "@/application/agents/capability-contract"

export type CapabilityInvocationRecord = {
  id: string
  workspaceId: string
  userId: string
  runId: string
  approvalId: string
  capabilityId: string
  capabilityVersion: string
  idempotencyKey: string
  inputHash: string
  state: "in-progress" | "completed"
  outcome: "succeeded" | "failed" | null
  durationMs: number | null
  result: CapabilityResult | null
  createdAt: Date
  expiresAt: Date
}

export interface CapabilityIdempotencyStore {
  reserve: (
    record: CapabilityInvocationRecord
  ) => Promise<
    | { kind: "reserved"; record: CapabilityInvocationRecord }
    | { kind: "existing"; record: CapabilityInvocationRecord }
  >
  complete: (
    recordId: string,
    result: CapabilityResult,
    durationMs: number
  ) => Promise<CapabilityInvocationRecord | null>
  release: (recordId: string) => Promise<void>
}

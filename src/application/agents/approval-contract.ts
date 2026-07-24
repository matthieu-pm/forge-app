import { z } from "zod"

import type { AgentEvent } from "@/application/agents/event-contract"
import { CAPABILITY_RISKS } from "@/application/agents/capability-contract"

export const APPROVAL_STATES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "consumed",
] as const

export const approvalDecisionSchema = z.enum(["approved", "denied"])

export const resolveApprovalInputSchema = z
  .object({
    decision: approvalDecisionSchema,
  })
  .strict()

export const approvalRequestSchema = z
  .object({
    approvalId: z.string().uuid().optional(),
    runId: z.string().uuid(),
    capabilityId: z.string().trim().min(1).max(255),
    capabilityVersion: z.string().trim().min(1).max(50).default("1"),
    risk: z.enum(CAPABILITY_RISKS),
    input: z.record(z.string(), z.unknown()),
    redactedInputSummary: z.record(z.string(), z.unknown()),
    expiresAt: z.date().optional(),
  })
  .strict()

export type ApprovalState = (typeof APPROVAL_STATES)[number]
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>

export type AgentApprovalRecord = {
  id: string
  workspaceId: string
  runId: string
  requestedForUserId: string
  capabilityId: string
  capabilityVersion: string
  risk: (typeof CAPABILITY_RISKS)[number]
  inputHash: string
  redactedInputSummary: Record<string, unknown>
  state: ApprovalState
  nonce: string
  requestedAt: Date
  expiresAt: Date
  resolvedAt: Date | null
  resolvedByUserId: string | null
}

export type ApprovalResolution = {
  approval: AgentApprovalRecord
  event: AgentEvent
}

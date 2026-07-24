import "@tanstack/react-start/server-only"

import { createHash, randomUUID } from "node:crypto"

import type { Actor } from "@/application/actor"
import type {
  AgentApprovalRecord,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolution,
} from "@/application/agents/approval-contract"
import type { AgentApprovalStore } from "@/application/agents/approval-store"
import type { AgentStore } from "@/application/agents/agent-store"
import type { AgentEventStore } from "@/application/agents/event-store"
import {
  requireAgentApproval,
  requireAgentRun,
} from "@/application/agents/agent-authorization"

export type ApprovalErrorCode =
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_BINDING_MISMATCH"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_NOT_PENDING"
  | "APPROVAL_NOT_APPROVED"

export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string
  ) {
    super(message)
    this.name = "ApprovalError"
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    )
  }
  return value
}

export function hashApprovalInput(input: Record<string, unknown>) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(input)))
    .digest("hex")
}

function programGrantAllows(
  approval: AgentApprovalRecord,
  capabilityId: string,
  capabilityVersion: string
) {
  if (approval.capabilityId !== "program.execute") return false
  const details = approval.redactedInputSummary.details
  if (!details || typeof details !== "object") return false
  const manifest = Reflect.get(details, "programManifest")
  return (
    Array.isArray(manifest) &&
    manifest.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        Reflect.get(entry, "id") === capabilityId &&
        Reflect.get(entry, "version") === capabilityVersion
    )
  )
}

type ApprovalServiceDependencies = {
  approvals: AgentApprovalStore
  agents: AgentStore
  events: AgentEventStore
  id?: () => string
  now?: () => Date
  ttlMs?: number
}

export class ApprovalService {
  readonly #id: () => string
  readonly #now: () => Date
  readonly #ttlMs: number

  constructor(private readonly dependencies: ApprovalServiceDependencies) {
    this.#id = dependencies.id ?? randomUUID
    this.#now = dependencies.now ?? (() => new Date())
    this.#ttlMs = dependencies.ttlMs ?? 5 * 60_000
  }

  async request(
    actor: Actor,
    input: ApprovalRequest
  ): Promise<ApprovalResolution> {
    requireAgentRun(actor)
    const run = await this.dependencies.agents.getRun(
      actor.workspaceId,
      input.runId
    )
    if (!run || run.initiatedByUserId !== actor.userId) {
      throw new ApprovalError(
        "APPROVAL_BINDING_MISMATCH",
        "The approval request is not bound to this user and run."
      )
    }
    const thread = await this.dependencies.agents.getThread(
      actor.workspaceId,
      run.threadId
    )
    if (!thread) {
      throw new ApprovalError(
        "APPROVAL_BINDING_MISMATCH",
        "The approval request is not bound to this workspace."
      )
    }

    const now = this.#now()
    const record: AgentApprovalRecord = {
      id: input.approvalId ?? this.#id(),
      workspaceId: actor.workspaceId,
      runId: run.id,
      requestedForUserId: actor.userId,
      capabilityId: input.capabilityId,
      capabilityVersion: input.capabilityVersion,
      risk: input.risk,
      inputHash: hashApprovalInput(input.input),
      redactedInputSummary: input.redactedInputSummary,
      state: "pending",
      nonce: this.#id(),
      requestedAt: now,
      expiresAt: input.expiresAt ?? new Date(now.getTime() + this.#ttlMs),
      resolvedAt: null,
      resolvedByUserId: null,
    }
    const approval = await this.dependencies.approvals.create(record)
    this.assertSameRequest(approval, record)
    const event = await this.dependencies.events.append({
      threadId: thread.id,
      runId: run.id,
      sourceEventId: `approval:${approval.id}:requested`,
      occurredAt: approval.requestedAt.toISOString(),
      source: "forge",
      type: "approval.requested",
      schemaVersion: 1,
      payload: {
        approvalId: approval.id,
        capabilityId: approval.capabilityId,
        capabilityVersion: approval.capabilityVersion,
        risk: approval.risk,
        inputHash: approval.inputHash,
        summary: approval.redactedInputSummary,
        expiresAt: approval.expiresAt.toISOString(),
      },
    })
    await this.dependencies.agents.updateRun(run.id, {
      state: "waiting-for-approval",
    })
    return { approval, event }
  }

  async resolve(
    actor: Actor,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<ApprovalResolution> {
    requireAgentApproval(actor)
    const existing = await this.requireBoundApproval(actor, approvalId)
    const now = this.#now()
    if (existing.expiresAt.getTime() <= now.getTime()) {
      if (existing.state === "pending") {
        await this.dependencies.approvals.compareAndSetState({
          approvalId,
          expectedState: "pending",
          nextState: "expired",
          resolvedAt: now,
          resolvedByUserId: actor.userId,
        })
      }
      throw new ApprovalError(
        "APPROVAL_EXPIRED",
        "This approval request has expired."
      )
    }
    if (existing.state !== "pending") {
      throw new ApprovalError(
        "APPROVAL_NOT_PENDING",
        "This approval request has already been resolved."
      )
    }
    const approval = await this.dependencies.approvals.compareAndSetState({
      approvalId,
      expectedState: "pending",
      nextState: decision,
      resolvedAt: now,
      resolvedByUserId: actor.userId,
    })
    if (!approval) {
      throw new ApprovalError(
        "APPROVAL_NOT_PENDING",
        "This approval request has already been resolved."
      )
    }
    const run = await this.dependencies.agents.getRun(
      actor.workspaceId,
      approval.runId
    )
    if (!run) {
      throw new ApprovalError(
        "APPROVAL_BINDING_MISMATCH",
        "The approval run is unavailable."
      )
    }
    const event = await this.dependencies.events.append({
      threadId: run.threadId,
      runId: run.id,
      sourceEventId: `approval:${approval.id}:resolved`,
      occurredAt: now.toISOString(),
      source: "forge",
      type: "approval.resolved",
      schemaVersion: 1,
      payload: {
        approvalId: approval.id,
        decision,
        inputHash: approval.inputHash,
      },
    })
    await this.dependencies.agents.updateRun(run.id, {
      // A denial is a tool result, not a cancelled agent turn. Both decisions
      // resume the parked runtime so it can either execute the approved action
      // or continue safely after the denied one.
      state: "running",
    })
    return { approval, event }
  }

  async consume(
    actor: Actor,
    input: {
      approvalId: string
      runId: string
      capabilityId: string
      capabilityVersion: string
      capabilityInput: Record<string, unknown>
    }
  ) {
    const approval = await this.requireBoundApproval(actor, input.approvalId)
    const isProgramGrant = programGrantAllows(
      approval,
      input.capabilityId,
      input.capabilityVersion
    )
    if (
      approval.runId !== input.runId ||
      (!isProgramGrant &&
        (approval.capabilityId !== input.capabilityId ||
          approval.capabilityVersion !== input.capabilityVersion ||
          approval.inputHash !== hashApprovalInput(input.capabilityInput)))
    ) {
      throw new ApprovalError(
        "APPROVAL_BINDING_MISMATCH",
        "The approval does not match this exact capability invocation."
      )
    }
    const now = this.#now()
    if (approval.expiresAt.getTime() <= now.getTime()) {
      throw new ApprovalError(
        "APPROVAL_EXPIRED",
        "This approval request has expired."
      )
    }
    if (approval.state !== "approved") {
      throw new ApprovalError(
        "APPROVAL_NOT_APPROVED",
        "This approval is not approved or has already been consumed."
      )
    }
    if (isProgramGrant) {
      // EVE consumes the one-time approval response for the exact approved
      // program. Nested calls may use the grant only for capabilities in that
      // program's declared manifest; write replay remains idempotent.
      return approval
    }
    const consumed = await this.dependencies.approvals.compareAndSetState({
      approvalId: approval.id,
      expectedState: "approved",
      nextState: "consumed",
    })
    if (!consumed) {
      throw new ApprovalError(
        "APPROVAL_NOT_APPROVED",
        "This approval has already been consumed."
      )
    }
    return consumed
  }

  async findApprovedForInvocation(
    actor: Actor,
    input: {
      runId: string
      capabilityId: string
      capabilityVersion: string
      capabilityInput: Record<string, unknown>
    }
  ) {
    const approval = await this.dependencies.approvals.findApproved({
      workspaceId: actor.workspaceId,
      runId: input.runId,
      requestedForUserId: actor.userId,
      capabilityId: input.capabilityId,
      capabilityVersion: input.capabilityVersion,
      inputHash: hashApprovalInput(input.capabilityInput),
    })
    let matchingApproval = approval
    if (!matchingApproval) {
      const grants =
        await this.dependencies.approvals.listApprovedProgramGrants({
          workspaceId: actor.workspaceId,
          runId: input.runId,
          requestedForUserId: actor.userId,
        })
      matchingApproval =
        grants.find((grant) =>
          programGrantAllows(
            grant,
            input.capabilityId,
            input.capabilityVersion
          )
        ) ?? null
    }
    if (!matchingApproval) return null
    if (
      actor.authentication.kind === "agent" &&
      actor.authentication.runId !== matchingApproval.runId
    ) {
      return null
    }
    if (matchingApproval.expiresAt.getTime() <= this.#now().getTime()) {
      return null
    }
    return matchingApproval
  }

  private async requireBoundApproval(actor: Actor, approvalId: string) {
    const approval = await this.dependencies.approvals.get(approvalId)
    if (!approval) {
      throw new ApprovalError(
        "APPROVAL_NOT_FOUND",
        "The approval request was not found."
      )
    }
    if (
      approval.workspaceId !== actor.workspaceId ||
      approval.requestedForUserId !== actor.userId
    ) {
      throw new ApprovalError(
        "APPROVAL_BINDING_MISMATCH",
        "The approval is not bound to this user and workspace."
      )
    }
    if (
      actor.authentication.kind === "agent" &&
      actor.authentication.runId !== approval.runId
    ) {
      throw new ApprovalError(
        "APPROVAL_BINDING_MISMATCH",
        "The approval is not bound to this agent run."
      )
    }
    return approval
  }

  private assertSameRequest(
    existing: AgentApprovalRecord,
    expected: AgentApprovalRecord
  ) {
    if (
      existing.workspaceId !== expected.workspaceId ||
      existing.runId !== expected.runId ||
      existing.requestedForUserId !== expected.requestedForUserId ||
      existing.capabilityId !== expected.capabilityId ||
      existing.capabilityVersion !== expected.capabilityVersion ||
      existing.inputHash !== expected.inputHash
    ) {
      throw new ApprovalError(
        "APPROVAL_BINDING_MISMATCH",
        "The approval identifier was already used for another request."
      )
    }
  }
}

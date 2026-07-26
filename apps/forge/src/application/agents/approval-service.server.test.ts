import { describe, expect, it } from "vitest"

import type { Actor } from "@/application/actor"
import { ApprovalService } from "@/application/agents/approval-service.server"
import { InMemoryAgentApprovalStore } from "@/adapters/agents/in-memory-approval-store"
import { InMemoryAgentEventStore } from "@/adapters/agents/in-memory-event-store"
import { InMemoryAgentStore } from "@/adapters/agents/in-memory-agent-store"

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001"
const USER_ID = "20000000-0000-4000-8000-000000000001"
const THREAD_ID = "30000000-0000-4000-8000-000000000001"
const RUN_ID = "40000000-0000-4000-8000-000000000001"
const APPROVAL_ID = "50000000-0000-4000-8000-000000000001"

const sessionActor: Actor = {
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  workspaceRole: "owner",
  authentication: { kind: "session", sessionId: "session-1" },
  scopes: null,
}

async function fixture(now = new Date("2026-07-24T10:00:00.000Z")) {
  const agents = new InMemoryAgentStore()
  const approvals = new InMemoryAgentApprovalStore()
  const events = new InMemoryAgentEventStore()
  await agents.createThread({
    id: THREAD_ID,
    workspaceId: WORKSPACE_ID,
    createdByUserId: USER_ID,
    title: "Approval test",
    status: "active",
    runtimeKind: "eve",
    runtimeSessionId: null,
    createdAt: now,
  })
  await agents.createRun({
    id: RUN_ID,
    threadId: THREAD_ID,
    initiatedByUserId: USER_ID,
    state: "running",
    executionKind: "forge-native",
    requestedSelection: {},
    resolvedConnectionId: null,
    resolvedModelId: null,
    reasoningEffort: null,
    routingPolicyVersion: null,
    routingReason: null,
    runtimeRunId: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costMicros: 0,
    startedAt: now,
    completedAt: null,
    errorCode: null,
  })
  let current = now
  const service = new ApprovalService({
    approvals,
    agents,
    events,
    id: (() => {
      let count = 0
      return () =>
        count++ === 0
          ? APPROVAL_ID
          : `60000000-0000-4000-8000-${String(count).padStart(12, "0")}`
    })(),
    now: () => current,
  })
  return {
    agents,
    approvals,
    events,
    service,
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds)
    },
  }
}

async function requestApproval(
  service: ApprovalService,
  input: Record<string, unknown> = {
    slug: "forge",
    settings: { description: "Updated" },
  }
) {
  return service.request(sessionActor, {
    runId: RUN_ID,
    capabilityId: "teams.update",
    capabilityVersion: "1",
    risk: "reversible-write",
    input,
    redactedInputSummary: {
      summary: "Update the Forge team description",
    },
  })
}

describe("ApprovalService", () => {
  it("persists a server-owned request bound to the exact input", async () => {
    const { approvals, agents, service } = await fixture()
    const resolution = await requestApproval(service)

    expect(resolution.event.type).toBe("approval.requested")
    expect(resolution.event.payload.inputHash).toMatch(/^[a-f0-9]{64}$/)
    expect(approvals.approvals.get(APPROVAL_ID)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      requestedForUserId: USER_ID,
      runId: RUN_ID,
      capabilityId: "teams.update",
      capabilityVersion: "1",
      state: "pending",
    })
    await expect(agents.getRun(WORKSPACE_ID, RUN_ID)).resolves.toMatchObject({
      state: "waiting-for-approval",
    })
  })

  it("rejects a different user or workspace", async () => {
    const { service } = await fixture()
    await requestApproval(service)

    await expect(
      service.resolve(
        { ...sessionActor, userId: "other-user" },
        APPROVAL_ID,
        "approved"
      )
    ).rejects.toMatchObject({ code: "APPROVAL_BINDING_MISMATCH" })
    await expect(
      service.resolve(
        { ...sessionActor, workspaceId: "other-workspace" },
        APPROVAL_ID,
        "approved"
      )
    ).rejects.toMatchObject({ code: "APPROVAL_BINDING_MISMATCH" })
  })

  it("approves once and consumes only for the exact run, capability, and input", async () => {
    const { service } = await fixture()
    const capabilityInput = {
      slug: "forge",
      settings: { description: "Updated" },
    }
    await requestApproval(service, capabilityInput)
    const resolution = await service.resolve(
      sessionActor,
      APPROVAL_ID,
      "approved"
    )
    expect(resolution.event.payload.decision).toBe("approved")

    const agentActor: Actor = {
      ...sessionActor,
      authentication: {
        kind: "agent",
        runId: RUN_ID,
        tokenId: "70000000-0000-4000-8000-000000000001",
      },
      scopes: ["teams:write"],
    }
    await expect(
      service.findApprovedForInvocation(agentActor, {
        runId: RUN_ID,
        capabilityId: "teams.update",
        capabilityVersion: "1",
        capabilityInput,
      })
    ).resolves.toMatchObject({ id: APPROVAL_ID, state: "approved" })
    await expect(
      service.consume(agentActor, {
        approvalId: APPROVAL_ID,
        runId: RUN_ID,
        capabilityId: "teams.update",
        capabilityVersion: "1",
        capabilityInput: { ...capabilityInput, slug: "other" },
      })
    ).rejects.toMatchObject({ code: "APPROVAL_BINDING_MISMATCH" })
    await expect(
      service.consume(agentActor, {
        approvalId: APPROVAL_ID,
        runId: RUN_ID,
        capabilityId: "teams.update",
        capabilityVersion: "1",
        capabilityInput,
      })
    ).resolves.toMatchObject({ state: "consumed" })
    await expect(
      service.consume(agentActor, {
        approvalId: APPROVAL_ID,
        runId: RUN_ID,
        capabilityId: "teams.update",
        capabilityVersion: "1",
        capabilityInput,
      })
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_APPROVED" })
  })

  it("cannot consume denied or expired approvals", async () => {
    const denied = await fixture()
    await requestApproval(denied.service)
    await denied.service.resolve(sessionActor, APPROVAL_ID, "denied")
    await expect(
      denied.service.consume(sessionActor, {
        approvalId: APPROVAL_ID,
        runId: RUN_ID,
        capabilityId: "teams.update",
        capabilityVersion: "1",
        capabilityInput: {
          slug: "forge",
          settings: { description: "Updated" },
        },
      })
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_APPROVED" })

    const expired = await fixture()
    await requestApproval(expired.service)
    expired.advance(6 * 60_000)
    await expect(
      expired.service.resolve(sessionActor, APPROVAL_ID, "approved")
    ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" })
  })

  it("rejects a resolution replay", async () => {
    const { service } = await fixture()
    await requestApproval(service)
    await service.resolve(sessionActor, APPROVAL_ID, "approved")
    await expect(
      service.resolve(sessionActor, APPROVAL_ID, "approved")
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_PENDING" })
  })

  it("authorizes only capabilities declared by an approved program manifest", async () => {
    const { service } = await fixture()
    await service.request(sessionActor, {
      runId: RUN_ID,
      capabilityId: "program.execute",
      capabilityVersion: "1",
      risk: "reversible-write",
      input: {
        code: "return forge.call('teams.update', input)",
        capabilityManifest: [
          { id: "teams.update", version: "1", maximumCalls: 1 },
        ],
      },
      redactedInputSummary: {
        summary: "Run a program that can update one team",
        details: {
          programManifest: [
            { id: "teams.update", version: "1", maximumCalls: 1 },
          ],
        },
      },
    })
    await service.resolve(sessionActor, APPROVAL_ID, "approved")
    const agentActor: Actor = {
      ...sessionActor,
      authentication: {
        kind: "agent",
        runId: RUN_ID,
        tokenId: "70000000-0000-4000-8000-000000000001",
      },
      scopes: ["teams:write"],
    }

    const grant = await service.findApprovedForInvocation(agentActor, {
      runId: RUN_ID,
      capabilityId: "teams.update",
      capabilityVersion: "1",
      capabilityInput: {
        slug: "forge",
        settings: { description: "Updated" },
      },
    })
    expect(grant).toMatchObject({
      id: APPROVAL_ID,
      capabilityId: "program.execute",
    })
    await expect(
      service.consume(agentActor, {
        approvalId: APPROVAL_ID,
        runId: RUN_ID,
        capabilityId: "teams.update",
        capabilityVersion: "1",
        capabilityInput: {
          slug: "forge",
          settings: { description: "Updated" },
        },
      })
    ).resolves.toMatchObject({ state: "approved" })
    await expect(
      service.findApprovedForInvocation(agentActor, {
        runId: RUN_ID,
        capabilityId: "teams.delete",
        capabilityVersion: "1",
        capabilityInput: {},
      })
    ).resolves.toBeNull()
  })
})

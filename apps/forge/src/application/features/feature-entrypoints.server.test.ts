// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { Actor } from "@/application/actor"

import { saveProductState } from "@/application/product-state/product-state.server"
import { getWorkspaceBillingForRequest } from "@/lib/billing-server"
import { authorizeForgeCapability } from "@/adapters/agents/capability-authorization.server"
import {
  CapabilityGateway,
  CapabilityRegistry,
  defineCapability,
} from "@/application/agents/capability-gateway.server"

const mocks = vi.hoisted(() => ({
  currentActor: vi.fn(),
  command: vi.fn(),
  sessionActor: vi.fn(),
  subscription: vi.fn(),
  query: vi.fn(),
}))
vi.mock("@/application/commands/execute-command.server", () => ({
  executeCommand: mocks.command,
}))
vi.mock("@/application/resource-policy.server", () => ({
  requireCurrentActor: mocks.currentActor,
  requireResourceScope: vi.fn(),
  readableIssueCondition: vi.fn(),
  readableProjectCondition: vi.fn(),
  readableTeamCondition: vi.fn(),
}))
vi.mock("@/adapters/auth/session-actor.server", () => ({
  requireSessionActor: mocks.sessionActor,
}))
vi.mock("@/application/billing/subscription-access-state.server", () => ({
  readSubscriptionAccessState: mocks.subscription,
}))
vi.mock("@/db", () => ({
  db: { select: mocks.query },
  members: { organizationId: {} },
  productState: {},
  organizations: {},
  issues: {},
  projects: {},
  teams: {},
  teamMembers: {},
}))
vi.mock("@/application/documents/document-copies.server", () => ({
  pruneTeamDocumentCopies: vi.fn(),
}))
vi.mock("@/application/planning/project-catalog.server", () => ({
  isProjectCatalog: vi.fn(),
  validateProjectCatalogChange: vi.fn(),
}))
vi.mock("@/application/cycles/cycles.server", () => ({
  ensureTeamCycles: vi.fn(),
  lockTeamCycles: vi.fn(),
}))
vi.mock("@/application/planning/initiatives.server", () => ({
  initiativeSnapshot: vi.fn(),
}))
vi.mock("@/application/teams/teams.server", () => ({ getTeam: vi.fn() }))
vi.mock("@/application/commands/command-actor.server", () => ({
  currentCommandActor: vi.fn(),
}))

const actor = (workspaceId = "w2"): Actor => ({
  userId: "u1",
  workspaceId,
  workspaceRole: "owner",
  authentication: { kind: "session", sessionId: "s1" },
  scopes: null,
})
beforeEach(() => {
  vi.stubEnv("FORGE_BILLING_ENABLED", "true")
  vi.stubEnv(
    "FORGE_FEATURE_ROLLOUTS",
    JSON.stringify({
      signals: { mode: "preview", workspaceIds: ["w1"] },
      billing: { mode: "enabled", workspaceIds: ["w1"] },
    })
  )
  mocks.currentActor.mockImplementation((candidate) =>
    Promise.resolve(candidate)
  )
  mocks.sessionActor.mockResolvedValue(actor())
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("FOR-103 direct server entry points", () => {
  it.each(["w1", "w2"])(
    "denies real generic state writes even with a preview grant in %s",
    async (workspaceId) => {
      for (const key of [
        "forge:signals:v1:u1:w1",
        "forge:signal-documents:v1:[]",
        "forge:reviews-preview:v1:[]",
        "forge:workspace:w2:sla-settings",
      ])
        await expect(
          saveProductState(actor(workspaceId), {
            workspaceId,
            sessionId: "s1",
            commandKey: "00000000-0000-4000-8000-000000000001",
            key,
            value: JSON.stringify({ enabled: true, workspaceId: "w1" }),
            expectedRevision: 0,
          })
        ).rejects.toThrow(/unavailable/)
      expect(mocks.command).not.toHaveBeenCalled()
      expect(mocks.query).not.toHaveBeenCalled()
    }
  )
  it("rejects a forged enabled/workspace flag before billing data access", async () => {
    await expect(
      getWorkspaceBillingForRequest(
        new Request("https://forge.test/?workspaceId=w1&enabled=true", {
          headers: { "x-workspace-id": "w1", "x-feature-billing": "true" },
        })
      )
    ).rejects.toThrow(/unavailable/)
    expect(mocks.subscription).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })
  it("permits the selected workspace's real billing summary", async () => {
    mocks.sessionActor.mockResolvedValue(actor("w1"))
    mocks.subscription.mockResolvedValue(undefined)
    mocks.query.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ members: 2 }]) }),
    })
    const result = await getWorkspaceBillingForRequest(
      new Request("https://forge.test/")
    )
    expect(result.plan).toBe("free")
    expect(result.activeMembers).toBe(2)
    expect(mocks.subscription).toHaveBeenCalledWith("w1")
  })
  it("denies a registered preview write tool before approvals, replay or execution", async () => {
    const execute = vi.fn(),
      consume = vi.fn(),
      transactionalWrite = vi.fn()
    const gateway = new CapabilityGateway(
      new CapabilityRegistry([
        defineCapability({
          descriptor: {
            id: "signals.createIssue",
            version: "1",
            summary: "Fixture",
            risk: "important-write",
            inputSchema: {},
            outputSchema: {},
            maxResultBytes: 1000,
          },
          inputSchema: z.record(z.string(), z.unknown()),
          outputSchema: z.unknown(),
          execute,
        }),
      ]),
      {
        authorize: authorizeForgeCapability,
        approvals: { consume },
        transactionalWrite,
      }
    )
    for (const workspaceId of ["w1", "w2"]) {
      const result = await gateway.invoke(
        actor(workspaceId),
        {
          capabilityId: "signals.createIssue",
          capabilityVersion: "1",
          idempotencyKey: "retry",
          approvalId: "00000000-0000-4000-8000-000000000001",
          input: { workspaceId: "w1", enabled: true },
        },
        { runId: "r1" }
      )
      expect(result).toMatchObject({ ok: false, errorCode: "FORBIDDEN" })
    }
    expect(consume).not.toHaveBeenCalled()
    expect(transactionalWrite).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
})

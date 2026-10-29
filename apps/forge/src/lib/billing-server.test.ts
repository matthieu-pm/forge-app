// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getWorkspaceBillingForRequest } from "./billing-server"

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  state: vi.fn(),
  counts: vi.fn(),
}))
vi.mock("@/adapters/auth/session-actor.server", () => ({
  requireSessionActor: mocks.actor,
}))
vi.mock("@/application/billing/subscription-access-state.server", () => ({
  readSubscriptionAccessState: mocks.state,
}))
vi.mock("@/db", () => ({
  members: { organizationId: "workspace-column" },
  db: { select: () => ({ from: () => ({ where: mocks.counts }) }) },
}))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.actor.mockResolvedValue({ workspaceId: "trusted-workspace" })
  mocks.state.mockResolvedValue(null)
  mocks.counts.mockResolvedValue([{ members: 7 }])
})
describe("billing server snapshot", () => {
  it("uses the active session workspace and actual membership count, ignoring URL overrides", async () => {
    const result = await getWorkspaceBillingForRequest(
      new Request(
        "http://localhost/settings/billing?workspaceId=other&plan=plus"
      )
    )
    expect(mocks.state).toHaveBeenCalledWith("trusted-workspace")
    expect(result).toEqual({
      plan: "free",
      phase: "free",
      activeMembers: 7,
      trialExpiresAt: null,
    })
  })
  it("does not read billing data when session authorization fails", async () => {
    mocks.actor.mockRejectedValue(new Error("UNAUTHORIZED"))
    await expect(
      getWorkspaceBillingForRequest(
        new Request("http://localhost/settings/billing")
      )
    ).rejects.toThrow("UNAUTHORIZED")
    expect(mocks.state).not.toHaveBeenCalled()
    expect(mocks.counts).not.toHaveBeenCalled()
  })
  it("shows a valid trial then falls back to Free at the exact server boundary", async () => {
    const start = new Date(Date.now() - 86400000),
      end = new Date(start.getTime() + 14 * 86400000)
    mocks.state.mockResolvedValue({
      plan: "basic",
      status: "trialing",
      source: "forge-trial",
      trialRedemptionId: "trial",
      sourceReference: "trial",
      currentPeriodStart: start,
      currentPeriodEnd: end,
    })
    expect(
      await getWorkspaceBillingForRequest(
        new Request("http://localhost/settings/billing")
      )
    ).toMatchObject({
      plan: "basic",
      phase: "trial",
      trialExpiresAt: end.toISOString(),
    })
    // subscriptionAccess takes a fresh Date; fake the trusted server clock.
    vi.useFakeTimers()
    vi.setSystemTime(end)
    try {
      expect(
        await getWorkspaceBillingForRequest(
          new Request("http://localhost/settings/billing")
        )
      ).toMatchObject({ plan: "free", phase: "free", trialExpiresAt: null })
    } finally {
      vi.useRealTimers()
    }
  })
})

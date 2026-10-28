import { beforeEach, describe, expect, it, vi } from "vitest"
import { getTeamThreadSummariesAccess } from "./team-thread-summaries-server"

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  team: vi.fn(),
  entitlement: vi.fn(),
  membership: vi.fn(),
}))
vi.mock("@tanstack/react-start/server-only", () => ({}))
vi.mock("@/adapters/auth/session-actor.server", () => ({
  requireSessionActor: mocks.actor,
}))
vi.mock("@/application/teams/teams.server", () => ({ getTeam: mocks.team }))
vi.mock("@/application/billing/subscription-access-state.server", () => ({
  readSubscriptionAccessState: mocks.entitlement,
}))
vi.mock("@/db", () => ({
  db: {
    query: {
      workspaceEntitlements: { findFirst: mocks.entitlement },
      teamMembers: { findFirst: mocks.membership },
    },
  },
  teamMembers: { workspaceId: "workspace", teamId: "team", userId: "user" },
  workspaceEntitlements: { workspaceId: "workspace" },
}))
const request = new Request(
  "http://localhost/settings/teams/forge/ai/summaries"
)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.actor.mockResolvedValue({
    userId: "user",
    workspaceId: "workspace",
    workspaceRole: "member",
  })
  mocks.team.mockResolvedValue({ id: "team" })
  mocks.entitlement.mockResolvedValue({ plan: "business", status: "active" })
  mocks.membership.mockResolvedValue({ id: "membership" })
})
describe("thread summary access", () => {
  it.each([
    ["business", "active", true],
    ["business", "trialing", true],
    ["enterprise", "active", true],
    ["basic", "active", false],
    ["free", "active", false],
    ["business", "inactive", false],
  ])("resolves %s / %s plan eligibility", async (plan, status, available) => {
    mocks.entitlement.mockResolvedValue({ plan, status })
    expect(await getTeamThreadSummariesAccess(request, "forge")).toEqual({
      available,
      canManage: true,
    })
  })
  it("denies a refunded period despite an active provider subscription", async () => {
    const start = new Date(Date.now() - 86400000),
      end = new Date(Date.now() + 86400000)
    const paid = {
      plan: "business",
      status: "active",
      source: "polar",
      sourceReference: "sub",
      providerEnvironment: "sandbox",
      paidActivatedAt: start,
      currentPeriodStart: start,
      currentPeriodEnd: end,
    }
    mocks.entitlement.mockResolvedValue(paid)
    expect(
      (await getTeamThreadSummariesAccess(request, "forge")).available
    ).toBe(true)
    mocks.entitlement.mockResolvedValue({
      ...paid,
      refundedPeriods: [
        {
          orderId: "order",
          subscriptionId: "sub",
          environment: "sandbox",
          start: start.toISOString(),
          end: end.toISOString(),
          refundedAt: new Date().toISOString(),
        },
      ],
    })
    expect(
      (await getTeamThreadSummariesAccess(request, "forge")).available
    ).toBe(false)
  })
  it("retains access during valid payment grace and scheduled cancellation", async () => {
    const start = new Date(Date.now() - 86400000),
      end = new Date(Date.now() + 86400000)
    const paid = {
      plan: "business",
      source: "polar",
      paidActivatedAt: start,
      currentPeriodStart: start,
      currentPeriodEnd: end,
    }
    mocks.entitlement.mockResolvedValue({
      ...paid,
      status: "canceled",
      cancelAtPeriodEnd: true,
      cancellationPeriodEnd: end,
    })
    expect(
      (await getTeamThreadSummariesAccess(request, "forge")).available
    ).toBe(true)
    const failed = new Date(Date.now() - 3600000)
    mocks.entitlement.mockResolvedValue({
      ...paid,
      status: "past_due",
      paymentFailedAt: failed,
      graceExpiresAt: new Date(failed.getTime() + 7 * 86400000),
    })
    expect(
      (await getTeamThreadSummariesAccess(request, "forge")).available
    ).toBe(true)
  })
  it("allows administrators but makes non-team members read-only", async () => {
    mocks.membership.mockResolvedValue(undefined)
    expect(
      (await getTeamThreadSummariesAccess(request, "forge")).canManage
    ).toBe(false)
    mocks.actor.mockResolvedValue({
      userId: "user",
      workspaceId: "workspace",
      workspaceRole: "admin",
    })
    expect(
      (await getTeamThreadSummariesAccess(request, "forge")).canManage
    ).toBe(true)
  })
  it("rejects inaccessible teams before fetching their plan or membership", async () => {
    mocks.team.mockResolvedValue(null)
    await expect(
      getTeamThreadSummariesAccess(request, "private")
    ).rejects.toThrow("Team not found")
    expect(mocks.entitlement).not.toHaveBeenCalled()
    expect(mocks.membership).not.toHaveBeenCalled()
  })
  it("defaults to unavailable when there is no entitlement", async () => {
    mocks.entitlement.mockResolvedValue(undefined)
    expect(
      (await getTeamThreadSummariesAccess(request, "forge")).available
    ).toBe(false)
  })
})

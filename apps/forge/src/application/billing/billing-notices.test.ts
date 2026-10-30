import { describe, expect, it } from "vitest"
import { workspaceBillingNotices } from "./billing-notices"
import { PAYMENT_GRACE_MS } from "./subscription-access"
import type { SubscriptionAccessState } from "./subscription-access"

const start = new Date("2026-10-01T00:00:00Z")
const end = new Date("2026-11-01T00:00:00Z")
const paid: SubscriptionAccessState = {
  plan: "plus",
  status: "active",
  source: "polar",
  paidActivatedAt: start,
  currentPeriodStart: start,
  currentPeriodEnd: end,
}

describe("commercial access communications", () => {
  it("shows the frozen cancellation boundary, then only Free rules at that exact instant", () => {
    const state = {
      ...paid,
      cancelAtPeriodEnd: true,
      cancellationPeriodEnd: end,
    }
    expect(
      workspaceBillingNotices(state, 8, new Date(end.getTime() - 1))
    ).toMatchObject([
      {
        code: "cancellation",
        effectiveAt: end.toISOString(),
        message: expect.stringContaining(
          "existing members and files remain accessible"
        ),
      },
    ])
    expect(workspaceBillingNotices(state, 8, end)).toMatchObject([
      {
        code: "free-capacity",
        effectiveAt: null,
        message: expect.stringContaining("fewer than 5"),
      },
    ])
  })
  it("does not promise grace to an unpaid first checkout or restart an expired episode", () => {
    const failed = new Date("2026-11-01T00:00:00Z")
    const expires = new Date(failed.getTime() + PAYMENT_GRACE_MS)
    const state = {
      ...paid,
      status: "past_due",
      paymentFailedAt: failed,
      graceExpiresAt: expires,
    }
    expect(workspaceBillingNotices(state, 3, failed)).toMatchObject([
      { code: "payment-grace", effectiveAt: expires.toISOString() },
    ])
    expect(
      workspaceBillingNotices(state, 3, expires).map((n) => n.code)
    ).toEqual(["free-capacity"])
    expect(
      workspaceBillingNotices(
        { ...state, paidActivatedAt: null },
        3,
        failed
      ).map((n) => n.code)
    ).toEqual(["free-capacity"])
  })
  it("explains manual trial conversion and removes the trial message at expiry", () => {
    const trialEnd = new Date(start.getTime() + 14 * 86400000)
    const state: SubscriptionAccessState = {
      plan: "starter",
      status: "trialing",
      source: "forge-trial",
      trialRedemptionId: "redemption",
      sourceReference: "redemption",
      currentPeriodStart: start,
      currentPeriodEnd: trialEnd,
    }
    expect(workspaceBillingNotices(state, 12, start)).toMatchObject([
      {
        code: "trial",
        effectiveAt: trialEnd.toISOString(),
        message: expect.stringContaining("not be charged automatically"),
      },
    ])
    expect(
      workspaceBillingNotices(state, 12, trialEnd).map((n) => n.code)
    ).toEqual(["free-capacity"])
  })
  it("never displays paid promises after terminal state, full refund or a pause cutoff", () => {
    const state = {
      ...paid,
      cancelAtPeriodEnd: true,
      cancellationPeriodEnd: end,
    }
    for (const patch of [
      { terminatedAt: start },
      { unsupportedPauseAt: start },
      {
        sourceReference: "sub",
        providerEnvironment: "sandbox",
        refundedPeriods: [
          {
            orderId: "base",
            subscriptionId: "sub",
            environment: "sandbox",
            start: start.toISOString(),
            end: end.toISOString(),
            refundedAt: start.toISOString(),
          },
        ],
      },
    ])
      expect(
        workspaceBillingNotices({ ...state, ...patch }, 3, start).map(
          (n) => n.code
        )
      ).toEqual(["free-capacity"])
  })
  it("retains the scheduled pause warning only before its restrictive boundary", () => {
    const state = { ...paid, unsupportedPauseAt: end }
    expect(workspaceBillingNotices(state, 3, start)).toMatchObject([
      { code: "provider-pause", effectiveAt: end.toISOString() },
    ])
    expect(workspaceBillingNotices(state, 3, end).map((n) => n.code)).toEqual([
      "free-capacity",
    ])
  })
  it("uses grandfathering copy at the admission limit as well as above it", () => {
    for (const members of [5, 12])
      expect(
        workspaceBillingNotices(null, members, start)[0]?.message
      ).toContain("Existing members and files remain accessible")
    expect(workspaceBillingNotices(null, 4, start)[0]?.message).toContain(
      "new uploads up to 10 MB"
    )
    expect(workspaceBillingNotices(paid, 3, start)).toEqual([])
  })
})

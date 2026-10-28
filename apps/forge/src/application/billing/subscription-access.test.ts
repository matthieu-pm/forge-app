import { describe, expect, it } from "vitest"
import { PAYMENT_GRACE_MS, subscriptionAccess } from "./subscription-access"
import type { SubscriptionAccessState } from "./subscription-access"

const failed = new Date("2026-10-25T01:00:00Z")
const state: SubscriptionAccessState = {
  plan: "plus",
  status: "past_due",
  source: "polar",
  paidActivatedAt: new Date("2026-09-25T01:00:00Z"),
  paymentFailedAt: failed,
  graceExpiresAt: new Date(failed.getTime() + PAYMENT_GRACE_MS),
}

describe("paid-access grace", () => {
  it("retains paid features and existing overage authority for exactly 168 hours", () => {
    expect(subscriptionAccess(state, failed)).toMatchObject({
      plan: "business",
      phase: "grace",
      allowsExistingOverage: true,
    })
    expect(
      subscriptionAccess(state, new Date(state.graceExpiresAt!.getTime() - 1))
        .plan
    ).toBe("business")
    expect(subscriptionAccess(state, state.graceExpiresAt!)).toMatchObject({
      plan: "free",
      allowsExistingOverage: false,
    })
    expect(subscriptionAccess(state, new Date(failed.getTime() - 1)).plan).toBe(
      "free"
    )
  })
  it.each([
    { paidActivatedAt: null },
    { source: "internal" },
    { paymentFailedAt: null },
    { graceExpiresAt: new Date(failed.getTime() + PAYMENT_GRACE_MS + 1) },
    { paidActivatedAt: failed },
    { plan: "unknown" },
    { status: "canceled" },
  ])("fails closed for incomplete or invalid failure evidence: %j", (patch) => {
    expect(subscriptionAccess({ ...state, ...patch }, failed).plan).toBe("free")
  })
  it("requires a valid provider-paid period and ignores provider trials", () => {
    const paid = {
      ...state,
      status: "active",
      paymentFailedAt: null,
      graceExpiresAt: null,
      currentPeriodStart: failed,
      currentPeriodEnd: new Date(failed.getTime() + 30 * 86400000),
    }
    expect(subscriptionAccess(paid, failed).phase).toBe("paid")
    expect(subscriptionAccess(paid, paid.currentPeriodEnd).plan).toBe("free")
    expect(
      subscriptionAccess({ ...paid, status: "trialing" }, failed).plan
    ).toBe("free")
    expect(
      subscriptionAccess({ ...paid, currentPeriodEnd: null }, failed).plan
    ).toBe("free")
  })
  it("preserves trusted internal entitlements and explicitly maps legacy plans", () => {
    expect(
      subscriptionAccess({ plan: "basic", status: "active" }, failed).plan
    ).toBe("basic")
    expect(
      subscriptionAccess({ plan: "starter", status: "active" }, failed).plan
    ).toBe("basic")
    expect(subscriptionAccess(undefined, failed).plan).toBe("free")
  })
  it("does not turn a card-free trial into paid-overage authority", () => {
    expect(
      subscriptionAccess(
        { plan: "plus", status: "trialing", source: "internal" },
        failed
      )
    ).toMatchObject({
      plan: "business",
      phase: "trial",
      allowsExistingOverage: false,
    })
  })
  it("keeps scheduled cancellation paid only until its original cutoff", () => {
    const start = new Date("2026-10-01T00:00:00Z"),
      end = new Date("2026-11-01T00:00:00Z")
    const canceled: SubscriptionAccessState = {
      plan: "plus",
      status: "canceled",
      source: "polar",
      paidActivatedAt: start,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: true,
      cancellationPeriodEnd: end,
    }
    expect(subscriptionAccess(canceled, new Date(end.getTime() - 1)).plan).toBe(
      "business"
    )
    expect(subscriptionAccess(canceled, end).plan).toBe("free")
    expect(
      subscriptionAccess({ ...canceled, cancellationPeriodEnd: null }, failed)
        .plan
    ).toBe("free")
    expect(
      subscriptionAccess({ ...canceled, paidActivatedAt: null }, failed).plan
    ).toBe("free")
  })
  it("does not extend payment grace when cancellation is scheduled", () => {
    expect(
      subscriptionAccess(
        {
          ...state,
          cancelAtPeriodEnd: true,
          cancellationPeriodEnd: new Date("2026-11-25T01:00:00Z"),
        },
        state.graceExpiresAt!
      ).plan
    ).toBe("free")
    expect(
      subscriptionAccess(
        { ...state, cancelAtPeriodEnd: true, cancellationPeriodEnd: failed },
        failed
      ).plan
    ).toBe("free")
  })
})

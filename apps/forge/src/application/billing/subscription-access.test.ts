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
  it.each(["active", "past_due", "canceled"])(
    "denies terminal %s state before other paid or grace rules",
    (status) => {
      expect(
        subscriptionAccess(
          {
            ...state,
            status,
            terminatedAt: failed,
            cancelAtPeriodEnd: true,
            cancellationPeriodEnd: new Date(failed.getTime() + 30 * 86400000),
          },
          failed
        )
      ).toMatchObject({
        plan: "free",
        phase: "free",
        allowsExistingOverage: false,
      })
    }
  )
  it("restores only a verified already-paid Starter term after a full upgrade refund", () => {
    const start = new Date("2026-10-01T00:00:00Z"),
      end = new Date("2026-11-01T00:00:00Z"),
      at = new Date("2026-10-28T00:00:00Z")
    const refunded: SubscriptionAccessState = {
      plan: "business",
      status: "active",
      source: "polar",
      sourceReference: "sub",
      providerEnvironment: "sandbox",
      paidUpgradeOrderId: "upgrade",
      paidActivatedAt: start,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      refundedPeriods: [
        {
          kind: "upgrade",
          orderId: "upgrade",
          subscriptionId: "sub",
          environment: "sandbox",
          start: "2026-10-15T00:00:00Z",
          end: end.toISOString(),
          refundedAt: at.toISOString(),
          starterOrderId: "base",
          basePeriodStart: start.toISOString(),
          basePeriodEnd: end.toISOString(),
        },
      ],
    }
    expect(subscriptionAccess(refunded, at).plan).toBe("basic")
    expect(
      subscriptionAccess(
        { ...refunded, status: "past_due", paidActivatedAt: null },
        at
      ).plan
    ).toBe("basic")
    expect(subscriptionAccess(refunded, end).plan).toBe("free")
    expect(
      subscriptionAccess(
        { ...refunded, paidUpgradeOrderId: "new-paid-upgrade" },
        at
      ).plan
    ).toBe("business")
    expect(subscriptionAccess({ ...refunded, terminatedAt: at }, at).plan).toBe(
      "free"
    )
    const missing = structuredClone(refunded)
    missing.refundedPeriods![0].starterOrderId = null
    expect(subscriptionAccess(missing, at).plan).toBe("free")
    const baseRefunded = {
      ...refunded,
      refundedPeriods: [
        ...refunded.refundedPeriods!,
        {
          orderId: "base",
          subscriptionId: "sub",
          environment: "sandbox",
          start: start.toISOString(),
          end: end.toISOString(),
          refundedAt: at.toISOString(),
        },
      ],
    }
    expect(subscriptionAccess(baseRefunded, at).plan).toBe("free")
  })
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

// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import fixture from "./fixtures/polar-sandbox-paid-starter.json"
import { verifiedPolarSubscriptionSnapshot } from "./polar-subscription-reconciliation.server"
import {
  consistentPaidInvoiceAmounts,
  findPaidStarterBasis,
} from "./polar-paid-upgrade.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { ProviderSubscription } from "./polar-subscription-reconciliation.server"
import type { UpgradeOrder } from "./polar-paid-upgrade.server"

vi.mock("./subscription-reconciliation.server", () => ({
  applyVerifiedSubscriptionSnapshot: vi.fn(),
}))
const config: EnabledBillingConfig = {
  enabled: true,
  environment: "sandbox",
  accessToken: "fixture-only",
  webhookSecret: "fixture-only",
  appUrl: "https://forge.test",
  paidProducts: {
    starter: {
      eur: fixture.subscription.product_id,
      usd: fixture.subscription.product_id,
    },
    plus: {
      eur: "00000000-0000-4000-8000-000000000001",
      usd: "00000000-0000-4000-8000-000000000001",
    },
  },
}
describe("sanitized actual Polar 2026-10 paid contract", () => {
  it("accepts the initial subscription's null modification time and shared EUR/USD product", () => {
    expect(
      verifiedPolarSubscriptionSnapshot(
        config,
        fixture.provenance.workspaceId,
        fixture.subscription.id,
        fixture.subscription as ProviderSubscription
      )
    ).toMatchObject({
      plan: "starter",
      status: "active",
      updatedAt: new Date(fixture.subscription.created_at),
      currentPeriodStart: new Date(fixture.subscription.current_period_start),
    })
  })
  it("verifies a paid invoice without mistaking original due_amount for an unpaid balance", () => {
    expect(fixture.order.paid).toBe(true)
    expect(fixture.order.due_amount).toBe(3600)
    expect(consistentPaidInvoiceAmounts(fixture.order)).toBe(true)
    expect(
      consistentPaidInvoiceAmounts({ ...fixture.order, due_amount: 0 })
    ).toBe(false)
  })
  it("can recover the actual paid Starter term as the basis for a later refunded upgrade", async () => {
    const proof = await findPaidStarterBasis(
      {
        list: () =>
          Promise.resolve({
            items: [fixture.order as UpgradeOrder],
            pagination: { max_page: 1 },
          }),
      },
      {
        workspaceId: fixture.provenance.workspaceId,
        subscriptionId: fixture.subscription.id,
        productId: fixture.subscription.product_id,
        currency: "eur",
        periodEnd: new Date(fixture.subscription.current_period_end),
        upgradeStart: new Date("2026-10-30T00:00:00Z"),
      }
    )
    expect(proof).toEqual({
      orderId: fixture.order.id,
      start: new Date(fixture.subscription.current_period_start).toISOString(),
      end: new Date(fixture.subscription.current_period_end).toISOString(),
    })
  })
})

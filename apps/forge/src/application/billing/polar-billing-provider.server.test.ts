// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { PolarBillingProvider } from "./polar-billing-provider.server"
import type { Actor } from "@/application/actor"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { PaidCatalogProduct } from "./polar-paid-catalog"

const config: EnabledBillingConfig = {
  enabled: true,
  environment: "sandbox",
  accessToken: "fixture-token",
  webhookSecret: "fixture-secret",
  paidProducts: {
    starter: {
      usd: "00000000-0000-4000-8000-000000000001",
      eur: "00000000-0000-4000-8000-000000000002",
    },
    plus: {
      usd: "00000000-0000-4000-8000-000000000003",
      eur: "00000000-0000-4000-8000-000000000004",
    },
  },
  appUrl: "https://forge.test",
}
const actor: Actor = {
  userId: "alice",
  workspaceId: "workspace-a",
  workspaceRole: "owner",
  authentication: { kind: "session", sessionId: "s" },
  scopes: null,
}
function fixture() {
  const product = vi.fn((id: string): Promise<PaidCatalogProduct> => {
    const plus = Object.values(config.paidProducts.plus).includes(id)
    const eur =
      id === config.paidProducts.starter.eur ||
      id === config.paidProducts.plus.eur
    return Promise.resolve({
      id,
      is_archived: false,
      is_recurring: true,
      recurring_interval: "month",
      recurring_interval_count: 1,
      prices: [
        {
          id: "00000000-0000-4000-8000-000000000005",
          created_at: "2026-10-01T00:00:00Z",
          modified_at: null,
          product_id: id,
          is_archived: false,
          source: "catalog",
          amount_type: "seat_based",
          price_currency: eur ? "eur" : "usd",
          tax_behavior: "exclusive",
          seat_tiers: {
            minimum_seats: 1,
            maximum_seats: null,
            seat_tier_type: "volume",
            tiers: [
              {
                min_seats: 1,
                max_seats: null,
                price_per_seat: plus ? 1600 : 1000,
              },
            ],
          },
        },
      ],
    })
  })
  const checkout = vi.fn().mockResolvedValue({
    id: "checkout",
    url: "https://polar.sh/checkout/fixture",
  })
  const context = vi.fn().mockImplementation((currentActor: Actor) =>
    Promise.resolve({
      workspaceId: currentActor.workspaceId,
      billableMembers: 3,
      billingCountry: "FR",
    })
  )
  const portal = vi.fn().mockResolvedValue({
    customer_portal_url: "https://polar.sh/portal/fixture",
  })
  return {
    product,
    checkout,
    portal,
    context,
    provider: new PolarBillingProvider(config, context, {
      products: { get: product },
      checkouts: { create: checkout },
      customerSessions: { create: portal },
    }),
  }
}

describe("Polar workspace billing adapter", () => {
  it.each(["FR", "US"])(
    "selects the exact native currency from a shared multi-currency product for %s",
    async (billingCountry) => {
      const f = fixture(),
        catalog = await f.product(config.paidProducts.starter.eur),
        usd = structuredClone(catalog.prices[0])
      usd.id = "00000000-0000-4000-8000-000000000006"
      usd.price_currency = "usd"
      catalog.prices.push(usd)
      f.product.mockImplementation((id) =>
        Promise.resolve({
          ...catalog,
          id,
          prices: catalog.prices.map((p) => ({ ...p, product_id: id })),
        })
      )
      f.context.mockResolvedValue({
        workspaceId: actor.workspaceId,
        billableMembers: 3,
        billingCountry,
      })
      await f.provider.createCheckout(actor, "starter")
      expect(f.checkout.mock.calls[0][0].currency).toBe(
        billingCountry === "FR" ? "eur" : "usd"
      )
      expect(f.checkout.mock.calls[0][0]).not.toHaveProperty("prices")
    }
  )
  it.each(["inclusive", "location", null] as const)(
    "refuses %s catalog tax behavior before creating a checkout",
    async (tax_behavior) => {
      const f = fixture(),
        catalog = await f.product(config.paidProducts.starter.eur)
      catalog.prices[0].tax_behavior = tax_behavior
      f.product.mockResolvedValue(catalog)
      await expect(f.provider.createCheckout(actor, "starter")).rejects.toThrow(
        "CATALOG_PRICE_MISMATCH"
      )
      expect(f.checkout).not.toHaveBeenCalled()
    }
  )
  it.each([
    "wrong-price",
    "wrong-currency",
    "ambiguous-price",
    "archived-product",
    "annual",
    "capped-seats",
  ])("refuses unapproved catalog configuration: %s", async (mode) => {
    const f = fixture(),
      catalog = await f.product(config.paidProducts.starter.eur),
      price = catalog.prices[0]
    if (price.amount_type !== "seat_based") throw new Error("fixture")
    if (mode === "wrong-price") price.seat_tiers.tiers[0].price_per_seat = 900
    if (mode === "wrong-currency") price.price_currency = "usd"
    if (mode === "ambiguous-price") catalog.prices.push(structuredClone(price))
    if (mode === "archived-product") catalog.is_archived = true
    if (mode === "annual") catalog.recurring_interval = "year"
    if (mode === "capped-seats") price.seat_tiers.maximum_seats = 10
    f.product.mockResolvedValue(catalog)
    await expect(f.provider.createCheckout(actor, "starter")).rejects.toThrow(
      "CATALOG"
    )
    expect(f.checkout).not.toHaveBeenCalled()
  })
  it("refuses changed country/member context or revoked authority after catalog reads", async () => {
    for (const changed of [
      { workspaceId: "other", billableMembers: 3, billingCountry: "FR" },
      {
        workspaceId: actor.workspaceId,
        billableMembers: 4,
        billingCountry: "FR",
      },
      {
        workspaceId: actor.workspaceId,
        billableMembers: 3,
        billingCountry: "US",
      },
    ]) {
      const f = fixture()
      f.context
        .mockResolvedValueOnce({
          workspaceId: actor.workspaceId,
          billableMembers: 3,
          billingCountry: "FR",
        })
        .mockResolvedValueOnce(changed)
      await expect(f.provider.createCheckout(actor, "starter")).rejects.toThrow(
        "CONTEXT_CHANGED"
      )
      expect(f.checkout).not.toHaveBeenCalled()
    }
    const f = fixture()
    f.context
      .mockResolvedValueOnce({
        workspaceId: actor.workspaceId,
        billableMembers: 3,
        billingCountry: "FR",
      })
      .mockRejectedValueOnce(new Error("BILLING_ACTOR_REVOKED"))
    await expect(f.provider.createCheckout(actor, "starter")).rejects.toThrow(
      "REVOKED"
    )
    expect(f.checkout).not.toHaveBeenCalled()
  })
  it.each(["starter", "plus"] as const)(
    "keeps hosted trials disabled during manual %s upgrade",
    async (plan) => {
      const { provider, context, checkout } = fixture()
      context.mockResolvedValue({
        workspaceId: actor.workspaceId,
        billableMembers: 3,
        billingCountry: "FR",
        trialEligible: true,
        trialDays: 365,
      })
      await provider.createCheckout(actor, plan)
      expect(checkout.mock.calls[0][0].allow_trial).toBe(false)
      expect(checkout.mock.calls[0][0]).not.toHaveProperty("trial_interval")
      expect(checkout.mock.calls[0][0]).not.toHaveProperty(
        "trial_interval_count"
      )
    }
  )
  it("uses the server product and workspace customer with server-resolved seats and no price overrides", async () => {
    const { provider, checkout } = fixture()
    expect(await provider.createCheckout(actor, "starter")).toMatchObject({
      status: "pending",
      id: "checkout",
    })
    expect(checkout).toHaveBeenCalledWith({
      products: [config.paidProducts.starter.eur],
      seats: 3,
      min_seats: 3,
      max_seats: 3,
      currency: "eur",
      customer_billing_address: { country: "FR" },
      require_billing_address: true,
      allow_discount_codes: false,
      allow_trial: false,
      external_customer_id: "forge:workspace:workspace-a",
      metadata: {
        workspace_id: "workspace-a",
        actor_user_id: "alice",
        plan: "starter",
        billing_country: "FR",
      },
      success_url: "https://forge.test/settings/billing?checkout=pending",
      return_url: "https://forge.test/settings/billing",
    })
    expect(checkout.mock.calls[0][0].seats).toBe(3)
    expect(checkout.mock.calls[0][0]).not.toHaveProperty("amount")
  })
  it("selects the configured Plus USD product and refreshed member count", async () => {
    const { provider, context, checkout } = fixture()
    context.mockResolvedValue({
      workspaceId: "workspace-a",
      billableMembers: 5,
      billingCountry: "US",
    })
    await provider.createCheckout(actor, "plus")
    expect(checkout.mock.calls[0][0]).toMatchObject({
      products: [config.paidProducts.plus.usd],
      seats: 5,
      min_seats: 5,
      max_seats: 5,
      currency: "usd",
    })
  })
  it("denies invalid quantities and cross-workspace billing snapshots", async () => {
    const { provider, context, checkout } = fixture()
    for (const members of [0, -1, 1.5, Infinity]) {
      context.mockResolvedValue({
        workspaceId: "workspace-a",
        billableMembers: members,
        billingCountry: "FR",
      })
      await expect(provider.createCheckout(actor, "starter")).rejects.toThrow()
    }
    context.mockResolvedValue({
      workspaceId: "workspace-b",
      billableMembers: 3,
      billingCountry: "FR",
    })
    await expect(provider.createCheckout(actor, "starter")).rejects.toThrow(
      "does not match"
    )
    expect(checkout).not.toHaveBeenCalled()
  })

  it("binds portal access to the current workspace, not a browser customer ID", async () => {
    const { provider, portal } = fixture()
    await provider.createPortal({ ...actor, workspaceId: "workspace-b" })
    expect(portal).toHaveBeenCalledWith({
      external_customer_id: "forge:workspace:workspace-b",
      return_url: "https://forge.test/settings/billing",
    })
  })
  it("refuses revoked portal authority before creating or disclosing a hosted session", async () => {
    const f = fixture()
    f.context.mockRejectedValueOnce(new Error("BILLING_ACTOR_REVOKED"))
    await expect(f.provider.createPortal(actor)).rejects.toThrow("REVOKED")
    expect(f.portal).not.toHaveBeenCalled()
    const g = fixture()
    g.context
      .mockResolvedValueOnce({
        workspaceId: actor.workspaceId,
        billableMembers: 3,
        billingCountry: "FR",
      })
      .mockRejectedValueOnce(new Error("BILLING_ACTOR_REVOKED"))
    await expect(g.provider.createPortal(actor)).rejects.toThrow("REVOKED")
    expect(g.portal).toHaveBeenCalledTimes(1)
    const h = fixture()
    h.context.mockResolvedValue({
      workspaceId: "other",
      billableMembers: 3,
      billingCountry: "FR",
    })
    await expect(h.provider.createPortal(actor)).rejects.toThrow(
      "CONTEXT_CHANGED"
    )
    expect(h.portal).not.toHaveBeenCalled()
  })
  it.each(["GB", "CH", "NO"])(
    "selects EUR for the confirmed %s billing country",
    async (billingCountry) => {
      const { provider, context, checkout } = fixture()
      context.mockResolvedValue({
        workspaceId: actor.workspaceId,
        billableMembers: 3,
        billingCountry,
      })
      await provider.createCheckout(actor, "plus")
      expect(checkout.mock.calls[0][0]).toMatchObject({
        products: [config.paidProducts.plus.eur],
        currency: "eur",
        customer_billing_address: { country: billingCountry },
        require_billing_address: true,
      })
    }
  )
  it("derives pricing from country even if an obsolete currency override is present", async () => {
    const { provider, context, checkout } = fixture()
    context.mockResolvedValue({
      workspaceId: actor.workspaceId,
      billableMembers: 3,
      billingCountry: "US",
      currency: "eur",
    })
    await provider.createCheckout(actor, "starter")
    expect(checkout.mock.calls[0][0]).toMatchObject({
      products: [config.paidProducts.starter.usd],
      currency: "usd",
      customer_billing_address: { country: "US" },
    })
  })
  it.each([undefined, null, "", "ZZ", "UK"])(
    "requires a valid billing country before checkout (%j)",
    async (billingCountry) => {
      const { provider, context, checkout } = fixture()
      context.mockResolvedValue({
        workspaceId: actor.workspaceId,
        billableMembers: 3,
        billingCountry,
      })
      await expect(provider.createCheckout(actor, "starter")).rejects.toThrow()
      expect(checkout).not.toHaveBeenCalled()
    }
  )
  it("denies nonadmins before calling either provider endpoint", async () => {
    const { provider, checkout, portal } = fixture()
    const member = { ...actor, workspaceRole: "member" }
    await expect(provider.createCheckout(member, "starter")).rejects.toThrow()
    await expect(provider.createPortal(member)).rejects.toThrow()
    expect(checkout).not.toHaveBeenCalled()
    expect(portal).not.toHaveBeenCalled()
  })
  it("propagates provider failure rather than reporting successful checkout", async () => {
    const { provider, checkout } = fixture()
    checkout.mockRejectedValueOnce(new Error("provider unavailable"))
    await expect(provider.createCheckout(actor, "starter")).rejects.toThrow(
      "provider unavailable"
    )
  })
  it("rejects an unsafe hosted destination", async () => {
    const { provider, checkout } = fixture()
    checkout.mockResolvedValueOnce({
      id: "checkout",
      url: "javascript:alert(1)",
    })
    await expect(provider.createCheckout(actor, "starter")).rejects.toThrow()
  })
})

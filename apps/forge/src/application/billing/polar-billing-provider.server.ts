import "@tanstack/react-start/server-only"
import { createPolar } from "@polar-sh/sdk/2026-10"
import {
  billableMemberCountSchema,
  monthlyWorkspacePrice,
  selfServePlanSchema,
} from "./billing-plan-contract"
import { workspaceBillingIdentity } from "./billing-authority"
import { workspaceBillingCurrency } from "./billing-country"
import { verifyPaidCatalog } from "./polar-paid-catalog"
import type { PaidCatalogProduct } from "./polar-paid-catalog"
import type { SelfServePlan } from "./billing-plan-contract"
import type { Polar } from "@polar-sh/sdk/2026-10"
import type { Actor } from "@/application/actor"
import type { EnabledBillingConfig } from "./billing-config.server"

// Narrow result types let tests exercise the boundary without payment credentials.
export type WorkspaceBillingContext = {
  workspaceId: string
  billableMembers: number
  billingCountry: string
}

type PolarBillingClient = {
  products: { get: (id: string) => Promise<PaidCatalogProduct> }
  checkouts: {
    create: (
      body: Parameters<Polar["checkouts"]["create"]>[0]
    ) => Promise<{ id: string; url: string }>
  }
  customerSessions: {
    create: (
      body: Parameters<Polar["customerSessions"]["create"]>[0]
    ) => Promise<{ customer_portal_url: string }>
  }
}

function hostedUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Polar returned an invalid hosted session URL.")
  }
  return url.toString()
}

/** Prepared adapter; routes stay disabled until policy and receipt handling land. */
export class PolarBillingProvider {
  private readonly client: PolarBillingClient

  constructor(
    private readonly config: EnabledBillingConfig,
    private readonly resolveBillingContext: (
      actor: Actor
    ) => Promise<WorkspaceBillingContext>,
    client?: PolarBillingClient
  ) {
    this.client =
      client ??
      createPolar({
        accessToken: config.accessToken,
        environment: config.environment,
        timeout: 15,
      })
  }

  async createCheckout(actor: Actor, plan: SelfServePlan) {
    const identity = workspaceBillingIdentity(actor)
    const selectedPlan = selfServePlanSchema.parse(plan)
    const context = await this.resolveBillingContext(actor)
    if (context.workspaceId !== identity.workspaceId)
      throw new Error("Billing context does not match the active workspace.")
    const seats = billableMemberCountSchema.parse(context.billableMembers)
    const { country, currency } = workspaceBillingCurrency(
      context.billingCountry
    )
    monthlyWorkspacePrice(selectedPlan, seats)
    const productId = this.config.paidProducts[selectedPlan][currency]
    verifyPaidCatalog(await this.client.products.get(productId), {
      productId,
      plan: selectedPlan,
      currency,
    })
    // Re-read authority, country and quantity after catalog I/O; never charge an
    // obsolete server snapshot because an administrator changed it meanwhile.
    const fresh = await this.resolveBillingContext(actor)
    if (
      fresh.workspaceId !== context.workspaceId ||
      billableMemberCountSchema.parse(fresh.billableMembers) !== seats ||
      workspaceBillingCurrency(fresh.billingCountry).country !== country
    )
      throw new Error("BILLING_CHECKOUT_CONTEXT_CHANGED")
    const checkout = await this.client.checkouts.create({
      products: [productId],
      seats,
      min_seats: seats,
      max_seats: seats,
      currency,
      customer_billing_address: { country },
      require_billing_address: true,
      allow_discount_codes: false,
      // Forge trials are card-free and app-managed. Polar is only for the
      // owner's explicit paid upgrade; never start an auto-converting trial.
      allow_trial: false,
      external_customer_id: identity.externalCustomerId,
      metadata: {
        workspace_id: identity.workspaceId,
        actor_user_id: identity.actorUserId,
        plan: selectedPlan,
        billing_country: country,
      },
      // Prices are owned by the approved Polar catalog, never by browser input.
      success_url: `${this.config.appUrl}/settings/billing?checkout=pending`,
      return_url: `${this.config.appUrl}/settings/billing`,
    })
    // The redirect is informational; only reconciled provider state grants access.
    return {
      id: checkout.id,
      url: hostedUrl(checkout.url),
      status: "pending" as const,
    }
  }

  async createPortal(actor: Actor) {
    const identity = workspaceBillingIdentity(actor)
    const session = await this.client.customerSessions.create({
      external_customer_id: identity.externalCustomerId,
      return_url: `${this.config.appUrl}/settings/billing`,
    })
    return { url: hostedUrl(session.customer_portal_url) }
  }
}

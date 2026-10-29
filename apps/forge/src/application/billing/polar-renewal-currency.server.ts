import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { createPolar } from "@polar-sh/sdk/2026-10"
import { z } from "zod"
import { workspaceBillingIdentity } from "./billing-authority"
import { workspaceBillingCurrency } from "./billing-country"
import { verifiedPolarSubscriptionSnapshot } from "./polar-subscription-reconciliation.server"
import { recordVerifiedRenewalCurrencyRequest } from "./renewal-currency-request.server"
import { applyVerifiedSubscriptionSnapshot } from "./subscription-reconciliation.server"
import type { Actor } from "@/application/actor"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { ProviderSubscription } from "./polar-subscription-reconciliation.server"
import type { WorkspacePlanChangeContext } from "./polar-plan-change.server"
import type { Polar } from "@polar-sh/sdk/2026-10"

type Subscription = Awaited<ReturnType<Polar["subscriptions"]["get"]>>
export type CurrencyChangeSubscription = ProviderSubscription &
  Pick<Subscription, "pending_update"> & {
    customer: ProviderSubscription["customer"] & {
      billing_address: { country: string } | null
    }
  }

/** A durable request, never a claim that Polar scheduled a currency PATCH. */
export class PolarRenewalCurrencyPlanner {
  constructor(
    private readonly config: EnabledBillingConfig,
    private readonly resolve: (
      actor: Actor
    ) => Promise<WorkspacePlanChangeContext>,
    private readonly get: (
      id: string
    ) => Promise<CurrencyChangeSubscription> = createPolar({
      accessToken: config.accessToken,
      environment: config.environment,
      timeout: 15,
    }).subscriptions.get,
    private readonly record: typeof recordVerifiedRenewalCurrencyRequest = recordVerifiedRenewalCurrencyRequest,
    private readonly clock: () => Date = () => new Date(),
    private readonly project: typeof applyVerifiedSubscriptionSnapshot = applyVerifiedSubscriptionSnapshot
  ) {}
  async request(actor: Actor, requestId: string) {
    const identity = workspaceBillingIdentity(actor),
      key = z.uuid().parse(requestId)
    const context = await this.resolve(actor),
      id = z.uuid().parse(context.subscriptionId)
    if (context.workspaceId !== identity.workspaceId)
      throw new Error("BILLING_ACTOR_WORKSPACE_MISMATCH")
    const current = await this.get(id)
    const snapshot = verifiedPolarSubscriptionSnapshot(
      this.config,
      identity.workspaceId,
      id,
      current
    )
    if (snapshot.terminatedAt || snapshot.unsupportedPauseAt) {
      const eventId = `forge.currency.restricted.${id}.${snapshot.updatedAt.toISOString()}`
      await this.project({
        eventId,
        bodyHash: createHash("sha256").update(eventId).digest("hex"),
        snapshot,
        actor,
      })
      throw new Error("BILLING_CURRENCY_SUBSCRIPTION_NOT_RENEWING")
    }
    if (
      snapshot.status !== "active" ||
      snapshot.cancelAtPeriodEnd ||
      current.ends_at ||
      current.ended_at ||
      snapshot.currentPeriodStart > this.clock() ||
      snapshot.currentPeriodEnd <= this.clock()
    )
      throw new Error("BILLING_CURRENCY_SUBSCRIPTION_NOT_RENEWING")
    const currency = z.enum(["eur", "usd"]).parse(current.currency)
    const { country } = workspaceBillingCurrency(
      current.customer.billing_address?.country
    )
    const pending = current.pending_update
    if (
      pending &&
      (pending.units !== null ||
        new Date(pending.applies_at).getTime() !==
          snapshot.currentPeriodEnd.getTime() ||
        (pending.product_id !== null &&
          !(
            snapshot.plan === "plus" &&
            pending.product_id === this.config.paidProducts.starter[currency]
          )) ||
        (pending.product_id === null && pending.seats === null))
    )
      throw new Error("BILLING_PENDING_CHANGE_CONFLICT")
    if (pending?.seats != null)
      z.number().int().positive().safe().parse(pending.seats)
    const renewalPlan = pending?.product_id ? "starter" : snapshot.plan
    if (
      context.projectedPlan !== snapshot.plan &&
      !(
        context.refundedUpgrade &&
        context.projectedPlan === "starter" &&
        renewalPlan === "starter"
      )
    )
      throw new Error("BILLING_CURRENCY_PLAN_UNRECONCILED")
    const fresh = await this.resolve(actor)
    if (
      fresh.workspaceId !== identity.workspaceId ||
      fresh.subscriptionId !== id ||
      fresh.projectedPlan !== context.projectedPlan ||
      fresh.refundedUpgrade !== context.refundedUpgrade
    )
      throw new Error("BILLING_CURRENCY_CONTEXT_CHANGED")
    return this.record(actor, {
      requestId: key,
      workspaceId: identity.workspaceId,
      environment: this.config.environment,
      subscriptionId: id,
      billingCountry: country,
      fromCurrency: currency,
      currentPlan: context.projectedPlan,
      renewalPlan,
      periodStart: snapshot.currentPeriodStart,
      periodEnd: snapshot.currentPeriodEnd,
      providerUpdatedAt: snapshot.updatedAt,
    })
  }
}

/** Prepared first-party entry; no browser-supplied country/subscription/price. */
export async function requestWorkspaceRenewalCurrencyChange(
  actor: Actor,
  config: EnabledBillingConfig,
  requestId: string
) {
  const { readPlanChangeContext } = await import("./plan-change-context.server")
  return new PolarRenewalCurrencyPlanner(config, (candidate) =>
    readPlanChangeContext(candidate, config.environment)
  ).request(actor, requestId)
}

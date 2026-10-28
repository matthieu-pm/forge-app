import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { createPolar } from "@polar-sh/sdk/2026-10"
import { z } from "zod"
import { workspaceBillingIdentity } from "./billing-authority"
import {
  billableMemberCountSchema,
  selfServePlanSchema,
} from "./billing-plan-contract"
import { verifiedPolarSubscriptionSnapshot } from "./polar-subscription-reconciliation.server"
import { findPaidUpgradeOrder } from "./polar-paid-upgrade.server"
import { PolarSeatRenewalScheduler } from "./polar-seat-renewal.server"
import { applyVerifiedSubscriptionSnapshot } from "./subscription-reconciliation.server"
import { workspaceUsagePeriod } from "./workspace-usage-period"
import type { ProviderSubscription } from "./polar-subscription-reconciliation.server"
import type { UpgradeOrderClient } from "./polar-paid-upgrade.server"
import type { SelfServePlan } from "./billing-plan-contract"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { VerifiedPlanChange } from "./subscription-reconciliation.server"
import type { Actor } from "@/application/actor"
import type { Polar } from "@polar-sh/sdk/2026-10"

type Subscription = Awaited<ReturnType<Polar["subscriptions"]["get"]>>
export type PlanChangeSubscription = ProviderSubscription &
  Pick<
    Subscription,
    "amount" | "seats" | "pending_update" | "pause_at_period_end" | "paused_at"
  >
export type WorkspacePlanChangeContext = {
  workspaceId: string
  subscriptionId: string
  billableMembers: number
  projectedPlan: SelfServePlan
}
type Client = {
  subscriptions: {
    get: (id: string) => Promise<PlanChangeSubscription>
    update: (
      id: string,
      input: Parameters<Polar["subscriptions"]["update"]>[1]
    ) => Promise<PlanChangeSubscription>
  }
  orders: UpgradeOrderClient
}

/** Prepared server command. Serialize/durably redrive effects before enabling a public action. */
export class PolarPlanChanger {
  constructor(
    private readonly config: EnabledBillingConfig,
    private readonly resolveContext: (
      actor: Actor
    ) => Promise<WorkspacePlanChangeContext>,
    private readonly client: Client = createPolar({
      accessToken: config.accessToken,
      environment: config.environment,
      timeout: 15,
    }),
    private readonly apply: typeof applyVerifiedSubscriptionSnapshot = applyVerifiedSubscriptionSnapshot,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async change(actor: Actor, target: SelfServePlan) {
    const identity = workspaceBillingIdentity(actor),
      selected = selfServePlanSchema.parse(target)
    let context = await this.resolveContext(actor)
    const id = z.uuid().parse(context.subscriptionId)
    const checkContext = (value: WorkspacePlanChangeContext) => {
      if (
        value.workspaceId !== identity.workspaceId ||
        value.subscriptionId !== id
      )
        throw new Error("BILLING_SUBSCRIPTION_CONFLICT")
      billableMemberCountSchema.parse(value.billableMembers)
      selfServePlanSchema.parse(value.projectedPlan)
      return value
    }
    checkContext(context)
    const refresh = async () =>
      (context = checkContext(await this.resolveContext(actor)))
    const observe = async (subId: string) => {
      if (subId !== id) throw new Error("BILLING_SUBSCRIPTION_CONFLICT")
      const observed = await this.client.subscriptions.get(subId)
      const snapshot = verifiedPolarSubscriptionSnapshot(
        this.config,
        identity.workspaceId,
        id,
        observed
      )
      if (snapshot.terminatedAt) {
        const eventId = `forge.plan.terminated.${id}.${snapshot.updatedAt.toISOString()}`
        await this.apply({
          eventId,
          bodyHash: createHash("sha256").update(eventId).digest("hex"),
          snapshot,
          actor,
        })
        throw new Error("BILLING_SUBSCRIPTION_TERMINATED")
      }
      return observed
    }
    const guardedClient = {
      subscriptions: {
        get: observe,
        update: async (
          subId: string,
          body: Parameters<Client["subscriptions"]["update"]>[1]
        ) => {
          await refresh()
          if (
            subId !== id ||
            ("seats" in body && body.seats !== context.billableMembers)
          )
            throw new Error("BILLING_CONTEXT_CHANGED")
          return this.client.subscriptions.update(subId, body)
        },
      },
    }
    const validate = (current: PlanChangeSubscription) => {
      const snapshot = verifiedPolarSubscriptionSnapshot(
        this.config,
        identity.workspaceId,
        id,
        current
      )
      const seats = billableMemberCountSchema.parse(current.seats)
      const period = workspaceUsagePeriod(identity.workspaceId, this.clock(), {
        kind: "paid-monthly",
        currentPeriodStart: snapshot.currentPeriodStart,
        currentPeriodEnd: snapshot.currentPeriodEnd,
      })
      const currency = z.enum(["eur", "usd"]).parse(current.currency),
        pending = current.pending_update
      if (
        pending &&
        (pending.units !== null ||
          new Date(pending.applies_at).getTime() !== period.end.getTime() ||
          (pending.product_id !== null &&
            !(
              snapshot.plan === "plus" &&
              pending.product_id === this.config.paidProducts.starter[currency]
            )) ||
          (pending.seats === null && pending.product_id === null))
      )
        throw new Error("BILLING_PENDING_CHANGE_CONFLICT")
      if (pending?.seats != null) billableMemberCountSchema.parse(pending.seats)
      return { snapshot, seats, period, currency }
    }
    let current = await observe(id)
    const before = validate(current),
      billedAmount = current.amount
    if (
      current.cancel_at_period_end ||
      current.pause_at_period_end ||
      current.paused_at !== null ||
      current.ends_at !== null ||
      current.ended_at !== null ||
      (current.status !== "active" &&
        !(
          current.status === "past_due" &&
          before.snapshot.plan === "plus" &&
          selected === "plus"
        ))
    )
      throw new Error("BILLING_SUBSCRIPTION_NOT_RENEWING")
    let changed = false,
      cleared = false
    if (current.status === "active") {
      if (
        before.snapshot.plan !== selected &&
        !(
          selected === "starter" &&
          current.pending_update?.product_id ===
            this.config.paidProducts.starter[before.currency]
        )
      ) {
        await guardedClient.subscriptions.update(id, {
          product_id: this.config.paidProducts[selected][before.currency],
          proration_behavior: selected === "plus" ? "invoice" : "next_period",
        })
        changed = true
        current = await observe(id)
      } else if (
        before.snapshot.plan === selected &&
        current.pending_update?.product_id
      ) {
        await guardedClient.subscriptions.update(id, { pending_update: null })
        cleared = true
        current = await observe(id)
      }
    }
    let after = validate(current)
    const expectedPlan = selected === "plus" ? "plus" : before.snapshot.plan
    const sameWindow = () =>
      after.period.key === before.period.key &&
      after.currency === before.currency &&
      after.seats === before.seats
    if (
      !sameWindow() ||
      (after.snapshot.plan === before.snapshot.plan &&
        current.amount !== billedAmount) ||
      (selected === "plus" && after.snapshot.plan !== "plus") ||
      (selected === "starter" &&
        before.snapshot.plan === "plus" &&
        (after.snapshot.plan !== "plus" ||
          current.pending_update?.product_id !==
            this.config.paidProducts.starter[before.currency] ||
          current.amount !== billedAmount))
    )
      throw new Error("BILLING_PLAN_CHANGE_RECONCILIATION_REQUIRED")
    if (current.status === "active") {
      // Immediate product changes clear pending quantity in Polar. Restore the
      // server's current active-member quantity for renewal, never for this term.
      await refresh()
      const scheduler = new PolarSeatRenewalScheduler(
        this.config,
        async () => {
          await refresh()
          return context
        },
        guardedClient,
        this.clock
      )
      await scheduler.schedule(actor)
      current = await observe(id)
      after = validate(current)
      if (
        !sameWindow() ||
        after.snapshot.plan !== expectedPlan ||
        (after.snapshot.plan === before.snapshot.plan &&
          current.amount !== billedAmount) ||
        (current.pending_update?.seats ?? after.seats) !==
          context.billableMembers ||
        (selected === "starter" &&
          before.snapshot.plan === "plus" &&
          current.pending_update?.product_id !==
            this.config.paidProducts.starter[before.currency])
      )
        throw new Error("BILLING_PLAN_CHANGE_RECONCILIATION_REQUIRED")
    }
    const snapshot = after.snapshot
    if (snapshot.plan === "plus" && snapshot.status === "active")
      snapshot.paidUpgrade = await findPaidUpgradeOrder(this.client.orders, {
        workspaceId: identity.workspaceId,
        subscriptionId: id,
        productId: current.product_id,
        currency: current.currency,
        periodStart: snapshot.currentPeriodStart,
        periodEnd: snapshot.currentPeriodEnd,
      })
    const pendingPayment =
      selected === "plus" &&
      context.projectedPlan === "starter" &&
      (!snapshot.paidUpgrade || snapshot.status !== "active")
    const status: VerifiedPlanChange["status"] = pendingPayment
      ? "payment-pending"
      : selected === "starter" && snapshot.plan === "plus"
        ? "scheduled"
        : cleared
          ? "cleared"
          : changed
            ? "applied"
            : "unchanged"
    const command: VerifiedPlanChange = {
      target: selected,
      status,
      effectiveAt:
        status === "payment-pending"
          ? null
          : status === "scheduled"
            ? after.period.end
            : snapshot.updatedAt,
      renewalSeats: context.billableMembers,
    }
    const eventId = `forge.plan.${id}.${selected}.${status}.${snapshot.updatedAt.toISOString()}.${context.billableMembers}.${snapshot.paidUpgrade?.orderId ?? "none"}`
    const bodyHash = createHash("sha256")
      .update(
        JSON.stringify({
          workspaceId: identity.workspaceId,
          subscriptionId: id,
          ...command,
          effectiveAt: command.effectiveAt?.toISOString() ?? null,
        })
      )
      .digest("hex")
    const result = await this.apply({
      eventId,
      bodyHash,
      snapshot,
      actor,
      planChange: command,
    })
    if (result.outcome === "stale")
      throw new Error("BILLING_PLAN_CHANGE_RECONCILIATION_REQUIRED")
    const held = selected === "plus" && result.effectivePlan !== "business"
    return {
      ...command,
      status: held ? ("payment-pending" as const) : command.status,
      effectiveAt: held ? null : (command.effectiveAt?.toISOString() ?? null),
      billedSeats: after.seats,
    }
  }
}

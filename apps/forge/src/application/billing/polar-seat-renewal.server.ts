import "@tanstack/react-start/server-only"
import { createPolar } from "@polar-sh/sdk/2026-10"
import { z } from "zod"
import { workspaceBillingIdentity } from "./billing-authority"
import {
  billableMemberCountSchema,
  billingCurrencySchema,
} from "./billing-plan-contract"
import { workspaceUsagePeriod } from "./workspace-usage-period"
import type { Polar } from "@polar-sh/sdk/2026-10"
import type { Actor } from "@/application/actor"
import type { EnabledBillingConfig } from "./billing-config.server"

type Subscription = Awaited<ReturnType<Polar["subscriptions"]["get"]>>
type SeatSubscription = Pick<
  Subscription,
  | "id"
  | "amount"
  | "seats"
  | "currency"
  | "product_id"
  | "status"
  | "recurring_interval"
  | "recurring_interval_count"
  | "current_period_start"
  | "current_period_end"
  | "cancel_at_period_end"
  | "pause_at_period_end"
  | "paused_at"
  | "ends_at"
  | "ended_at"
  | "pending_update"
> & { customer: Pick<Subscription["customer"], "external_id"> }

type SeatClient = {
  subscriptions: {
    get: (id: string) => Promise<SeatSubscription>
    update: (
      id: string,
      body: Parameters<Polar["subscriptions"]["update"]>[1]
    ) => Promise<SeatSubscription>
  }
}

/** Resolved from server membership and the environment-specific billing mapping. */
export type WorkspaceSeatContext = {
  workspaceId: string
  subscriptionId: string
  billableMembers: number
}

/** Adapter preparation; callers must serialize and durably reconcile per workspace. */
export class PolarSeatRenewalScheduler {
  private readonly client: SeatClient

  constructor(
    private readonly config: EnabledBillingConfig,
    private readonly resolveContext: (
      actor: Actor
    ) => Promise<WorkspaceSeatContext>,
    client?: SeatClient,
    private readonly clock: () => Date = () => new Date()
  ) {
    this.client =
      client ??
      createPolar({
        accessToken: config.accessToken,
        environment: config.environment,
        timeout: 15,
      })
  }

  async schedule(actor: Actor) {
    const identity = workspaceBillingIdentity(actor)
    const context = await this.resolveContext(actor)
    if (context.workspaceId !== identity.workspaceId)
      throw new Error("Billing context does not match the active workspace.")
    const subscriptionId = z.string().uuid().parse(context.subscriptionId)
    const seats = billableMemberCountSchema.parse(context.billableMembers)
    const before = await this.client.subscriptions.get(subscriptionId)
    const now = this.clock()

    const validate = (subscription: SeatSubscription) => {
      if (
        subscription.id !== subscriptionId ||
        subscription.customer.external_id !== identity.externalCustomerId
      )
        throw new Error("Subscription does not belong to the active workspace.")
      const currency = billingCurrencySchema.parse(subscription.currency)
      if (
        !Object.values(this.config.paidProducts).some(
          (product) => product[currency] === subscription.product_id
        ) ||
        subscription.recurring_interval !== "month" ||
        subscription.recurring_interval_count !== 1
      )
        throw new Error("Subscription is outside the approved monthly catalog.")
      // Dunning, trials and cancellation need their own approved lifecycle policy.
      if (
        subscription.status !== "active" ||
        subscription.cancel_at_period_end ||
        subscription.pause_at_period_end ||
        subscription.paused_at !== null ||
        subscription.ends_at !== null ||
        subscription.ended_at !== null
      )
        throw new Error("Subscription is not actively renewing.")
      const currentSeats = billableMemberCountSchema.parse(subscription.seats)
      const period = workspaceUsagePeriod(identity.workspaceId, now, {
        kind: "paid-monthly",
        currentPeriodStart: new Date(subscription.current_period_start),
        currentPeriodEnd: new Date(subscription.current_period_end),
      })
      const pending = subscription.pending_update
      if (
        pending &&
        (pending.product_id !== null ||
          pending.units !== null ||
          pending.seats === null ||
          new Date(pending.applies_at).getTime() !== period.end.getTime())
      )
        throw new Error(
          "Reconcile the conflicting scheduled subscription change."
        )
      const renewalSeats = pending
        ? billableMemberCountSchema.parse(pending.seats)
        : currentSeats
      return { currentSeats, renewalSeats, period }
    }

    const current = validate(before)
    const result = (status: "unchanged" | "scheduled" | "cleared") => ({
      status,
      billedSeats: current.currentSeats,
      renewalSeats: seats,
      effectiveAt: current.period.end.toISOString(),
    })
    if (current.renewalSeats === seats) return result("unchanged")

    // Explicit next_period prevents organization-default invoice/prorate behavior.
    // Reasserting current seats cancels a seat-only pending change in Polar.
    const after = await this.client.subscriptions.update(subscriptionId, {
      seats,
      proration_behavior: "next_period",
    })
    const confirmed = validate(after)
    if (
      after.product_id !== before.product_id ||
      after.currency !== before.currency ||
      after.amount !== before.amount ||
      confirmed.currentSeats !== current.currentSeats ||
      confirmed.renewalSeats !== seats ||
      (seats === current.currentSeats && after.pending_update !== null) ||
      confirmed.period.key !== current.period.key
    )
      throw new Error(
        "Seat update requires reconciliation before confirmation."
      )
    return result(seats === current.currentSeats ? "cleared" : "scheduled")
  }
}

import type { WorkspacePlan } from "@/application/workspace-security/security-contract"

export const PAYMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export type SubscriptionAccessState = {
  plan: string
  status: string
  sourceReference?: string | null
  providerEnvironment?: string | null
  refundedPeriods?: Array<{
    orderId: string
    subscriptionId: string
    environment: string
    start: string
    end: string
    refundedAt: string
    kind?: "upgrade"
    starterOrderId?: string | null
    basePeriodStart?: string
    basePeriodEnd?: string
  }>
  source?: string
  terminatedAt?: Date | null
  unsupportedPauseAt?: Date | null
  paidUpgradeOrderId?: string | null
  paidActivatedAt?: Date | null
  paymentFailedAt?: Date | null
  graceExpiresAt?: Date | null
  currentPeriodStart?: Date | null
  currentPeriodEnd?: Date | null
  cancelAtPeriodEnd?: boolean
  cancellationPeriodEnd?: Date | null
}

function validTime(value: Date | null | undefined) {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.getTime()
    : null
}

/** Explicit compatibility mapping while the security-plan storage names migrate. */
function securityPlan(value: string): WorkspacePlan {
  switch (value) {
    case "starter":
    case "basic":
      return "basic"
    case "plus":
    case "business":
      return "business"
    case "enterprise":
      return "enterprise"
    default:
      return "free"
  }
}

/** Evaluate at read time: expiry never depends on a webhook or scheduled sweep. */
export function subscriptionAccess(
  state: SubscriptionAccessState | null | undefined,
  now = new Date()
) {
  const free = {
    plan: "free" as const,
    phase: "free" as const,
    allowsExistingOverage: false,
  }
  const at = validTime(now)
  if (!state || at === null || state.terminatedAt != null) return free
  if (state.unsupportedPauseAt != null) {
    const cutoff = validTime(state.unsupportedPauseAt)
    if (cutoff === null || at >= cutoff) return free
  }
  const plan = securityPlan(state.plan)
  if (plan === "free") return free
  if (isRefundedSubscriptionPeriod(state)) return free
  const cancellationEnd = validTime(state.cancellationPeriodEnd)
  if (
    state.cancelAtPeriodEnd &&
    (cancellationEnd === null || at >= cancellationEnd)
  )
    return free
  const upgradeRefunds =
    state.source === "polar"
      ? (state.refundedPeriods?.filter(
          (period) =>
            period.kind === "upgrade" &&
            refundMatchesPeriod(state, period) &&
            (!state.paidUpgradeOrderId ||
              state.paidUpgradeOrderId === period.orderId)
        ) ?? [])
      : []
  if (upgradeRefunds.length) {
    const paidBase = upgradeRefunds.some(
      (period) =>
        period.starterOrderId &&
        period.basePeriodStart &&
        period.basePeriodEnd &&
        at >= new Date(period.basePeriodStart).getTime() &&
        at < new Date(period.basePeriodEnd).getTime()
    )
    return paidBase
      ? {
          plan: "basic" as const,
          phase: "paid" as const,
          allowsExistingOverage: true,
        }
      : free
  }
  const scheduledCancellation =
    state.source === "polar" &&
    state.status === "canceled" &&
    state.cancelAtPeriodEnd === true
  if (
    state.status === "active" ||
    state.status === "trialing" ||
    scheduledCancellation
  ) {
    if (state.source === "polar") {
      const start = validTime(state.currentPeriodStart),
        end = validTime(state.currentPeriodEnd)
      // Forge trials are app-managed; provider trialing cannot create paid access.
      if (
        (state.status !== "active" && !scheduledCancellation) ||
        start === null ||
        end === null ||
        start >= end ||
        at < start ||
        at >= end ||
        validTime(state.paidActivatedAt) === null ||
        state.paidActivatedAt!.getTime() > at
      )
        return free
    }
    if (state.status === "trialing")
      return { plan, phase: "trial" as const, allowsExistingOverage: false }
    return { plan, phase: "paid" as const, allowsExistingOverage: true }
  }
  if (state.status !== "past_due" || state.source !== "polar") return free
  const activated = validTime(state.paidActivatedAt),
    failed = validTime(state.paymentFailedAt),
    expires = validTime(state.graceExpiresAt)
  if (
    activated === null ||
    failed === null ||
    expires === null ||
    activated >= failed ||
    expires !== failed + PAYMENT_GRACE_MS ||
    at < failed ||
    at >= expires
  )
    return free
  return { plan, phase: "grace" as const, allowsExistingOverage: true }
}

/** Refund denial survives status updates; another subscription/period is separate. */
function refundMatchesPeriod(
  state: SubscriptionAccessState,
  period: NonNullable<SubscriptionAccessState["refundedPeriods"]>[number]
) {
  return (
    period.subscriptionId === state.sourceReference &&
    period.environment === state.providerEnvironment &&
    validTime(state.currentPeriodStart) !== null &&
    validTime(state.currentPeriodEnd) !== null &&
    new Date(period.start).getTime() < state.currentPeriodEnd!.getTime() &&
    new Date(period.end).getTime() > state.currentPeriodStart!.getTime()
  )
}
export function isRefundedSubscriptionPeriod(state: SubscriptionAccessState) {
  return (
    state.source === "polar" &&
    state.refundedPeriods?.some(
      (period) =>
        period.kind !== "upgrade" && refundMatchesPeriod(state, period)
    )
  )
}

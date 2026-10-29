import { standardPlanSchema } from "./billing-plan-contract"
import { subscriptionAccess } from "./subscription-access"
import { workspaceUsagePeriod } from "./workspace-usage-period"
import type { SubscriptionAccessState } from "./subscription-access"

export function paidUsageBinding(state: SubscriptionAccessState) {
  if (
    state.source !== "polar" ||
    !state.sourceReference ||
    !["sandbox", "production"].includes(state.providerEnvironment ?? "")
  )
    throw new Error("USAGE_PAID_BINDING_REQUIRED")
  return JSON.stringify([
    "polar",
    state.providerEnvironment,
    state.sourceReference,
  ])
}
function time(date: Date | null | undefined) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
    throw new Error("USAGE_PERIOD_RECONCILIATION_REQUIRED")
  return date
}
/** Evaluated under the workspace fence, never from a browser plan/date flag. */
export function resolveWorkspaceUsageAuthority(input: {
  workspaceId: string
  workspaceCreatedAt: Date
  state: SubscriptionAccessState | null
  now: Date
}) {
  const { state, now, workspaceId, workspaceCreatedAt } = input
  time(now)
  time(workspaceCreatedAt)
  if (now < workspaceCreatedAt) throw new Error("USAGE_BEFORE_WORKSPACE")
  if (
    state?.currentPeriodStart &&
    time(state.currentPeriodStart) < workspaceCreatedAt
  )
    throw new Error("USAGE_PERIOD_BEFORE_WORKSPACE")
  const access = subscriptionAccess(state, now)
  const plan =
    access.plan === "basic"
      ? "starter"
      : access.plan === "business"
        ? "plus"
        : access.plan
  if (plan === "enterprise")
    throw new Error("USAGE_ENTERPRISE_AGREEMENT_REQUIRED")
  const commercialPlan = standardPlanSchema.parse(plan)
  const phase =
    access.phase === "trial" ? ("trial" as const) : ("standard" as const)
  if (access.phase === "trial") {
    if (state?.source !== "forge-trial" || !state.trialRedemptionId)
      throw new Error("USAGE_BOUND_TRIAL_REQUIRED")
    return {
      kind: "trial" as const,
      plan: commercialPlan,
      phase,
      binding: state.trialRedemptionId,
      period: workspaceUsagePeriod(workspaceId, now, {
        kind: "trial",
        trialStartedAt: time(state.currentPeriodStart),
      }),
      transition: null,
      grace: false,
    }
  }
  if (access.phase === "paid" || access.phase === "grace") {
    if (!state) throw new Error("USAGE_PAID_BINDING_REQUIRED")
    const binding = paidUsageBinding(state),
      start = time(state.currentPeriodStart),
      end = time(state.currentPeriodEnd)
    return {
      kind: "paid" as const,
      plan: commercialPlan,
      phase,
      binding,
      period:
        access.phase === "grace"
          ? null
          : workspaceUsagePeriod(workspaceId, now, {
              kind: "paid-monthly",
              currentPeriodStart: start,
              currentPeriodEnd: end,
            }),
      transition: null,
      grace: access.phase === "grace",
    }
  }
  const period = workspaceUsagePeriod(workspaceId, now, {
    kind: "free",
    workspaceCreatedAt,
  })
  let transition: null | {
    kind: "trial-expiry" | "paid-to-free"
    binding: string
    effectiveAt: Date
    sourceStart: Date
    sourceEnd: Date
    failedAt: Date | null
  } = null
  if (state?.source === "forge-trial") {
    const end = time(state.currentPeriodEnd),
      start = time(state.currentPeriodStart)
    if (!state.trialRedemptionId || end > now)
      throw new Error("USAGE_TRIAL_RECONCILIATION_REQUIRED")
    transition = {
      kind: "trial-expiry",
      binding: state.trialRedemptionId,
      effectiveAt: end,
      sourceStart: start,
      sourceEnd: end,
      failedAt: null,
    }
  } else if (state?.source === "polar" && state.paidActivatedAt) {
    const start = time(state.currentPeriodStart),
      end = time(state.currentPeriodEnd)
    const graceEnd =
      state.status === "past_due" && state.graceExpiresAt
        ? time(state.graceExpiresAt)
        : null
    const candidates = [
      graceEnd ?? end,
      state.terminatedAt,
      state.unsupportedPauseAt,
      state.cancelAtPeriodEnd ? state.cancellationPeriodEnd : null,
    ].filter(
      (d): d is Date =>
        d instanceof Date && Number.isFinite(d.getTime()) && d <= now
    )
    for (const refund of state.refundedPeriods ?? []) {
      if (
        refund.kind !== "upgrade" &&
        refund.subscriptionId === state.sourceReference &&
        refund.environment === state.providerEnvironment &&
        new Date(refund.start) < end &&
        new Date(refund.end) > start
      ) {
        const at = time(new Date(refund.refundedAt))
        if (at <= now) candidates.push(at)
      }
    }
    if (!candidates.length)
      throw new Error("USAGE_DOWNGRADE_RECONCILIATION_REQUIRED")
    const effectiveAt = new Date(
      Math.min(...candidates.map((d) => d.getTime()))
    )
    transition = {
      kind: "paid-to-free",
      binding: paidUsageBinding(state),
      effectiveAt,
      sourceStart: start,
      sourceEnd: end,
      failedAt: state.paymentFailedAt ?? null,
    }
  } else if (
    state?.source &&
    state.source !== "internal" &&
    state.source !== "polar"
  )
    throw new Error("USAGE_SOURCE_RECONCILIATION_REQUIRED")
  return {
    kind: "free" as const,
    plan: "free" as const,
    phase,
    binding: workspaceCreatedAt.toISOString(),
    period,
    transition,
    grace: false,
  }
}

import { z } from "zod"
import {
  billableMemberCountSchema,
  billingCurrencySchema,
  pooledWorkspaceLimit,
  standardPlanSchema,
  workspaceAccessPhaseSchema,
} from "./billing-plan-contract"
import { reserveWorkspaceOverage } from "./workspace-overage-money"
import { workspaceUsageChargePolicy } from "./forge-billable-usage"
import type { EcbRateSnapshot } from "./workspace-overage-money"
import type {
  BillingCurrency,
  StandardPlan,
  WorkspaceAccessPhase,
} from "./billing-plan-contract"
import type {
  WorkspaceUsageBillingMode,
  WorkspaceUsageFeature,
} from "./forge-billable-usage"

/** USD millionths, independent of the EUR/USD subscription invoice currency. */
export const MONTHLY_AI_ALLOWANCE_PER_MEMBER_MICROS = 5_000_000
export const FREE_MONTHLY_WORKSPACE_AI_ALLOWANCE_MICROS = 5_000_000
export const TRIAL_WORKSPACE_AI_ALLOWANCE_MICROS = 5_000_000
const microsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

export const workspaceOveragePolicySchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      currency: billingCurrencySchema,
      monthlyCapMicros: microsSchema,
    })
    .strict(),
])
export type WorkspaceOveragePolicy = z.infer<
  typeof workspaceOveragePolicySchema
>
export const DEFAULT_WORKSPACE_OVERAGE_POLICY: Readonly<WorkspaceOveragePolicy> =
  Object.freeze({ enabled: false })

export function workspaceAiAllowanceMicros(
  plan: StandardPlan,
  activeMembers: number,
  accessPhase: WorkspaceAccessPhase
) {
  const selectedPlan = standardPlanSchema.parse(plan)
  const phase = workspaceAccessPhaseSchema.parse(accessPhase)
  if (phase === "trial" && selectedPlan === "free")
    throw new Error("Free does not have a paid-plan trial.")
  billableMemberCountSchema.parse(activeMembers)
  if (selectedPlan === "free") return FREE_MONTHLY_WORKSPACE_AI_ALLOWANCE_MICROS
  if (phase === "trial") return TRIAL_WORKSPACE_AI_ALLOWANCE_MICROS
  return pooledWorkspaceLimit(
    MONTHLY_AI_ALLOWANCE_PER_MEMBER_MICROS,
    activeMembers
  )
}

function sumMicros(...amounts: Array<number>) {
  const total = amounts.reduce(
    (sum, value) => sum + microsSchema.parse(value),
    0
  )
  if (!Number.isSafeInteger(total))
    throw new Error("AI budget accounting exceeds the supported range.")
  return total
}

export type WorkspaceBudgetAdmissionInput = {
  /** Trusted commercial plan, not a browser value or an unreviewed legacy alias. */
  plan: StandardPlan
  accessPhase: WorkspaceAccessPhase
  feature: WorkspaceUsageFeature
  billingMode: WorkspaceUsageBillingMode
  activeMembers: number
  billingCurrency: BillingCurrency
  /** Settled/reserved overage totals are in the subscription currency. */
  settledOverageMicros: number
  reservedOverageMicros: number
  incurredAt: Date
  rate?: EcbRateSnapshot
  /** Provider and included-pool accounting remains USD. */
  settledCostMicros: number
  reservedCostMicros: number
  requestedReservationMicros: number
  overage: WorkspaceOveragePolicy
  /** Server-confirmed authority to incur paid usage; configuration alone is insufficient. */
  paidOverageAuthorized: boolean
}

/**
 * Pure arithmetic only. The caller must lock quota state and persist the new
 * reservation/run atomically; a separate read then write is not safe admission.
 * This never charges a customer or treats checkout success as payment authority.
 */
export function evaluateWorkspaceBudgetAdmission(
  input: WorkspaceBudgetAdmissionInput
) {
  const plan = standardPlanSchema.parse(input.plan)
  const { usesWorkspaceAiPool } = workspaceUsageChargePolicy(input)
  const accessPhase = workspaceAccessPhaseSchema.parse(input.accessPhase)
  const includedMicros = workspaceAiAllowanceMicros(
    plan,
    input.activeMembers,
    accessPhase
  )
  const overage = workspaceOveragePolicySchema.parse(input.overage)
  const paidAuthorized = z.boolean().parse(input.paidOverageAuthorized)
  const currency = billingCurrencySchema.parse(input.billingCurrency)
  const eligible =
    usesWorkspaceAiPool &&
    plan !== "free" &&
    accessPhase !== "trial" &&
    overage.enabled &&
    paidAuthorized
  if (eligible && overage.currency !== currency)
    throw new Error("BILLING_OVERAGE_CURRENCY_MISMATCH")
  const committedMicros = sumMicros(
    input.settledCostMicros,
    input.reservedCostMicros
  )
  const requestedMicros = microsSchema.parse(input.requestedReservationMicros)
  const allowanceReservationMicros = usesWorkspaceAiPool ? requestedMicros : 0
  const projectedMicros = sumMicros(committedMicros, allowanceReservationMicros)
  const requestedOverageUsdMicros = Math.min(
    allowanceReservationMicros,
    Math.max(0, projectedMicros - includedMicros)
  )
  const cap = reserveWorkspaceOverage({
    currency,
    capMicros: eligible ? overage.monthlyCapMicros : 0,
    settledMicros: input.settledOverageMicros,
    reservedMicros: input.reservedOverageMicros,
    requestedUsdMicros: eligible ? requestedOverageUsdMicros : 0,
    incurredAt: input.incurredAt,
    rate: input.rate,
  })
  const withinPool =
    committedMicros < includedMicros && projectedMicros <= includedMicros
  const allowed =
    !usesWorkspaceAiPool || withinPool || (eligible && cap.allowed)
  // An EUR cap cannot be added to a USD included allowance. No 1:1 fallback.
  const usableOverageMicros = eligible
    ? currency === "usd"
      ? overage.monthlyCapMicros
      : null
    : 0
  const totalLimitMicros =
    usableOverageMicros === null
      ? null
      : sumMicros(includedMicros, usableOverageMicros)
  return {
    allowed,
    usesWorkspaceAiPool,
    allowanceReservationMicros,
    includedMicros,
    usableOverageMicros,
    totalLimitMicros,
    projectedMicros,
    remainingMicros:
      totalLimitMicros === null
        ? null
        : Math.max(0, totalLimitMicros - committedMicros),
    costCurrency: "usd" as const,
    overageCurrency: currency,
    overageRemainingMicros: cap.remainingMicros,
    billingOverageReservation:
      allowed && requestedOverageUsdMicros > 0 && eligible
        ? cap.reservation
        : null,
    // Incremental part of this reservation beyond the included pool, not an invoice.
    requestedOverageMicros: allowed ? requestedOverageUsdMicros : 0,
  }
}

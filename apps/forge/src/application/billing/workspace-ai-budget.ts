import { z } from "zod"
import {
  billableMemberCountSchema,
  pooledWorkspaceLimit,
  standardPlanSchema,
  workspaceAccessPhaseSchema,
} from "./billing-plan-contract"
import { workspaceUsageChargePolicy } from "./forge-billable-usage"
import type {
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
  const usableOverageMicros =
    plan !== "free" &&
    accessPhase !== "trial" &&
    overage.enabled &&
    paidAuthorized
      ? overage.monthlyCapMicros
      : 0
  const totalLimitMicros = sumMicros(includedMicros, usableOverageMicros)
  const committedMicros = sumMicros(
    input.settledCostMicros,
    input.reservedCostMicros
  )
  const requestedMicros = microsSchema.parse(input.requestedReservationMicros)
  const allowanceReservationMicros = usesWorkspaceAiPool ? requestedMicros : 0
  const projectedMicros = sumMicros(committedMicros, allowanceReservationMicros)
  const allowed =
    !usesWorkspaceAiPool ||
    (committedMicros < totalLimitMicros && projectedMicros <= totalLimitMicros)
  return {
    allowed,
    usesWorkspaceAiPool,
    allowanceReservationMicros,
    includedMicros,
    usableOverageMicros,
    totalLimitMicros,
    projectedMicros,
    remainingMicros: Math.max(0, totalLimitMicros - committedMicros),
    // Incremental part of this reservation beyond the included pool, not an invoice.
    requestedOverageMicros: allowed
      ? Math.min(
          allowanceReservationMicros,
          Math.max(0, projectedMicros - includedMicros)
        )
      : 0,
  }
}

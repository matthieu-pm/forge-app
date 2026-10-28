import { z } from "zod"
import {
  standardPlanSchema,
  workspaceAccessPhaseSchema,
} from "./billing-plan-contract"
import { MODEL_BILLING_MODES } from "@/application/agents/model-contract"

const billingModeSchema = z.enum(MODEL_BILLING_MODES)
export const workspaceUsageFeatureSchema = z.enum(["agent", "calls", "signals"])
export type WorkspaceUsageFeature = z.infer<typeof workspaceUsageFeatureSchema>
export type WorkspaceUsageBillingMode = z.infer<typeof billingModeSchema>
const usdMicrosSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

/** All classifications must come from trusted server snapshots. */
export function workspaceUsageChargePolicy(input: {
  plan: unknown
  accessPhase: unknown
  feature: unknown
  billingMode: unknown
}) {
  const plan = standardPlanSchema.parse(input.plan)
  const phase = workspaceAccessPhaseSchema.parse(input.accessPhase)
  if (phase === "trial" && plan === "free")
    throw new Error("Free does not have a paid-plan trial.")
  const feature = workspaceUsageFeatureSchema.parse(input.feature)
  const mode = billingModeSchema.parse(input.billingMode)
  return {
    usesWorkspaceAiPool:
      mode === "forge-managed" &&
      (plan === "free" || phase === "trial" || feature === "agent"),
  }
}

/** Returns customer allowance consumption, not the provider's internal cost. */
export function forgeBillableCostMicros(input: {
  plan: unknown
  accessPhase: unknown
  feature: unknown
  billingMode: unknown
  providerCostMicros: unknown
}) {
  const policy = workspaceUsageChargePolicy(input)
  // User-owned keys/provider subscriptions are paid directly to the provider.
  // Paid Calls/Signals are included outside the AI allowance and its overage.
  // Keep their provider cost in internal telemetry, not in the customer pool.
  if (!policy.usesWorkspaceAiPool) return 0
  // At cost: no multiplier or markup. Unknown pricing must be reconciled.
  return usdMicrosSchema.parse(input.providerCostMicros)
}

import { z } from "zod"
import { billingCurrencySchema } from "./billing-plan-contract"
import { workspaceOveragePolicySchema } from "./workspace-ai-budget"
import {
  convertBillingCapacity,
  moneyMicrosSchema,
} from "./workspace-overage-money"
import type { WorkspaceOveragePolicy } from "./workspace-ai-budget"
import type { EcbRateSnapshot } from "./workspace-overage-money"
import type { BillingCurrency } from "./billing-plan-contract"

/** Pure plan: persist once under the period/cap lock with the paid binding change. */
export function planOverageCurrencyCutover(input: {
  fromCurrency: BillingCurrency
  targetCurrency: BillingCurrency
  policy: WorkspaceOveragePolicy
  settledMicros: number
  reservedMicros: number
  periodStart: Date
  periodEnd: Date
  cutoverAt: Date
  rate?: EcbRateSnapshot
}) {
  const fromCurrency = billingCurrencySchema.parse(input.fromCurrency),
    targetCurrency = billingCurrencySchema.parse(input.targetCurrency),
    policy = workspaceOveragePolicySchema.parse(input.policy),
    settled = moneyMicrosSchema.parse(input.settledMicros),
    reserved = moneyMicrosSchema.parse(input.reservedMicros),
    start = z.date().parse(input.periodStart),
    end = z.date().parse(input.periodEnd),
    at = z.date().parse(input.cutoverAt)
  if (start > at || at >= end)
    throw new Error("BILLING_CURRENCY_CUTOVER_OUTSIDE_PERIOD")
  if (policy.enabled && policy.currency !== fromCurrency)
    throw new Error("BILLING_OVERAGE_CURRENCY_MISMATCH")
  const convert = (amountMicros: number, rounding: "down" | "up") =>
    convertBillingCapacity({
      fromCurrency,
      targetCurrency,
      amountMicros,
      rounding,
      at,
      rate: input.rate,
    })
  const cap = policy.enabled ? convert(policy.monthlyCapMicros, "down") : null,
    settledCapacity = convert(settled, "up"),
    reservedCapacity = convert(reserved, "up")
  const committed =
    BigInt(settledCapacity.amountMicros) + BigInt(reservedCapacity.amountMicros)
  if (committed > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("BILLING_MONEY_OVERFLOW")
  const remaining = cap ? BigInt(cap.amountMicros) - committed : 0n
  return {
    fromCurrency,
    targetCurrency,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    cutoverAt: at.toISOString(),
    policy: policy.enabled
      ? {
          enabled: true as const,
          currency: targetCurrency,
          monthlyCapMicros: cap!.amountMicros,
        }
      : { enabled: false as const },
    cap,
    settledCapacity,
    reservedCapacity,
    // Capacity shadows are not target-currency charges: original invoice,
    // reservation, usage-time quote and settlement identities remain immutable.
    committedCapacityMicros: Number(committed),
    remainingCapacityMicros: Number(remaining > 0n ? remaining : 0n),
    grantsPaymentAuthority: false as const,
    rewritesHistoricalCharges: false as const,
  }
}

import { z } from "zod"
import { billingCurrencySchema } from "./billing-plan-contract"
import { convertOverageCost } from "./workspace-overage-money"
import type { BillingCurrency } from "./billing-plan-contract"

type SettledMoney = ReturnType<typeof convertOverageCost>
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
function gcd(a: bigint, b: bigint): bigint {
  while (b) {
    const rest = a % b
    a = b
    b = rest
  }
  return a
}
function safe(value: bigint) {
  if (value < 0 || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("BILLING_INVOICE_OVERFLOW")
  return Number(value)
}

/** Cumulative per-original-period aggregation, with frozen usage-time quotes.
 * A durable outbox must bind the returned delta and report ID before delivery. */
export function planMonthlyOverageReport(input: {
  currency: BillingCurrency
  previouslyReportedMinor: number
  usage: ReadonlyArray<{ usageId: string; money: SettledMoney }>
}) {
  const currency = billingCurrencySchema.parse(input.currency)
  const previous = nonnegative.parse(input.previouslyReportedMinor)
  if (input.usage.length > 10000)
    throw new Error("BILLING_INVOICE_BATCH_TOO_LARGE")
  let numerator = 0n,
    denominator = 1n
  const ids = new Set<string>()
  for (const row of input.usage) {
    const id = z.uuid().parse(row.usageId)
    if (ids.has(id)) throw new Error("BILLING_DUPLICATE_USAGE")
    ids.add(id)
    const value = row.money
    if (value.currency !== currency || value.rounding !== "settlement")
      throw new Error("BILLING_UNSETTLED_OR_MIXED_CURRENCY")
    const verified = convertOverageCost({
      currency,
      providerUsdMicros: value.providerUsdMicros,
      incurredAt: z.coerce.date().parse(value.incurredAt),
      rate: value.rate ?? undefined,
      rounding: "settlement",
    })
    if (
      verified.amountMicros !== value.amountMicros ||
      verified.exactNumerator !== value.exactNumerator ||
      verified.exactDenominator !== value.exactDenominator
    )
      throw new Error("BILLING_CONVERSION_CHANGED")
    const n = BigInt(verified.exactNumerator),
      d = BigInt(verified.exactDenominator)
    const common = gcd(denominator, d)
    numerator = numerator * (d / common) + n * (denominator / common)
    denominator = denominator * (d / common)
    const reduction = gcd(numerator, denominator)
    numerator /= reduction
    denominator /= reduction
    if (denominator.toString().length > 1000)
      throw new Error("BILLING_INVOICE_PRECISION_LIMIT")
  }
  // Exact currency millionths to minor units, half up ONCE for the cumulative
  // original period. Prior delivered amounts are subtracted, never re-invoiced.
  const minorDenominator = denominator * 10000n
  const total = safe(
    (2n * numerator + minorDenominator) / (2n * minorDenominator)
  )
  if (total < previous)
    throw new Error("BILLING_CREDIT_RECONCILIATION_REQUIRED")
  return {
    currency,
    totalMinor: total,
    previouslyReportedMinor: previous,
    reportableMinor: total - previous,
    exactCurrencyMicrosNumerator: numerator.toString(),
    exactCurrencyMicrosDenominator: denominator.toString(),
    usageCount: ids.size,
  }
}

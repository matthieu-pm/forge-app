import { z } from "zod"
import { billingCurrencySchema } from "./billing-plan-contract"
import type { BillingCurrency } from "./billing-plan-contract"

export const ECB_REFERENCE_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
export const moneyMicrosSchema = z.number().int().nonnegative().safe()
export const ecbRateSnapshotSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.literal("ecb-daily-reference"),
    sourceUrl: z.literal(ECB_REFERENCE_URL),
    referenceDate: z.iso.date(),
    observedAt: z.iso.datetime({ offset: true }),
    // ECB quotes USD per EUR. Conversion divides by this value; never 1:1.
    usdPerEur: z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,8})?$/),
  })
  .strict()
export type EcbRateSnapshot = z.infer<typeof ecbRateSnapshotSchema>

function safeNumber(value: bigint) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("BILLING_MONEY_OVERFLOW")
  return Number(value)
}

/** Trusted server snapshot of the rate available when the provider usage starts. */
export function convertOverageCost(input: {
  currency: BillingCurrency
  providerUsdMicros: number
  incurredAt: Date
  rate?: EcbRateSnapshot
  rounding: "reservation" | "settlement"
}) {
  const currency = billingCurrencySchema.parse(input.currency)
  const usd = BigInt(moneyMicrosSchema.parse(input.providerUsdMicros))
  const incurredAt = z.date().parse(input.incurredAt)
  const rounding = z.enum(["reservation", "settlement"]).parse(input.rounding)
  let numerator = usd,
    denominator = 1n
  let snapshot: EcbRateSnapshot | null = null
  if (currency === "eur" && usd > 0n) {
    snapshot = ecbRateSnapshotSchema.parse(input.rate)
    const observedAt = new Date(snapshot.observedAt)
    const reference = new Date(`${snapshot.referenceDate}T00:00:00Z`)
    if (
      observedAt > incurredAt ||
      reference > observedAt ||
      incurredAt.getTime() - reference.getTime() > 7 * 86400000
    )
      throw new Error("BILLING_FX_RATE_UNAVAILABLE_FOR_USAGE")
    const [whole, fraction = ""] = snapshot.usdPerEur.split(".")
    const scale = 10n ** BigInt(fraction.length)
    denominator = BigInt(whole) * scale + BigInt(fraction || "0")
    if (denominator <= 0n) throw new Error("BILLING_FX_RATE_INVALID")
    numerator = usd * scale
  }
  const amount =
    rounding === "reservation"
      ? (numerator + denominator - 1n) / denominator
      : (2n * numerator + denominator) / (2n * denominator)
  return {
    currency,
    providerUsdMicros: Number(usd),
    amountMicros: safeNumber(amount),
    incurredAt: incurredAt.toISOString(),
    rate: snapshot,
    exactNumerator: numerator.toString(),
    exactDenominator: denominator.toString(),
    rounding,
  }
}

/** Invoice-currency cap arithmetic. Persist this reservation under the ledger lock. */
export function reserveWorkspaceOverage(input: {
  currency: BillingCurrency
  capMicros: number
  settledMicros: number
  reservedMicros: number
  requestedUsdMicros: number
  incurredAt: Date
  rate?: EcbRateSnapshot
}) {
  const cap = BigInt(moneyMicrosSchema.parse(input.capMicros))
  const committed =
    BigInt(moneyMicrosSchema.parse(input.settledMicros)) +
    BigInt(moneyMicrosSchema.parse(input.reservedMicros))
  const reservation = convertOverageCost({
    currency: input.currency,
    providerUsdMicros: input.requestedUsdMicros,
    incurredAt: input.incurredAt,
    rate: input.rate,
    rounding: "reservation",
  })
  const projected = committed + BigInt(reservation.amountMicros)
  return {
    allowed: committed < cap && projected <= cap,
    committedMicros: safeNumber(committed),
    projectedMicros: safeNumber(projected),
    remainingMicros: safeNumber(cap > committed ? cap - committed : 0n),
    reservation,
  }
}

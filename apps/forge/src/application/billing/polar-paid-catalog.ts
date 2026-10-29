import { z } from "zod"
import {
  billingCurrencySchema,
  monthlySeatPriceMinor,
  selfServePlanSchema,
} from "./billing-plan-contract"
import type { BillingCurrency, SelfServePlan } from "./billing-plan-contract"
import type { Polar } from "@polar-sh/sdk/2026-10"

type Product = Awaited<ReturnType<Polar["products"]["get"]>>
export type PaidCatalogProduct = Pick<
  Product,
  | "id"
  | "is_archived"
  | "is_recurring"
  | "recurring_interval"
  | "recurring_interval_count"
  | "prices"
>

/** Approved flat monthly per-seat price, explicitly exclusive of tax. */
export function verifyPaidCatalog(
  product: PaidCatalogProduct,
  input: { productId: string; plan: SelfServePlan; currency: BillingCurrency }
) {
  const plan = selfServePlanSchema.parse(input.plan),
    currency = billingCurrencySchema.parse(input.currency)
  if (
    product.id !== z.uuid().parse(input.productId) ||
    product.is_archived !== false ||
    product.is_recurring !== true ||
    product.recurring_interval !== "month" ||
    product.recurring_interval_count !== 1
  )
    throw new Error("BILLING_CATALOG_PRODUCT_MISMATCH")
  const prices = product.prices.filter((p) => p.is_archived === false)
  const currencies = new Set<string>()
  for (const price of prices) {
    if (
      !billingCurrencySchema.safeParse(price.price_currency).success ||
      currencies.has(price.price_currency) ||
      price.amount_type !== "seat_based" ||
      price.source !== "catalog" ||
      price.product_id !== product.id ||
      price.tax_behavior !== "exclusive" ||
      price.seat_tiers.minimum_seats !== 1 ||
      price.seat_tiers.maximum_seats !== null ||
      price.seat_tiers.tiers.length !== 1 ||
      ![undefined, "volume", "graduated"].includes(
        price.seat_tiers.seat_tier_type
      )
    )
      throw new Error("BILLING_CATALOG_PRICE_MISMATCH")
    const tier = price.seat_tiers.tiers[0]
    if (
      tier.min_seats !== 1 ||
      (tier.max_seats !== undefined && tier.max_seats !== null) ||
      tier.price_per_seat !== monthlySeatPriceMinor[plan]
    )
      throw new Error("BILLING_CATALOG_PRICE_MISMATCH")
    currencies.add(price.price_currency)
  }
  // Polar requires the organization's default currency on every product. Native
  // EUR/USD catalog prices can share a product; never accept duplicate prices
  // for the selected currency or fall back to automatic FX from another price.
  const price = prices.find((p) => p.price_currency === currency)
  if (!price) throw new Error("BILLING_CATALOG_PRICE_MISMATCH")
  return {
    productId: product.id,
    priceId: z.uuid().parse(price.id),
    currency,
    unitPriceMinor: monthlySeatPriceMinor[plan],
    taxBehavior: "exclusive" as const,
  }
}

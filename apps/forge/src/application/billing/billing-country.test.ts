import { describe, expect, expectTypeOf, it } from "vitest"
import { workspaceBillingCurrency } from "./billing-country"
import type { billingCountrySchema } from "./billing-country"
import type { z } from "zod"
import type { Polar } from "@polar-sh/sdk/2026-10"

describe("workspace billing-country pricing", () => {
  it.each([
    "AT",
    "BE",
    "BG",
    "HR",
    "CY",
    "CZ",
    "DK",
    "EE",
    "FI",
    "FR",
    "DE",
    "GR",
    "HU",
    "IE",
    "IT",
    "LV",
    "LT",
    "LU",
    "MT",
    "NL",
    "PL",
    "PT",
    "RO",
    "SK",
    "SI",
    "ES",
    "SE",
    "IS",
    "LI",
    "NO",
    "GB",
    "CH",
  ])("prices a %s workspace in EUR", (country) => {
    expect(workspaceBillingCurrency(country)).toEqual({
      country,
      currency: "eur",
    })
  })

  it.each(["US", "CA", "JP", "AU", "BR", "IN", "RS", "TR", "MC", "AD", "VA"])(
    "prices other accepted billing countries (%s) in USD",
    (country) => {
      expect(workspaceBillingCurrency(country)).toEqual({
        country,
        currency: "usd",
      })
    }
  )

  it("normalizes a stored country code without consulting locale or IP", () => {
    expect(workspaceBillingCurrency(" gb ")).toEqual({
      country: "GB",
      currency: "eur",
    })
    expect(workspaceBillingCurrency(" us ")).toEqual({
      country: "US",
      currency: "usd",
    })
  })

  it.each([
    undefined,
    null,
    "",
    " ",
    "Europe",
    "EUR",
    "UK",
    "ZZ",
    "USA",
    "FR-US",
    33,
    {},
    "RU",
  ])(
    "requires correction of missing, invalid or unsupported billing country %j",
    (country) => {
      expect(() => workspaceBillingCurrency(country)).toThrow()
    }
  )

  it("keeps accepted country inputs aligned with the pinned provider API", () => {
    type ProviderCountry = NonNullable<
      Parameters<Polar["checkouts"]["create"]>[0]["customer_billing_address"]
    >["country"]
    expectTypeOf<
      z.infer<typeof billingCountrySchema>
    >().toEqualTypeOf<ProviderCountry>()
  })
})

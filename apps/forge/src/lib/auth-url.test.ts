import { describe, expect, it } from "vitest"

import { resolveAuthUrl } from "./auth-url"

describe("auth origin selection", () => {
  it("keeps an explicitly configured origin", () => {
    expect(
      resolveAuthUrl({
        BETTER_AUTH_URL: "https://custom.forge.test",
        VERCEL_ENV: "preview",
        VERCEL_URL: "preview.forge.test",
      })
    ).toBe("https://custom.forge.test")
  })

  it("uses the current preview deployment's own HTTPS origin", () => {
    expect(
      resolveAuthUrl({
        VERCEL_ENV: "preview",
        VERCEL_URL: "forge-pr-2.vercel.app",
      })
    ).toBe("https://forge-pr-2.vercel.app")
  })

  it("still requires explicit configuration outside Preview", () => {
    for (const environment of ["production", "development", undefined]) {
      expect(
        resolveAuthUrl({
          VERCEL_ENV: environment,
          VERCEL_URL: "forge.vercel.app",
        })
      ).toBeUndefined()
    }
    expect(resolveAuthUrl({ VERCEL_ENV: "preview" })).toBeUndefined()
  })
})

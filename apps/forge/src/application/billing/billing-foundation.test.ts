// @vitest-environment node
import { describe, expect, it } from "vitest"
import { readBillingConfig } from "./billing-config.server"
import { workspaceBillingIdentity } from "./billing-authority"
import type { Actor } from "@/application/actor"

const env = {
  FORGE_BILLING_ENABLED: "true",
  POLAR_ENVIRONMENT: "sandbox",
  POLAR_ACCESS_TOKEN: "fixture-secret-token",
  POLAR_WEBHOOK_SECRET: "fixture-webhook-secret",
  POLAR_STARTER_USD_PRODUCT_ID: "00000000-0000-4000-8000-000000000001",
  POLAR_STARTER_EUR_PRODUCT_ID: "00000000-0000-4000-8000-000000000002",
  POLAR_PLUS_USD_PRODUCT_ID: "00000000-0000-4000-8000-000000000003",
  POLAR_PLUS_EUR_PRODUCT_ID: "00000000-0000-4000-8000-000000000004",
  BETTER_AUTH_URL: "http://localhost:3000",
}
const actor: Actor = {
  userId: "alice",
  workspaceId: "workspace-a",
  workspaceRole: "owner",
  authentication: { kind: "session", sessionId: "session-a" },
  scopes: null,
}

describe("billing foundation", () => {
  it("stays disabled without touching optional Polar credentials", () => {
    expect(readBillingConfig({})).toEqual({ enabled: false })
    expect(
      readBillingConfig({
        FORGE_BILLING_ENABLED: "false",
        POLAR_ENVIRONMENT: "wrong",
      })
    ).toEqual({ enabled: false })
  })
  it("requires an explicit environment and valid enabled configuration", () => {
    expect(readBillingConfig(env)).toMatchObject({
      enabled: true,
      environment: "sandbox",
    })
    expect(() =>
      readBillingConfig({ ...env, POLAR_ENVIRONMENT: undefined })
    ).toThrow("environment")
    expect(() =>
      readBillingConfig({ ...env, FORGE_BILLING_ENABLED: "yes" })
    ).toThrow()
  })
  it("does not expose secrets in configuration errors", () => {
    try {
      readBillingConfig({
        ...env,
        POLAR_STARTER_USD_PRODUCT_ID: env.POLAR_ACCESS_TOKEN,
      })
    } catch (error) {
      expect(String(error)).toContain("paidProducts.starter.usd")
      expect(String(error)).not.toContain(env.POLAR_ACCESS_TOKEN)
      return
    }
    throw new Error("Expected invalid product configuration to fail")
  })
  it.each([
    "http://forge.test",
    "https://user:password@forge.test",
    "https://forge.test/path",
    "https://forge.test/?secret=value",
  ])("rejects unsafe production application origins %s", (url) => {
    expect(() =>
      readBillingConfig({
        ...env,
        POLAR_ENVIRONMENT: "production",
        POLAR_STARTER_EUR_PRODUCT_ID: "00000000-0000-4000-8000-000000000002",
        POLAR_PLUS_USD_PRODUCT_ID: "00000000-0000-4000-8000-000000000003",
        POLAR_PLUS_EUR_PRODUCT_ID: "00000000-0000-4000-8000-000000000004",
        BETTER_AUTH_URL: url,
      })
    ).toThrow()
  })
  it("identifies the workspace consistently across its billing admins", () => {
    expect(workspaceBillingIdentity(actor).externalCustomerId).toBe(
      "forge:workspace:workspace-a"
    )
    expect(
      workspaceBillingIdentity({
        ...actor,
        userId: "bob",
        workspaceRole: "admin",
      }).externalCustomerId
    ).toBe(workspaceBillingIdentity(actor).externalCustomerId)
    expect(
      workspaceBillingIdentity({ ...actor, workspaceId: "workspace-b" })
        .externalCustomerId
    ).not.toBe(workspaceBillingIdentity(actor).externalCustomerId)
  })
  it("rejects ordinary members and scoped automation credentials", () => {
    expect(() =>
      workspaceBillingIdentity({ ...actor, workspaceRole: "member" })
    ).toThrow()
    expect(() =>
      workspaceBillingIdentity({
        ...actor,
        authentication: { kind: "apiKey", credentialId: "key" },
      })
    ).toThrow()
  })
})

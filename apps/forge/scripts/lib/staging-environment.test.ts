// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  STAGING,
  assertStagingEnvironment,
} from "../../../../packages/environment/staging-environment"

const base = {
  FORGE_ENVIRONMENT: "staging",
  FORGE_EXTERNAL_INTEGRATIONS: "disabled",
  VERCEL: "1",
  VERCEL_PROJECT_ID: STAGING.webProjectId,
  BETTER_AUTH_URL: STAGING.webOrigin,
  EVE_AGENT_RUNTIME_URL: STAGING.runtimeOrigin,
  FORGE_AGENT_BLOB_ADAPTER: "vercel-private",
  BLOB_STORE_ID: STAGING.blobStoreId,
  FORGE_BILLING_ENABLED: "false",
  FORGE_BILLING_WEBHOOKS_ENABLED: "false",
  FORGE_AGENT_CHANNEL_SECRET: "isolated-fixture-secret-with-32-characters",
  DATABASE_URL: `postgresql://${STAGING.databaseRole}:fixture@${STAGING.database.host.replace(".", "-pooler.")}/${STAGING.database.database}?sslmode=require`,
}
describe("staging resource configuration", () => {
  it("accepts the isolated web/runtime pair", () => {
    expect(() => assertStagingEnvironment(base, "web")).not.toThrow()
    expect(() =>
      assertStagingEnvironment(
        {
          ...base,
          VERCEL_PROJECT_ID: STAGING.runtimeProjectId,
          FORGE_APP_ORIGIN: STAGING.webOrigin,
        },
        "runtime"
      )
    ).not.toThrow()
  })
  it.each([
    { FORGE_ENVIRONMENT: undefined },
    { VERCEL_PROJECT_ID: "prj_S0XLtdngbexhl2ao7WviBrlMScar" },
    { BETTER_AUTH_URL: "https://forge-app-mauve.vercel.app" },
    { EVE_AGENT_RUNTIME_URL: "https://forge-agent-runtime.vercel.app" },
    { BLOB_STORE_ID: "store_production" },
    { FORGE_AGENT_BLOB_ADAPTER: "local" },
    { OPENAI_API_KEY: "credential" },
    { FORGE_GOOGLE_MEET_CLIENT_ID: "production-client" },
    { RESEND_API_KEY: "credential" },
    { POLAR_ACCESS_TOKEN: "credential" },
    { FORGE_BILLING_ENABLED: "true" },
    { EVE_EVAL_FIXTURE_MODE: "true" },
    {
      DATABASE_URL:
        "postgresql://fixture:fixture@ep-lingering-bread-zazpwrxp-pooler.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require",
    },
    { DATABASE_URL: base.DATABASE_URL + "&host=production.example.com" },
  ])(
    "rejects a mixed resource configuration without disclosing values: %j",
    (overrides) => {
      expect(() =>
        assertStagingEnvironment({ ...base, ...overrides }, "web")
      ).toThrow("values are redacted")
    }
  )
  it("refuses the production callback at runtime", () => {
    expect(() =>
      assertStagingEnvironment(
        {
          ...base,
          VERCEL_PROJECT_ID: STAGING.runtimeProjectId,
          FORGE_APP_ORIGIN: "https://forge-app-mauve.vercel.app",
        },
        "runtime"
      )
    ).toThrow()
  })
  it("allows sandbox mode without opening access to unregistered credentials", () => {
    const sandbox = { ...base, FORGE_EXTERNAL_INTEGRATIONS: "sandbox" }
    expect(() => assertStagingEnvironment(sandbox, "web")).not.toThrow()
    for (const name of [
      "OPENAI_API_KEY",
      "RESEND_API_KEY",
      "POLAR_ACCESS_TOKEN",
      "FORGE_GOOGLE_MEET_CLIENT_SECRET",
      "FORGE_MICROSOFT_TEAMS_CLIENT_ID",
      "FORGE_ZOOM_CLIENT_SECRET",
    ]) {
      expect(() =>
        assertStagingEnvironment(
          { ...sandbox, [name]: "copied-production-credential" },
          "web"
        )
      ).toThrow("values are redacted")
    }
    expect(() =>
      assertStagingEnvironment(
        {
          ...sandbox,
          VERCEL_PROJECT_ID: STAGING.runtimeProjectId,
          FORGE_APP_ORIGIN: STAGING.webOrigin,
        },
        "runtime"
      )
    ).toThrow()
  })
})

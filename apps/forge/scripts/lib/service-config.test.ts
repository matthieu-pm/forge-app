// @vitest-environment node
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  assertServiceConfiguration,
  inspectServiceConfiguration,
} from "../../../../packages/environment/service-config"
import type { ServiceEnvironment } from "../../../../packages/environment/service-config"

const secret = "valid-test-secret-" + "a".repeat(32)
const core = {
  FORGE_ENVIRONMENT: "production",
  BLOB_STORE_ID: "store_fixture",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_fixture_private",
  DATABASE_URL:
    "postgresql://operator:private-db-password@db.example.test/forge",
  BETTER_AUTH_URL: "https://app.example.test",
  BETTER_AUTH_SECRET: secret,
  RESEND_API_KEY: "private-mail-key",
  RESEND_FROM_EMAIL: "Forge <mail@example.test>",
  FORGE_FEATURE_AGENT_UI: "false",
  FORGE_CALLS_ENABLED: "false",
  FORGE_DESKTOP_RELEASE_ENABLED: "false",
}
const runtime = {
  FORGE_ENVIRONMENT: "production",
  FORGE_APP_ORIGIN: "https://app.example.test",
  FORGE_AGENT_CHANNEL_SECRET: secret,
}
const agent = {
  ...core,
  FORGE_FEATURE_AGENT_UI: "true",
  EVE_AGENT_RUNTIME_URL: "https://runtime.example.test",
  FORGE_AGENT_CHANNEL_SECRET: secret,
  FORGE_AGENT_CAPABILITY_SECRET: secret,
  FORGE_AGENT_MODEL_ACCESS_SECRET: secret,
  FORGE_AGENT_LOCAL_INGEST_SECRET: secret,
  FORGE_MODEL_CREDENTIAL_KEK: Buffer.alloc(32, 17).toString("base64"),
}
const variables = (
  env: ServiceEnvironment,
  service: "app" | "runtime" = "app"
) =>
  inspectServiceConfiguration(env, service).issues.map(
    (issue) => issue.variable
  )

describe("service-specific startup configuration (FOR-26)", () => {
  it("AT-02: core starts without disabled Calls, desktop, API or model-provider credentials", () => {
    expect(assertServiceConfiguration(core, "app").ready).toBe(true)
  })

  it("AT-01: enabled Calls fails with the selected provider's variable names, never values", () => {
    const env = {
      ...core,
      FORGE_CALLS_ENABLED: "true",
      FORGE_CALLS_PROVIDERS: "zoom",
      FORGE_ZOOM_CLIENT_ID: "sensitive-client-id",
      OPENAI_API_KEY: "private-summary-key",
      FORGE_MODEL_CREDENTIAL_KEK: "private-invalid-key",
    }
    expect(variables(env)).toEqual([
      "FORGE_ZOOM_CLIENT_SECRET",
      "FORGE_MODEL_CREDENTIAL_KEK",
    ])
    let error: unknown
    try {
      assertServiceConfiguration(env, "app")
    } catch (caught) {
      error = caught
    }
    const serialized = JSON.stringify(error) + String(error)
    for (const value of [
      core.DATABASE_URL,
      core.BETTER_AUTH_SECRET,
      env.FORGE_ZOOM_CLIENT_ID,
      env.FORGE_MODEL_CREDENTIAL_KEK,
    ]) {
      expect(serialized).not.toContain(value)
    }
    expect(serialized).toContain("FORGE_ZOOM_CLIENT_SECRET")
  })

  it("requires an explicit provider selection when Calls is enabled without OAuth settings", () => {
    expect(variables({ ...core, FORGE_CALLS_ENABLED: "true" })).toContain(
      "FORGE_CALLS_PROVIDERS"
    )
  })

  it("checks only selected Calls providers and honors an explicit disable with stale credentials", () => {
    const calls = {
      ...core,
      FORGE_CALLS_ENABLED: "true",
      FORGE_CALLS_PROVIDERS: "google",
      FORGE_GOOGLE_MEET_CLIENT_ID: "client",
      FORGE_GOOGLE_MEET_CLIENT_SECRET: "oauth-secret",
      OPENAI_API_KEY: "private-summary-key",
      FORGE_MODEL_CREDENTIAL_KEK: agent.FORGE_MODEL_CREDENTIAL_KEK,
    }
    expect(assertServiceConfiguration(calls, "app").ready).toBe(true)
    expect(
      assertServiceConfiguration(
        {
          ...calls,
          FORGE_CALLS_ENABLED: "false",
          FORGE_GOOGLE_MEET_CLIENT_SECRET: undefined,
        },
        "app"
      ).ready
    ).toBe(true)
    expect(
      variables({ ...calls, FORGE_CALLS_PROVIDERS: "not-a-provider" })
    ).toContain("FORGE_CALLS_PROVIDERS")
  })

  it.each(["development", "staging", "production"])(
    "validates the runtime in %s without web/DB/provider credentials",
    (environment) => {
      expect(
        assertServiceConfiguration(
          { ...runtime, FORGE_ENVIRONMENT: environment },
          "runtime"
        ).ready
      ).toBe(true)
    }
  )

  it.each(["AGENT_FAKE_RUNTIME_ENABLED", "EVE_EVAL_FIXTURE_MODE"])(
    "rejects %s in deployed environments, even with the agent UI disabled",
    (name) => {
      expect(variables({ ...core, [name]: "true" })).toContain(name)
      expect(
        variables(
          { ...runtime, FORGE_ENVIRONMENT: "staging", [name]: "true" },
          "runtime"
        )
      ).toContain(name)
      expect(variables({ ...runtime, [name]: "true" }, "runtime")).toContain(
        name
      )
    }
  )

  it("keeps local fixture evals usable", () => {
    expect(
      assertServiceConfiguration({ EVE_EVAL_FIXTURE_MODE: "true" }, "runtime")
        .ready
    ).toBe(true)
  })

  it.each([
    { NODE_ENV: "production" },
    { VERCEL_ENV: "production" },
    { VERCEL_ENV: "preview" },
  ])("infers deployed safeguards from process metadata: %j", (metadata) => {
    expect(
      variables({ ...metadata, EVE_EVAL_FIXTURE_MODE: "true" }, "runtime")
    ).toContain("EVE_EVAL_FIXTURE_MODE")
  })

  it("rejects misspelled environments and downgrading a production process", () => {
    expect(
      variables({ ...runtime, FORGE_ENVIRONMENT: "prod" }, "runtime")
    ).toContain("FORGE_ENVIRONMENT")
    expect(
      variables(
        {
          ...runtime,
          FORGE_ENVIRONMENT: "development",
          NODE_ENV: "production",
        },
        "runtime"
      )
    ).toContain("FORGE_ENVIRONMENT")
    expect(
      JSON.stringify(
        inspectServiceConfiguration(
          { ...runtime, FORGE_ENVIRONMENT: "private-invalid-environment" },
          "runtime"
        )
      )
    ).not.toContain("private-invalid-environment")
  })

  it("uses the same preview-origin fallback as Better Auth", () => {
    expect(
      assertServiceConfiguration(
        {
          ...core,
          FORGE_ENVIRONMENT: undefined,
          VERCEL_ENV: "preview",
          VERCEL_URL: "forge-preview.vercel.app",
          BETTER_AUTH_URL: undefined,
        },
        "app"
      ).ready
    ).toBe(true)
  })

  it.each([
    "not-a-url-with-private-data",
    "https://operator:private@callback.test",
    "https://callback.test/path",
    "https://callback.test?private=value",
    "http://callback.test",
    "https://localhost",
  ])("rejects invalid runtime origins without echoing them", (origin) => {
    const env = { ...runtime, FORGE_APP_ORIGIN: origin }
    expect(variables(env, "runtime")).toContain("FORGE_APP_ORIGIN")
    expect(() => assertServiceConfiguration(env, "runtime")).toThrow(
      "FORGE_APP_ORIGIN"
    )
    expect(
      JSON.stringify(inspectServiceConfiguration(env, "runtime"))
    ).not.toContain(origin)
  })

  it("validates agent proxy and vault credentials without requiring arbitrary provider keys", () => {
    expect(assertServiceConfiguration(agent, "app").ready).toBe(true)
    expect(
      variables({ ...agent, FORGE_AGENT_MODEL_ACCESS_SECRET: undefined })
    ).toContain("FORGE_AGENT_MODEL_ACCESS_SECRET")
    expect(
      variables({ ...agent, FORGE_MODEL_CREDENTIAL_KEK: "x".repeat(44) })
    ).toContain("FORGE_MODEL_CREDENTIAL_KEK")
    expect(
      variables({
        ...agent,
        FORGE_AGENT_BLOB_ADAPTER: "vercel-private",
        BLOB_READ_WRITE_TOKEN: undefined,
      })
    ).toContain("BLOB_READ_WRITE_TOKEN")
  })

  it("reports all missing core variables together", () => {
    expect(
      variables({
        FORGE_ENVIRONMENT: "production",
        FORGE_FEATURE_AGENT_UI: "false",
      })
    ).toEqual([
      "DATABASE_URL",
      "BETTER_AUTH_URL",
      "BETTER_AUTH_SECRET",
      "RESEND_API_KEY",
      "RESEND_FROM_EMAIL",
      "BLOB_STORE_ID",
      "BLOB_READ_WRITE_TOKEN",
    ])
  })

  it("requires mail for deployed public verified signup and rejects placeholder auth secrets", () => {
    expect(
      variables({
        ...core,
        RESEND_API_KEY: undefined,
        BETTER_AUTH_SECRET: "replace-with-a-long-random-secret",
      })
    ).toEqual(["BETTER_AUTH_SECRET", "RESEND_API_KEY"])
  })

  it("applies Polar checks only when billing or webhooks are enabled", () => {
    expect(variables({ ...core, FORGE_BILLING_ENABLED: "true" })).toContain(
      "POLAR_STARTER_EUR_PRODUCT_ID"
    )
    const webhookVariables = variables({
      ...core,
      FORGE_BILLING_WEBHOOKS_ENABLED: "true",
    })
    expect(webhookVariables).toEqual([
      "POLAR_ENVIRONMENT",
      "POLAR_WEBHOOK_SECRET",
    ])
    expect(variables({ ...core, FORGE_BILLING_ENABLED: "maybe" })).toContain(
      "FORGE_BILLING_ENABLED"
    )
  })

  it("validates the job being run without acquiring unrelated service credentials", () => {
    const env = {
      FORGE_ENVIRONMENT: "production",
      DATABASE_URL: core.DATABASE_URL,
    }
    expect(
      assertServiceConfiguration(env, "jobs", { job: "workflow-health" }).ready
    ).toBe(true)
    expect(
      assertServiceConfiguration(env, "jobs", { job: "product-retention" })
        .ready
    ).toBe(true)
    expect(
      inspectServiceConfiguration(
        { ...env, FORGE_DESKTOP_RELEASE_ENABLED: "true" },
        "jobs",
        { job: "product-retention" }
      ).issues.map((issue) => issue.variable)
    ).toContain("R2_ACCESS_KEY_ID")
    expect(() =>
      assertServiceConfiguration(env, "jobs", { job: "calls-sync" })
    ).toThrow("FORGE_CALLS_ENABLED")
  })

  it("requires signing in production packages, while keeping development packaging usable", () => {
    const env = { FORGE_DESKTOP_APP_ORIGIN: core.BETTER_AUTH_URL }
    expect(assertServiceConfiguration(env, "release").ready).toBe(true)
    expect(() =>
      assertServiceConfiguration(
        { ...env, FORGE_ENVIRONMENT: "production" },
        "release"
      )
    ).toThrow("APPLE_SIGNING_IDENTITY")
    expect(() =>
      assertServiceConfiguration({ ...env, APPLE_ID: "private-id" }, "release")
    ).toThrow("APPLE_APP_SPECIFIC_PASSWORD")
  })

  it("separates release upload, promotion and pause credentials", () => {
    const env = {
      FORGE_ENVIRONMENT: "production",
      FORGE_RELEASE_API_ORIGIN: core.BETTER_AUTH_URL,
      FORGE_DESKTOP_RELEASE_API_SECRET: secret,
    }
    expect(
      assertServiceConfiguration(env, "release", { operation: "pause" }).ready
    ).toBe(true)
    expect(() =>
      assertServiceConfiguration(env, "release", { operation: "promote" })
    ).toThrow("FORGE_DESKTOP_DOWNLOAD_ORIGIN")
    expect(() =>
      assertServiceConfiguration(env, "release", { operation: "upload" })
    ).toThrow("R2_ACCESS_KEY_ID")
  })

  it("actually aborts runtime startup before launching the child command", () => {
    const root = resolve(import.meta.dirname, "../../../..")
    const result = spawnSync(
      process.execPath,
      [
        "services/agent-runtime/scripts/run-with-root-env.mjs",
        process.execPath,
        "-e",
        "console.log('child-started')",
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          CI: "true",
          NODE_ENV: "production",
          FORGE_APP_ORIGIN: "private-invalid-origin",
          FORGE_AGENT_CHANNEL_SECRET: secret,
        },
        encoding: "utf8",
      }
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("FORGE_APP_ORIGIN")
    expect(result.stdout).not.toContain("child-started")
    expect(result.stderr).not.toContain("private-invalid-origin")
    expect(result.stderr).not.toContain(secret)
  })

  it.each([
    ["apps/forge/scripts/sync-calls.ts", "FORGE_ZOOM_CLIENT_SECRET"],
    [
      "apps/forge/scripts/desktop-release/upload-candidate.ts",
      "R2_ACCESS_KEY_ID",
    ],
  ])(
    "aborts %s at preflight before reading data or artifacts",
    (script, variable) => {
      const result = spawnSync("bun", ["--no-env-file", script], {
        cwd: resolve(import.meta.dirname, "../../../.."),
        env: {
          PATH: process.env.PATH,
          CI: "true",
          NODE_ENV: "production",
          FORGE_ENVIRONMENT: "production",
          DATABASE_URL: core.DATABASE_URL,
          FORGE_CALLS_ENABLED: "true",
          FORGE_CALLS_PROVIDERS: "zoom",
          FORGE_ZOOM_CLIENT_ID: "private-job-client-id",
        },
        encoding: "utf8",
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("ServiceConfigurationError")
      expect(result.stderr).toContain(variable)
      expect(result.stderr).not.toContain(core.DATABASE_URL)
      expect(result.stderr).not.toContain("private-job-client-id")
      expect(result.stderr).not.toContain("ENOENT")
    }
  )
})

describe("operational monitor enablement", () => {
  it("requires routing and scheduler authority only when enabled", () => {
    const disabled = inspectServiceConfiguration({}, "app")
    expect(
      disabled.issues.some(
        (issue) =>
          issue.variable.startsWith("FORGE_OPERATIONS") ||
          issue.variable === "CRON_SECRET"
      )
    ).toBe(false)
    const enabled = inspectServiceConfiguration(
      { FORGE_OPERATIONS_MONITOR_ENABLED: "true" },
      "app"
    )
    expect(enabled.issues.map((issue) => issue.variable)).toEqual(
      expect.arrayContaining([
        "FORGE_OPERATIONS_WEBHOOK_URL",
        "FORGE_OPERATIONS_WEBHOOK_TOKEN",
        "CRON_SECRET",
      ])
    )
  })
})

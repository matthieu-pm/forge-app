// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  appOrigin,
  assertPreviewEnvironment,
  PREVIEW,
  previewPeerOrigin,
  runtimeOrigin,
} from "../../../../packages/environment/preview-environment"
import { assertStagingEnvironment } from "../../../../packages/environment/staging-environment"
import { fetchWithStagingIdentity } from "../../../../packages/environment/staging-service-auth"

const related = (
  id: string,
  host = "forge-peer-git-feature-matthieu-pm.vercel.app"
) =>
  JSON.stringify([
    {
      project: { id },
      production: { alias: "app.forgenow.tech" },
      preview: { branch: host },
    },
  ])
const base = {
  FORGE_RESOURCE_PROFILE: "preview",
  FORGE_ENVIRONMENT: "staging",
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: PREVIEW.webProjectId,
  VERCEL_RELATED_PROJECTS: related(PREVIEW.runtimeProjectId),
  FORGE_EXTERNAL_INTEGRATIONS: "disabled",
  FORGE_AGENT_CHANNEL_SECRET: "p".repeat(43),
  FORGE_AGENT_BLOB_ADAPTER: "vercel-private",
  BLOB_STORE_ID: PREVIEW.blobStoreId,
  FORGE_BILLING_ENABLED: "false",
  FORGE_BILLING_WEBHOOKS_ENABLED: "false",
  FORGE_CALLS_ENABLED: "false",
  DATABASE_URL: `postgresql://${PREVIEW.databaseRole}:fixture@${PREVIEW.database.host}/${PREVIEW.database.database}?sslmode=require`,
}
describe("isolated Preview services", () => {
  afterEach(() => vi.unstubAllEnvs())
  it("accepts the registered pair and resolves branch aliases in both directions", () => {
    expect(() => assertStagingEnvironment(base, "web")).not.toThrow()
    expect(runtimeOrigin(base)).toBe(
      "https://forge-peer-git-feature-matthieu-pm.vercel.app"
    )
    const runtime = {
      ...base,
      VERCEL_PROJECT_ID: PREVIEW.runtimeProjectId,
      VERCEL_RELATED_PROJECTS: related(PREVIEW.webProjectId),
    }
    expect(() => assertPreviewEnvironment(runtime, "runtime")).not.toThrow()
    expect(appOrigin(runtime)).toBe(runtimeOrigin(base))
  })
  it.each([
    {},
    { preview: {} },
    { preview: { branch: "https://app.forgenow.tech" } },
    { preview: { branch: "app.forgenow.tech" } },
    { preview: { branch: "peer.vercel.app/redirect" } },
  ])(
    "never falls back to production or accepts an unsafe alias: %j",
    (entry) => {
      const env = {
        ...base,
        EVE_AGENT_RUNTIME_URL: "https://production.vercel.app",
        VERCEL_RELATED_PROJECTS: JSON.stringify([
          {
            ...entry,
            project: { id: PREVIEW.runtimeProjectId },
            production: { alias: "app.forgenow.tech" },
          },
        ]),
      }
      expect(previewPeerOrigin(env)).toBeUndefined()
      expect(runtimeOrigin(env)).toBeUndefined()
    }
  )
  it.each([
    { VERCEL_ENV: "production" },
    { VERCEL_PROJECT_ID: "prj_unregistered" },
    { VERCEL_RELATED_PROJECTS: "invalid" },
    { VERCEL_RELATED_PROJECTS: related(PREVIEW.webProjectId) },
    {
      DATABASE_URL: base.DATABASE_URL.replace(
        PREVIEW.database.host,
        "production.example.com"
      ),
    },
    { DATABASE_URL: base.DATABASE_URL + "&host=production.example.com" },
    {
      DATABASE_URL: base.DATABASE_URL.replace(
        "forge_staging_web",
        "neondb_owner"
      ),
    },
    { BLOB_STORE_ID: "store_production" },
    { OPENAI_API_KEY: "secret" },
    { FORGE_BILLING_ENABLED: "true" },
    { FORGE_CALLS_ENABLED: "true" },
    { EVE_EVAL_FIXTURE_MODE: "true" },
    { BETTER_AUTH_URL: "https://app.forgenow.tech" },
    { EVE_AGENT_RUNTIME_URL: "https://production.vercel.app" },
    { FORGE_ENVIRONMENT: "production" },
  ])("rejects mixed resources without disclosing values: %j", (override) => {
    expect(() =>
      assertStagingEnvironment({ ...base, ...override }, "web")
    ).toThrow("Values are redacted")
  })
  it("keeps production and local resolution unchanged", () => {
    expect(
      runtimeOrigin({ EVE_AGENT_RUNTIME_URL: "https://prod.example" })
    ).toBe("https://prod.example")
    expect(appOrigin({ FORGE_APP_ORIGIN: "http://localhost:3000" })).toBe(
      "http://localhost:3000"
    )
    expect(() =>
      assertStagingEnvironment(
        { VERCEL_PROJECT_ID: PREVIEW.webProjectId, VERCEL_ENV: "production" },
        "web"
      )
    ).not.toThrow()
    expect(() =>
      assertStagingEnvironment(
        { VERCEL_PROJECT_ID: PREVIEW.runtimeProjectId },
        "runtime"
      )
    ).toThrow()
  })
  it.each([PREVIEW.webProjectId, PREVIEW.runtimeProjectId])(
    "sends OIDC only to the matching Preview peer from %s",
    async (project) => {
      const peer =
        project === PREVIEW.webProjectId
          ? PREVIEW.runtimeProjectId
          : PREVIEW.webProjectId
      for (const [key, value] of Object.entries({
        ...base,
        VERCEL_PROJECT_ID: project,
        VERCEL_RELATED_PROJECTS: related(peer),
      }))
        vi.stubEnv(key, value)
      const token = [
        Buffer.from('{"alg":"RS256"}').toString("base64url"),
        Buffer.from(
          JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
        ).toString("base64url"),
        "fixture",
      ].join(".")
      vi.stubEnv("VERCEL_OIDC_TOKEN", token)
      const fetcher = vi.fn().mockResolvedValue(new Response("ok"))
      await fetchWithStagingIdentity(
        new Request(`${previewPeerOrigin(process.env)}/test`, {
          headers: { authorization: "Bearer run-bound" },
        }),
        {},
        fetcher
      )
      expect(fetcher.mock.calls[0][1].headers.get("authorization")).toBe(
        "Bearer run-bound"
      )
      expect(
        fetcher.mock.calls[0][1].headers.get("x-vercel-trusted-oidc-idp-token")
      ).toBe(token)
      expect(fetcher.mock.calls[0][1].redirect).toBe("error")
      await expect(
        fetchWithStagingIdentity("https://app.forgenow.tech/test", {}, fetcher)
      ).rejects.toThrow("origin")
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )
})

import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { handleProductionEnvironmentCheck } from "./production-environment-check.js"

const token = "a".repeat(43)
const now = Date.parse("2026-10-29T20:00:00Z")
const env = {
  FORGE_ENVIRONMENT: "production",
  FORGE_APP_ORIGIN: "https://app.example.test",
  FORGE_AGENT_CHANNEL_SECRET: "private-channel-secret-".repeat(3),
  FORGE_ENVIRONMENT_CHECK_TOKEN_SHA256: createHash("sha256")
    .update(token)
    .digest("hex"),
  FORGE_ENVIRONMENT_CHECK_EXPIRES_AT: "2026-10-29T20:30:00Z",
  VERCEL_DEPLOYMENT_ID: "dpl_test",
  FORGE_SOURCE_REVISION: "source-revision",
}
function request(secret = token, expected = env.FORGE_APP_ORIGIN) {
  return new Request("https://runtime.example.test/internal/environment", {
    headers: {
      authorization: `Bearer ${secret}`,
      "x-environment-check-challenge": "b".repeat(32),
      "x-forge-expected-app-origin": expected,
    },
  })
}

describe("bounded production runtime configuration check", () => {
  it.each([
    {},
    { ...env, FORGE_ENVIRONMENT_CHECK_EXPIRES_AT: new Date(now).toISOString() },
    { ...env, FORGE_ENVIRONMENT_CHECK_TOKEN_SHA256: "c".repeat(64) },
  ])(
    "denies absent, expired or wrong authority before any callback",
    async (configuration) => {
      const fetcher = vi.fn()
      const response = await handleProductionEnvironmentCheck(
        request(),
        configuration,
        fetcher,
        now
      )
      expect(response.status).toBe(404)
      expect(await response.text()).toBe("")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it("checks the captured origin and calls only the anonymous web session endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(null))
    const response = await handleProductionEnvironmentCheck(
      request(),
      env,
      fetcher,
      now
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      challenge: "b".repeat(32),
      deployment: { id: "dpl_test", sourceRevision: "source-revision" },
      configuration: {
        ready: true,
        environment: "production",
        service: "runtime",
      },
      callback: { originMatchesExpected: true, reachable: true, status: 200 },
    })
    const [url, options] = fetcher.mock.calls[0]!
    expect(url.href).toBe("https://app.example.test/api/auth/get-session")
    expect(options.redirect).toBe("manual")
    expect(new Headers(options.headers).has("authorization")).toBe(false)
    expect(new Headers(options.headers).has("cookie")).toBe(false)
    expect(JSON.stringify(body)).not.toContain(env.FORGE_APP_ORIGIN)
    expect(JSON.stringify(body)).not.toContain(env.FORGE_AGENT_CHANNEL_SECRET)
    expect(JSON.stringify(body)).not.toContain(token)
  })

  it("reports a mismatch without requesting or exposing the unexpected destination", async () => {
    const fetcher = vi.fn()
    const response = await handleProductionEnvironmentCheck(
      request(),
      { ...env, FORGE_APP_ORIGIN: "https://unexpected.example.test" },
      fetcher,
      now
    )
    const body = await response.json()
    expect(body.callback).toEqual({
      originMatchesExpected: false,
      reachable: false,
      status: null,
    })
    expect(JSON.stringify(body)).not.toContain("unexpected.example.test")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    new Response(null, {
      status: 302,
      headers: { location: "https://unexpected.example.test" },
    }),
    new Response("login page", { status: 200 }),
    Response.json({ user: "must-not-be-returned" }),
  ])(
    "does not accept redirects, login pages or an unexpected response as a verified callback",
    async (callback) => {
      const response = await handleProductionEnvironmentCheck(
        request(),
        env,
        vi.fn().mockResolvedValue(callback),
        now
      )
      const body = await response.json()
      expect(body.callback.originMatchesExpected).toBe(true)
      expect(body.callback.reachable).toBe(false)
      expect(JSON.stringify(body)).not.toContain("must-not-be-returned")
    }
  )

  it.each([
    { ...env, FORGE_APP_ORIGIN: "invalid-private-origin" },
    { ...env, EVE_EVAL_FIXTURE_MODE: "true" },
    { ...env, FORGE_ENVIRONMENT: "development" },
  ])(
    "redacts invalid configuration before callback work",
    async (configuration) => {
      const fetcher = vi.fn()
      const response = await handleProductionEnvironmentCheck(
        request(),
        configuration,
        fetcher,
        now
      )
      expect(response.status).toBe(503)
      expect(await response.text()).toBe('{"error":"Environment check failed"}')
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it("redacts provider/network errors", async () => {
    const response = await handleProductionEnvironmentCheck(
      request(),
      env,
      vi.fn().mockRejectedValue(new Error("private network credential")),
      now
    )
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('{"error":"Environment check failed"}')
  })
})

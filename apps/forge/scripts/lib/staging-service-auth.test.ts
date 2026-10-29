// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { STAGING } from "../../../../packages/environment/staging-environment"
import { fetchWithStagingIdentity } from "../../../../packages/environment/staging-service-auth"

describe("staging peer identity", () => {
  afterEach(() => vi.unstubAllEnvs())
  it.each([
    [STAGING.webProjectId, STAGING.runtimeOrigin],
    [STAGING.runtimeProjectId, STAGING.webOrigin],
  ])("uses identity from %s only for its peer", async (project, origin) => {
    const token = [Buffer.from(JSON.stringify({alg:"RS256"})).toString("base64url"),Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString("base64url"),"fixture-signature"].join(".")
    vi.stubEnv("VERCEL_OIDC_TOKEN", token)
    vi.stubEnv("FORGE_ENVIRONMENT", "staging")
    vi.stubEnv("VERCEL_PROJECT_ID", project)
    const fetcher = vi.fn().mockResolvedValue(new Response("ok"))
    await fetchWithStagingIdentity(
      `${origin}/test`,
      { headers: { authorization: "Bearer forge-session" } },
      fetcher
    )
    expect(fetcher.mock.calls[0][1].headers.get("authorization")).toBe(
      "Bearer forge-session"
    )
    expect(
      fetcher.mock.calls[0][1].headers.get("x-vercel-trusted-oidc-idp-token")
    ).toBe(token)
    expect(fetcher.mock.calls[0][1].redirect).toBe("error")
    await expect(
      fetchWithStagingIdentity(
        "https://forge-app-mauve.vercel.app/test",
        {},
        fetcher
      )
    ).rejects.toThrow("origin")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

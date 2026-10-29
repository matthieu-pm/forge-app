import { handleEnvironmentCheck } from "../../../packages/environment/operator-check.js"
import { assertServiceConfiguration } from "../../../packages/environment/service-config.js"
import type { ServiceEnvironment } from "../../../packages/environment/service-config.js"

/** A bounded operator check. It never returns the configured origin or credentials. */
export function handleProductionEnvironmentCheck(
  request: Request,
  env: ServiceEnvironment = process.env,
  fetcher: typeof fetch = fetch,
  now = Date.now()
) {
  return handleEnvironmentCheck(
    request,
    {
      tokenSha256: env.FORGE_ENVIRONMENT_CHECK_TOKEN_SHA256,
      expiresAt: env.FORGE_ENVIRONMENT_CHECK_EXPIRES_AT,
    },
    async (challenge) => {
      const configuration = assertServiceConfiguration(env, "runtime")
      if (configuration.environment !== "production")
        throw new Error("This operator check requires a production runtime.")

      const expected = request.headers.get("x-forge-expected-app-origin") ?? ""
      const expectedUrl = new URL(expected)
      if (
        expectedUrl.protocol !== "https:" ||
        expectedUrl.origin !== expected ||
        expectedUrl.username ||
        expectedUrl.password
      )
        throw new Error("The expected callback origin is invalid.")

      const origin = new URL(env.FORGE_APP_ORIGIN!)
      const originMatchesExpected = origin.origin === expected
      let status: number | null = null
      let reachable = false
      // A mismatch never triggers a request to the unexpected destination.
      if (originMatchesExpected) {
        const response = await fetcher(
          new URL("/api/auth/get-session", origin),
          {
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
            headers: { "cache-control": "no-store" },
          }
        )
        status = response.status
        if (
          response.status === 200 &&
          response.headers.get("content-type")?.includes("application/json")
        ) {
          // No cookie or credentials are sent. Do not expose any response payload.
          reachable = (await response.text()).trim() === "null"
        }
      }
      return {
        challenge,
        deployment: {
          id: env.VERCEL_DEPLOYMENT_ID ?? null,
          sourceRevision: env.FORGE_SOURCE_REVISION ?? null,
        },
        configuration,
        callback: { originMatchesExpected, reachable, status },
      }
    },
    now
  )
}

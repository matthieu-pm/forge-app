import { defineChannel, GET } from "eve/channels"
import { handleEnvironmentCheck } from "../../../../packages/environment/operator-check.js"
import {
  assertStagingEnvironment,
  STAGING,
} from "../../../../packages/environment/staging-environment.js"
import { stagingServiceFetch } from "../../../../packages/environment/staging-service-auth.js"

export default defineChannel({
  routes: [
    GET("/internal/environment", async (request) => {
      if (process.env.FORGE_ENVIRONMENT !== "staging")
        return new Response(null, { status: 404 })
      return await handleEnvironmentCheck(
        request,
        {
          tokenSha256: process.env.FORGE_ENVIRONMENT_CHECK_TOKEN_SHA256,
          expiresAt: process.env.FORGE_ENVIRONMENT_CHECK_EXPIRES_AT,
        },
        async (challenge) => {
          assertStagingEnvironment(process.env, "runtime")
          const response = await stagingServiceFetch(
            new URL("/api/internal/environment", STAGING.webOrigin),
            {
              headers: {
                authorization: request.headers.get("authorization")!,
                "x-environment-check-challenge": challenge,
              },
              signal: AbortSignal.timeout(15_000),
            }
          )
          if (
            !response.ok ||
            !response.headers.get("content-type")?.includes("application/json")
          )
            throw new Error("Staging callback check failed.")
          const callback = (await response.json()) as {
            database?: {
              challenge?: string
              branch?: string
              database?: string
            }
          }
          if (
            callback.database?.challenge !== challenge ||
            callback.database.branch !== STAGING.database.branchId ||
            callback.database.database !== STAGING.database.database
          )
            throw new Error("Staging callback identity mismatch.")
          return {
            deployment: {
              id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
              sourceRevision: process.env.FORGE_SOURCE_REVISION ?? null,
            },
            callback,
          }
        }
      )
    }),
  ],
})

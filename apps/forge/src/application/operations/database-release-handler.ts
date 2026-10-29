import { handleEnvironmentCheck } from "../../../../../packages/environment/operator-check"
import { STAGING } from "../../../../../packages/environment/staging-environment"
import { rehearsalSchema } from "./database-release-rehearsal"
import type { RehearsalVersion } from "./database-release-rehearsal"

/** Staging-only, expiring, run-bound operator access; disabled without all settings. */
export async function handleDatabaseReleaseRehearsal(
  request: Request,
  env: Record<string, string | undefined>,
  use: (
    runId: string,
    version: RehearsalVersion,
    input: { id: number; value?: string }
  ) => Promise<unknown>,
  now = Date.now()
) {
  const version = env.FORGE_DB_REHEARSAL_VERSION
  const runId = env.FORGE_DB_REHEARSAL_RUN_ID ?? ""
  const expiry = Date.parse(env.FORGE_DB_REHEARSAL_EXPIRES_AT ?? "")
  let validRun = false
  try {
    rehearsalSchema(runId)
    validRun = true
  } catch {
    /* fail closed */
  }
  if (
    env.FORGE_ENVIRONMENT !== "staging" ||
    env.VERCEL_PROJECT_ID !== STAGING.webProjectId ||
    !validRun ||
    !["old", "bridge", "new"].includes(version ?? "") ||
    expiry > now + 2 * 60 * 60 * 1000
  )
    return new Response(null, {
      status: 404,
      headers: { "cache-control": "no-store" },
    })
  return handleEnvironmentCheck(
    request,
    {
      tokenSha256: env.FORGE_DB_REHEARSAL_TOKEN_SHA256,
      expiresAt: env.FORGE_DB_REHEARSAL_EXPIRES_AT,
    },
    async (challenge) => {
      const url = new URL(request.url)
      const id = Number(url.searchParams.get("id"))
      const value = url.searchParams.get("value") ?? undefined
      if (
        !["GET", "POST"].includes(request.method) ||
        (request.method === "GET" && value !== undefined)
      )
        throw new Error("Invalid rehearsal method.")
      return {
        challenge,
        sourceRevision: env.FORGE_SOURCE_REVISION,
        deploymentId: env.VERCEL_DEPLOYMENT_ID,
        runId,
        result: await use(runId, version as RehearsalVersion, { id, value }),
      }
    },
    now
  )
}

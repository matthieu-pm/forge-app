import "@tanstack/react-start/server-only"

import { sql } from "drizzle-orm"
import { inspectFileStorage } from "../../../../../packages/environment/file-storage"
import { STAGING } from "../../../../../packages/environment/staging-environment"
import { stagingServiceFetch } from "../../../../../packages/environment/staging-service-auth"

import { db } from "@/db"

export async function readEnvironmentIdentity(challenge: string) {
  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`SET TRANSACTION READ ONLY`)
    await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`)
    return transaction.execute(sql`
      SELECT ${challenge}::text AS challenge,
             current_database() AS database,
             current_setting('neon.branch_id', true) AS branch,
             current_setting('server_version') AS postgres_version,
             current_setting('transaction_read_only') AS transaction_read_only,
             (SELECT count(*)::integer FROM drizzle.__drizzle_migrations) AS migration_count,
             (SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC, id DESC LIMIT 1) AS migration_hash
    `)
  })
  let stagingRuntime: unknown = null
  if (process.env.FORGE_ENVIRONMENT === "staging") {
    const response = await stagingServiceFetch(
      new URL("/eve/v1/health", STAGING.runtimeOrigin),
      { signal: AbortSignal.timeout(10_000) }
    )
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    )
      throw new Error("Staging runtime health failed.")
    const health = (await response.json()) as { ok?: boolean; status?: string }
    if (health.ok !== true || health.status !== "ready")
      throw new Error("Staging runtime is not ready.")
    stagingRuntime = { origin: STAGING.runtimeOrigin, health }
  }
  const databaseUrl = new URL(process.env.DATABASE_URL!)
  return {
    checkedAt: new Date().toISOString(),
    deployment: {
      id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      url: process.env.VERCEL_URL ?? null,
      region: process.env.VERCEL_REGION ?? null,
      environment: process.env.VERCEL_ENV ?? null,
      gitCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      sourceRevision: process.env.FORGE_SOURCE_REVISION ?? null,
    },
    database: { host: databaseUrl.hostname, ...result.rows[0] },
    stagingRuntime,
    runtimeOrigin: process.env.EVE_AGENT_RUNTIME_URL
      ? new URL(process.env.EVE_AGENT_RUNTIME_URL).origin
      : null,
    // Report the selected adapter without exposing its credentials.
    artifacts: {
      adapter:
        inspectFileStorage(process.env).adapter === "vercel-private"
          ? "vercel-private"
          : "local-filesystem",
      directoryConfigured: Boolean(process.env.FORGE_AGENT_ARTIFACT_DIRECTORY),
      durableBucket:
        inspectFileStorage(process.env).adapter === "vercel-private"
          ? (process.env.BLOB_STORE_ID ?? null)
          : null,
    },
  }
}

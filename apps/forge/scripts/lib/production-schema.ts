import { neon } from "@neondatabase/serverless"
import { schemaIsReady } from "../../src/application/operations/readiness-schema"
import type { MonitorSql } from "../../src/application/operations/monitor-store"

const blocked =
  "Production schema preflight blocked promotion. Apply the approved migrations for this source through the guarded release process, then retry."

function connectSql(connection: string): MonitorSql {
  const query = neon(connection, { fullResults: true })
  return {
    query: (text, values) =>
      query.query(text, values, {
        fetchOptions: { signal: AbortSignal.timeout(4_000) },
      }),
  }
}

export async function verifyProductionSchema(
  env: NodeJS.ProcessEnv,
  connect: (connection: string) => MonitorSql = connectSql
) {
  if (env.VERCEL_ENV !== "production") return false
  const connection = env.DATABASE_URL
  if (!connection) throw new Error(blocked)
  const ready = await Promise.resolve()
    .then(() => schemaIsReady(connect(connection)))
    .catch(() => false)
  if (!ready) throw new Error(blocked)
  return true
}

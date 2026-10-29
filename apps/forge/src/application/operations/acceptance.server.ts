import "@tanstack/react-start/server-only"
import { Pool } from "@neondatabase/serverless"
import {
  STAGING,
  assertStagingEnvironment,
} from "../../../../../packages/environment/staging-environment"
import { stagingServiceFetch } from "../../../../../packages/environment/staging-service-auth"
import { healthCheckSchema } from "../../../../../packages/telemetry/health-acceptance"
import {
  healthResponse,
  readinessCode,
} from "../../../../../packages/telemetry/health"
import { schemaIsReady } from "./readiness-schema"
import { monitorStore } from "./monitor-store"
import { evaluateMonitor } from "./monitor"
import { dispatchFindings } from "./monitor-runner"

export async function runOperationsAcceptance(
  request: Request,
  challenge: string
) {
  assertStagingEnvironment(process.env, "web")
  const schema = healthCheckSchema(process.env)
  const { databaseClient } = await import("@/db")
  const sql = {
    query: (text: string, values?: Array<unknown>) =>
      databaseClient.query(
        text
          .replaceAll(
            "operational_job_health",
            `${schema}.operational_job_health`
          )
          .replaceAll(
            "operational_alert_deliveries",
            `${schema}.operational_alert_deliveries`
          )
          .replaceAll(
            "drizzle.__drizzle_migrations",
            `${schema}.__drizzle_migrations`
          ),
        values
      ),
  }
  const checks = {
    configuration: async () => true,
    database: async () => {
      await sql.query("SELECT 1")
      return true
    },
    schema: () => schemaIsReady(sql),
  }
  const missing = healthResponse(await readinessCode(checks))
  const disconnected = new Pool({ connectionString: process.env.DATABASE_URL })
  await disconnected.end()
  const unavailable = healthResponse(
    await readinessCode({
      ...checks,
      database: async () => {
        await disconnected.query("SELECT 1")
        return true
      },
    })
  )
  const store = monitorStore(sql)
  const findings = evaluateMonitor({
    now: Date.now(),
    jobs: ["agent.retention"],
    heartbeats: await store.heartbeats(),
    samples: [],
    requiredSignals: [],
  })
  if (
    findings.length !== 1 ||
    findings[0].code !== "SWEEP_STALE" ||
    findings[0].severity !== "page"
  )
    throw new Error("Stale job fixture is not ready.")
  // The same production dispatcher sends the alert through a real HTTP request to
  // the protected runtime's synthetic operator inbox. Token lives only in memory.
  const token = request.headers.get("authorization")!.slice(7)
  const env = {
    ...process.env,
    FORGE_OPERATIONS_WEBHOOK_URL: new URL(
      "/internal/operations-inbox",
      STAGING.runtimeOrigin
    ).toString(),
    FORGE_OPERATIONS_WEBHOOK_TOKEN: token,
  }
  const fetcher: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set("x-environment-check-challenge", challenge)
    return stagingServiceFetch(input, { ...init, headers })
  }
  const delivery = await dispatchFindings(findings, store, env, fetcher)
  const retry = await dispatchFindings(findings, store, env, fetcher)
  const receipts = await sql.query(
    "SELECT id,delivered_at FROM operational_alert_deliveries WHERE delivered_at IS NOT NULL"
  )
  return {
    challenge,
    sourceRevision: process.env.FORGE_SOURCE_REVISION,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
    schemaMissing: { httpStatus: missing.status, ...(await missing.json()) },
    databaseUnavailable: {
      httpStatus: unavailable.status,
      ...(await unavailable.json()),
    },
    delivery,
    retry,
    receipts: receipts.rows.map((row) => ({
      id: row.id,
      deliveredAt: row.delivered_at,
    })),
  }
}

// @vitest-environment node
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { once } from "node:events"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import {
  healthResponse,
  readinessCode,
} from "../../../../../packages/telemetry/health"
import { monitorStore } from "./monitor-store"
import { dispatchFindings } from "./monitor-runner"
import { RUNBOOK_URL, evaluateMonitor } from "./monitor"
import { schemaIsReady } from "./readiness-schema"
import manifest from "./migrations.generated.json"
import type { PoolClient } from "@neondatabase/serverless"
import type { AlertEnvelope } from "./monitor"

const file = process.env.FORGE_OPERATIONS_TEST_DATABASE_FILE
describe.skipIf(!file)(
  "isolated PostgreSQL readiness and operator delivery",
  () => {
    let pool: Pool
    let client: PoolClient
    let other: PoolClient
    const namespace = `for30_${randomUUID().replaceAll("-", "")}`
    let ownsSchema = false
    beforeAll(async () => {
      const { connection } = JSON.parse(readFileSync(file!, "utf8"))
      const target = {
        environment: "staging" as const,
        ...DATABASE_TARGETS.staging,
      }
      assertMigrationTarget(connection, target)
      neonConfig.webSocketConstructor = WebSocket
      // Match the web's HTTP shortcut: pool lifecycle does not stop Pool.query().
      neonConfig.poolQueryViaFetch = true
      pool = new Pool({
        connectionString: connection,
        max: 2,
        connectionTimeoutMillis: 10_000,
      })
      client = await pool.connect()
      const identity = await client.query(
        "SELECT current_database() AS database,current_setting('neon.branch_id',true) AS branch"
      )
      expect(identity.rows[0]).toEqual({
        database: target.database,
        branch: target.branchId,
      })
      await client.query(`CREATE SCHEMA ${namespace}`)
      ownsSchema = true
      await client.query(`SET search_path TO ${namespace},public`)
      await client.query("SET statement_timeout='5s'")
      // Rehearse this feature's DDL, not an unrelated future migration.
      const migration = readFileSync("drizzle/0039_absent_blade.sql", "utf8")
      for (const statement of migration.split("--> statement-breakpoint"))
        if (statement.trim()) await client.query(statement)
      await client.query(
        `CREATE TABLE ${namespace}.__drizzle_migrations(id serial,hash text,created_at bigint)`
      )
      await client.query(
        `CREATE TABLE ${namespace}.business_workflow_runs(created_at timestamptz DEFAULT now(),state text,workspace_id text)`
      )
      await client.query(
        `CREATE TABLE ${namespace}.business_workflow_effects(created_at timestamptz DEFAULT now(),state text,effect_key text)`
      )
      await client.query(
        `CREATE TABLE ${namespace}.call_connections(sync_lease_at timestamptz)`
      )
      await client.query(
        `CREATE TABLE ${namespace}.calls(summary_lease_at timestamptz)`
      )
      other = await pool.connect()
      await other.query(`SET search_path TO ${namespace},public`)
      await other.query("SET statement_timeout='5s'")
    }, 30_000)
    afterAll(async () => {
      if (client && ownsSchema)
        await client.query(`DROP SCHEMA ${namespace} CASCADE`)
      client?.release()
      other?.release()
      await pool?.end()
    })

    it("AC-01: actual missing schema produces HTTP 503, then exact journal receipts restore readiness", async () => {
      const sql = {
        query: (statement: string) =>
          client.query(
            statement.replace(
              "drizzle.__drizzle_migrations",
              `${namespace}.__drizzle_migrations`
            )
          ),
      }
      const checks = {
        configuration: async () => true,
        database: async () => {
          await client.query("SELECT 1")
          return true
        },
        schema: () => schemaIsReady(sql),
      }
      let response = healthResponse(await readinessCode(checks))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        status: "unhealthy",
        code: "SCHEMA_NOT_READY",
      })
      for (const row of manifest)
        await client.query(
          `INSERT INTO ${namespace}.__drizzle_migrations(hash,created_at) VALUES($1,$2)`,
          [row.hash, row.createdAt]
        )
      response = healthResponse(await readinessCode(checks))
      expect(response.status).toBe(200)
      await client.query(
        `DELETE FROM ${namespace}.__drizzle_migrations WHERE created_at=$1`,
        [manifest.at(-1)!.createdAt]
      )
      expect(await readinessCode(checks)).toBe("SCHEMA_NOT_READY")
    }, 30_000)

    it("records successful completions but preserves their age when a job fails", async () => {
      const store = monitorStore(client)
      await store.heartbeat("agent.retention", true)
      const completed = (await store.heartbeats())[0].completedAt
      await store.heartbeat("agent.retention", false)
      expect((await store.heartbeats())[0]).toMatchObject({
        completedAt: completed,
      })

      expect((await store.heartbeats())[0].failedAt).toBeGreaterThanOrEqual(
        completed!
      )
    })

    it("collects real bounded metrics and resets sustained backlog evidence after recovery or a sampling gap", async () => {
      const store = monitorStore(client)
      await client.query(
        "INSERT INTO business_workflow_runs(state) SELECT 'queued' FROM generate_series(1,8000)"
      )
      let samples = await store.samples(Date.now())
      expect(samples.find((row) => row.key === "backlog")).toMatchObject({
        value: 0.8,
      })
      expect(
        samples.find((row) => row.key === "backlog")!.highSince
      ).not.toBeNull()
      expect(
        samples.find((row) => row.key === "database-slots")!.value
      ).toBeGreaterThanOrEqual(0)
      await client.query(
        "UPDATE operational_metric_health SET observed_at=clock_timestamp()-interval '121 seconds', high_since=clock_timestamp()-interval '1 hour' WHERE key='backlog'"
      )
      samples = await store.samples(Date.now())
      expect(
        samples.find((row) => row.key === "backlog")!.highSince
      ).toBeGreaterThan(Date.now() - 10_000)
      await client.query("DELETE FROM business_workflow_runs")
      samples = await store.samples(Date.now())
      expect(samples.find((row) => row.key === "backlog")).toMatchObject({
        value: 0,
        highSince: null,
      })
    }, 15_000)
    it("AC-02: a stale scheduled job reaches an HTTP operator inbox once under concurrent monitors", async () => {
      await client.query(
        "UPDATE operational_job_health SET completed_at=clock_timestamp()-interval '61 minutes',failed_at=NULL WHERE key='agent.retention'"
      )
      const store = monitorStore(client),
        second = monitorStore(other)
      const findings = evaluateMonitor({
        now: Date.now(),
        jobs: ["agent.retention"],
        heartbeats: await store.heartbeats(),
        samples: [],
        requiredSignals: [],
      })
      expect(findings[0]).toMatchObject({
        code: "SWEEP_STALE",
        severity: "page",
      })
      const inbox: Array<AlertEnvelope> = []
      const server = createServer(async (request, response) => {
        let body = ""
        for await (const chunk of request) body += chunk
        const envelope = JSON.parse(body)
        expect(request.headers.authorization).toBe(`Bearer ${"t".repeat(43)}`)
        expect(request.headers["idempotency-key"]).toBe(envelope.id)
        inbox.push(envelope)
        response.writeHead(204)
        response.end()
      })
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      try {
        const address = server.address() as { port: number }
        const env = {
          FORGE_ENVIRONMENT: "development",
          FORGE_OPERATIONS_WEBHOOK_URL: `http://127.0.0.1:${address.port}/operator-inbox`,
          FORGE_OPERATIONS_WEBHOOK_TOKEN: "t".repeat(43),
        }
        const results = await Promise.all([
          dispatchFindings(findings, store, env),
          dispatchFindings(findings, second, env),
        ])
        expect(results.reduce((sum, row) => sum + row.delivered, 0)).toBe(1)
        expect(results.reduce((sum, row) => sum + row.suppressed, 0)).toBe(1)
        expect(inbox).toHaveLength(1)
        expect(inbox[0]).toMatchObject({
          code: "SWEEP_STALE",
          severity: "page",
          runbookUrl: RUNBOOK_URL,
        })
        const receipt = await client.query(
          "SELECT delivered_at FROM operational_alert_deliveries WHERE id=$1",
          [inbox[0].id]
        )
        expect(receipt.rows[0].delivered_at).not.toBeNull()
        expect((await dispatchFindings(findings, store, env)).suppressed).toBe(
          1
        )
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }, 15_000)

    it("fences an expired delivery owner and lets a new owner retry the same event", async () => {
      const alert = { id: "f".repeat(64) } as AlertEnvelope
      const store = monitorStore(client),
        second = monitorStore(other)
      const first = await store.claim(alert)
      expect(first).not.toBeNull()
      expect(await second.claim(alert)).toBeNull()
      await client.query(
        "UPDATE operational_alert_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [alert.id]
      )
      const next = await second.claim(alert)
      expect(next).not.toBeNull()
      await expect(store.acknowledge(alert.id, first!)).rejects.toThrow(
        "ownership changed"
      )
      await second.acknowledge(alert.id, next!)
      expect(await store.claim(alert)).toBeNull()
    })

    it("AC-01: actual disconnected SQL client yields only a safe database failure", async () => {
      other.release()
      other = undefined as unknown as PoolClient
      const disconnected = await pool.connect()
      disconnected.release(true)
      // release(true) closes the owned connection; using it cannot contact a DB.
      const code = await readinessCode({
        configuration: async () => true,
        database: async () => {
          await disconnected.query("SELECT 1")
          return true
        },
        schema: async () => true,
      })
      expect(code).toBe("DATABASE_UNAVAILABLE")
      const response = healthResponse(code)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        status: "unhealthy",
        code: "DATABASE_UNAVAILABLE",
      })
    })
  }
)

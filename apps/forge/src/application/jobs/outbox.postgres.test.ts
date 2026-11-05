// @vitest-environment node
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { readFileSync, readdirSync } from "node:fs"
import { createServer } from "node:http"
import { Pool } from "pg"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import { fixtureConsumer } from "../../../scripts/fixtures/outbox-provider"
import { dispatchFindings, runMonitor } from "../operations/monitor-runner"
import { monitorStore } from "../operations/monitor-store"
import { jobCommand } from "./job-cli"
import { jobStore } from "./job-store"
import { runNextJob } from "./job-runner"
import {
  outboxDelivery,
  outboxKind,
  runOutbox,
  scheduleOutbox,
} from "./outbox-delivery"
import type { OutboxConsumer } from "./outbox-delivery"
import type { Server } from "node:http"

const connection = process.env.FORGE_OUTBOX_TEST_DATABASE_URL

// FOR-33: opt-in integration suite refuses every target except its dedicated local fixture.
describe.skipIf(!connection)(
  "FOR-33 recoverable outbox PostgreSQL acceptance",
  () => {
    let pool: Pool
    let store: ReturnType<typeof jobStore>
    let server: Server
    let origin: string
    let workspace: string
    let consumer: OutboxConsumer
    let providerPosts = 0
    let providerLookups = 0
    let providerFails = false
    let lookupUnknown = false
    let openTransactions = 0
    const accepted = new Map<string, { reference: string }>()
    const alerts: Array<Record<string, unknown>> = []
    let alertFails = false
    const env = () => ({
      FORGE_ENVIRONMENT: "development",
      FORGE_OPERATIONS_WEBHOOK_URL: `${origin}/alerts`,
      FORGE_OPERATIONS_WEBHOOK_TOKEN: "x".repeat(43),
      FORGE_MONITOR_OUTBOX: "true",
    })
    const event = async (
      topic = consumer.topic,
      payload: unknown = { value: 1, private: "PRIVATE-PAYLOAD" }
    ) => {
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const command = (
          await client.query(
            `INSERT INTO command_receipts(workspace_id,user_id,principal,operation,command_key,input_hash,
          response_body,response_status,resource_type,resource_id,completed_at)
          VALUES($1,'fixture','fixture','fixture',$2,$3,'{}',200,'fixture',$2,clock_timestamp()) RETURNING id`,
            [workspace, randomUUID(), "a".repeat(64)]
          )
        ).rows[0].id
        await client.query(
          `INSERT INTO command_audit_events(workspace_id,command_id,actor_user_id,operation,resource_type,resource_id)
         SELECT workspace_id,id,user_id,operation,resource_type,resource_id FROM command_receipts WHERE id=$1`,
          [command]
        )
        const row = (
          await client.query(
            `INSERT INTO command_outbox_events(workspace_id,command_id,ordinal,topic,payload)
         VALUES($1,$2,0,$3,$4::jsonb) RETURNING id`,
            [workspace, command, topic, JSON.stringify(payload)]
          )
        ).rows[0]
        await client.query("COMMIT")
        return row.id as string
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }
    const schedule = () => scheduleOutbox(pool, store, [consumer])
    const run = (id?: string) =>
      runNextJob(
        store,
        outboxKind(consumer.id),
        outboxDelivery(pool, [consumer]),
        id
      )
    const due = (id: string) =>
      pool.query(
        "UPDATE background_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id]
      )
    const expire = async (id: string) => {
      await pool.query(
        "UPDATE background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id]
      )
      await store.reap(outboxKind(consumer.id), id)
      await due(id)
    }
    const replay = async (id: string) =>
      store.recover({
        jobId: id,
        generation: (await store.inspect(id)).jobs[0].generation,
        requestId: randomUUID(),
        operatorId: randomUUID(),
        reason: "provider-confirmed",
        action: "replay",
      })
    const resolveEffect = async (
      id: string,
      outcome: "completed" | "retry-safe"
    ) =>
      store.recover({
        jobId: id,
        generation: (await store.inspect(id)).jobs[0].generation,
        requestId: randomUUID(),
        operatorId: randomUUID(),
        reason: "provider-confirmed",
        action: "resolve",
        step: "deliver-v1",
        outcome,
        quiesced: true,
        evidence: "FOR-33-fixture",
      })

    beforeAll(async () => {
      const target = new URL(connection!)
      if (
        target.hostname !== "127.0.0.1" ||
        target.port !== "56433" ||
        target.pathname !== "/for33_outbox_test"
      )
        throw new Error("Dedicated local FOR-33 database required")
      pool = new Pool({
        connectionString: connection,
        max: 10,
        application_name: "for33-acceptance",
      })
      store = jobStore(pool)
      expect(
        (await pool.query("SELECT current_database() name")).rows[0].name
      ).toBe("for33_outbox_test")
      if (
        !(await pool.query("SELECT to_regclass('background_jobs') present"))
          .rows[0].present
      ) {
        for (const file of readdirSync("drizzle")
          .filter((f) => f.endsWith(".sql"))
          .sort())
          await pool.query(readFileSync(`drizzle/${file}`, "utf8"))
      }
      server = createServer(async (request, response) => {
        const respond = (status: number, body: unknown) => {
          response.writeHead(status, { "content-type": "application/json" })
          response.end(JSON.stringify(body))
        }
        if (request.url === "/alerts") {
          let raw = ""
          for await (const chunk of request) raw += chunk
          alerts.push(JSON.parse(raw))
          respond(alertFails ? 503 : 200, {})
          return
        }
        const key = request.url!.split("/").at(-1)!
        openTransactions += Number(
          (
            await pool.query(
              `SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='for33-acceptance'
         AND state='idle in transaction'`
            )
          ).rows[0].n
        )
        if (request.method === "GET") {
          providerLookups++
          respond(
            200,
            lookupUnknown
              ? { state: "unknown" }
              : accepted.has(key)
                ? { state: "accepted", receipt: accepted.get(key) }
                : { state: "absent" }
          )
        } else {
          providerPosts++
          let raw = ""
          for await (const chunk of request) raw += chunk
          expect(raw).not.toContain("PRIVATE-PAYLOAD")
          if (providerFails) {
            respond(503, {})
            return
          }
          const receipt = accepted.get(key) ?? {
            reference: `effect_${accepted.size + 1}`,
          }
          accepted.set(key, receipt)
          respond(200, receipt)
        }
      })
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    })
    beforeEach(async () => {
      workspace = `for33-${randomUUID()}`
      await pool.query(
        "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
        [workspace]
      )
      consumer = fixtureConsumer(origin)
      accepted.clear()
      alerts.length = 0
      providerPosts = 0
      providerLookups = 0
      openTransactions = 0
      providerFails = false
      lookupUnknown = false
      alertFails = false
    })
    afterEach(async () => {
      const ids = (
        await pool.query(
          "SELECT id FROM background_jobs WHERE input->>'workspaceId'=$1",
          [workspace]
        )
      ).rows.map((r) => r.id)
      await pool.query(
        "DELETE FROM background_job_steps WHERE job_id=ANY($1::uuid[])",
        [ids]
      )
      await pool.query(
        "DELETE FROM background_job_recoveries WHERE job_id=ANY($1::uuid[])",
        [ids]
      )
      await pool.query("DELETE FROM background_jobs WHERE id=ANY($1::uuid[])", [
        ids,
      ])
      await pool.query("DELETE FROM organization WHERE id=$1", [workspace])
      if (alerts.length)
        await pool.query(
          "DELETE FROM operational_alert_deliveries WHERE id=ANY($1::text[])",
          [alerts.map((a) => a.id)]
        )
      await pool.query(
        "DELETE FROM operational_metric_health WHERE key IN ('outbox-age','backlog','database-slots')"
      )
    })
    afterAll(async () => {
      if (server) {
        server.closeAllConnections()
        await new Promise<void>((r) => server.close(() => r()))
      }
      await pool?.end()
    })

    it("selects only committed matching events in bounded batches and deduplicates concurrent scheduling and consumers", async () => {
      await event("unregistered.v1")
      await event()
      await event()
      await event()
      const first = await scheduleOutbox(pool, store, [consumer], 1)
      expect(first).toHaveLength(1)
      await Promise.all(Array.from({ length: 5 }, schedule))
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM background_jobs WHERE input->>'workspaceId'=$1",
            [workspace]
          )
        ).rows[0].n
      ).toBe(3)
      const uncommitted = await pool.connect()
      try {
        await uncommitted.query("BEGIN")
        await uncommitted.query(
          `INSERT INTO command_outbox_events(workspace_id,command_id,ordinal,topic,payload)
           SELECT workspace_id,id,1,$2,'{"value":2}'::jsonb FROM command_receipts
           WHERE workspace_id=$1 LIMIT 1`,
          [workspace, consumer.topic]
        )
        expect(await schedule()).toEqual([])
      } finally {
        await uncommitted.query("ROLLBACK")
        uncommitted.release()
      }
      const second = { ...consumer, id: "second-v1" }
      expect(await scheduleOutbox(pool, store, [second])).toHaveLength(3)
      expect(
        await scheduleOutbox(pool, store, [
          { ...consumer, id: "future-v1", startsAt: new Date("2099-01-01") },
        ])
      ).toHaveLength(0)
      const jobs = await pool.query(
        "SELECT input FROM background_jobs WHERE input->>'workspaceId'=$1",
        [workspace]
      )
      expect(JSON.stringify(jobs.rows)).not.toContain("PRIVATE-PAYLOAD")
      expect(JSON.stringify(jobs.rows)).not.toContain('"payload"')
      await expect(
        scheduleOutbox(pool, store, [consumer], 101)
      ).rejects.toMatchObject({ code: "INVALID_INPUT" })
      expect((await runOutbox(pool, [consumer], 2)).outcomes).toHaveLength(2)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM background_jobs WHERE kind=$1 AND state='queued'",
            [outboxKind(second.id)]
          )
        ).rows[0].n
      ).toBe(3)
    })

    it("AT-01: kills a worker after provider acceptance, then reconciles after expiry without a second provider dispatch", async () => {
      const eventId = await event()
      const [id] = await schedule()
      const child = spawn(
        "bun",
        ["scripts/outbox-acceptance-worker.ts", id, origin, "after-acceptance"],
        {
          env: { ...process.env, FORGE_OUTBOX_TEST_DATABASE_URL: connection },
          stdio: ["ignore", "pipe", "pipe"],
        }
      )
      const exited = once(child, "exit")
      try {
        await new Promise<void>((resolve, reject) => {
          let output = ""
          const timer = setTimeout(
            () => reject(new Error("Fixture worker did not accept")),
            15_000
          )
          child.stdout.on("data", (data) => {
            output += data.toString()
            if (output.includes("accepted")) {
              clearTimeout(timer)
              resolve()
            }
          })
          child.once("exit", () => {
            clearTimeout(timer)
            reject(new Error("Worker exited before acceptance"))
          })
        })
      } finally {
        child.kill("SIGKILL")
        await exited
      }
      expect(providerPosts).toBe(1)
      expect((await store.inspect(id)).steps).toMatchObject([
        { key: "deliver-v1", state: "started" },
      ])
      await expire(id)
      expect(await run(id)).toMatchObject({ state: "completed" })
      expect(providerLookups).toBe(2)
      expect(providerPosts).toBe(1)
      expect(accepted.size).toBe(1)
      expect(openTransactions).toBe(0)
      expect(
        (
          await pool.query(
            "SELECT result FROM background_job_steps WHERE job_id=$1 AND key='provider-reference-v1'",
            [id]
          )
        ).rows[0].result
      ).toEqual({ reference: "effect_1" })
      expect(
        (
          await pool.query(
            "SELECT input->>'eventId' id FROM background_jobs WHERE id=$1",
            [id]
          )
        ).rows[0].id
      ).toBe(eventId)
      expect(await run(id)).toEqual({ state: "idle" })
    })

    it("AT-02: exhausts the retry budget, delivers an inspectable alert and continues unrelated work", async () => {
      await event()
      const [id] = await schedule()
      providerFails = true
      for (let n = 0; n < 5; n++) {
        expect(await run(id)).toMatchObject({
          state: n === 4 ? "dead" : "retry",
        })
        await due(id)
      }
      const inspection = await jobCommand(store, ["inspect", id])
      expect(inspection).toMatchObject({
        jobs: [{ state: "dead", attempts: 5, failure_code: "JOB_FAILED" }],
        recovery: [{ command: expect.stringContaining(id) }],
      })
      expect(JSON.stringify(inspection)).not.toMatch(
        /PRIVATE-|lease_token|idempotencyKey/
      )
      providerFails = false
      await event()
      expect((await runOutbox(pool, [consumer])).outcomes).toMatchObject([
        { state: "completed" },
      ])
      const monitor = monitorStore(pool)
      const health = await monitor.outboxHealth(Date.now())
      expect(health.findings).toMatchObject([{ code: "OUTBOX_DEAD", value: 1 }])
      alertFails = true
      expect(
        await dispatchFindings(health.findings, monitor, env())
      ).toMatchObject({ failed: 1 })
      alertFails = false
      expect(
        await dispatchFindings(health.findings, monitor, env())
      ).toMatchObject({ delivered: 1 })
      expect(
        await dispatchFindings(health.findings, monitor, env())
      ).toMatchObject({ suppressed: 1 })
      expect(alerts).toHaveLength(2)
      expect(alerts[0]).toMatchObject({
        code: "OUTBOX_DEAD",
        signal: "outbox.dead",
        severity: "page",
        runbookUrl: expect.stringContaining("readiness-and-alerts"),
      })
      expect(JSON.stringify(alerts)).not.toMatch(
        /PRIVATE-|workspaceId|payload|idempotencyKey/
      )
      await expect(replay(id)).rejects.toMatchObject({
        code: "RECONCILIATION_REQUIRED",
      })
      await resolveEffect(id, "retry-safe")
      await replay(id)
      expect(await run(id)).toMatchObject({ state: "completed" })
      expect(accepted.size).toBe(2)
      expect((await store.inspect(id)).jobs[0].total_attempts).toBe(6)
    })

    it("stops ambiguous lookup and non-idempotent expired ownership for operator reconciliation", async () => {
      await event()
      const [id] = await schedule()
      lookupUnknown = true
      expect(await run(id)).toMatchObject({ state: "reconcile" })
      expect(providerPosts).toBe(0)
      expect(
        (await monitorStore(pool).outboxHealth(Date.now())).findings
      ).toMatchObject([{ code: "OUTBOX_RECONCILIATION_REQUIRED" }])
      await resolveEffect(id, "completed")
      await replay(id)
      expect(await run(id)).toMatchObject({ state: "completed" })
      expect(providerPosts).toBe(0)
      consumer = {
        ...consumer,
        id: "nonidempotent-v1",
        policy: { mode: "reconcile" },
      }
      const [other] = await schedule()
      const lease = (await store.claim(outboxKind(consumer.id), other))!
      await expect(
        store.externalStep(lease, "deliver-v1", { mode: "reconcile" }, () =>
          Promise.reject(new Error("uncertain"))
        )
      ).rejects.toThrow()
      await expire(other)
      expect((await store.inspect(other)).jobs[0].state).toBe("reconcile")
      expect(await run(other)).toEqual({ state: "idle" })
    })

    it("enforces stored provider deadline, schema version and stale-owner fencing before sending", async () => {
      await event()
      const [id] = await schedule()
      const lease = (await store.claim(outboxKind(consumer.id), id))!
      await expect(
        store.externalStep(
          lease,
          "deliver-v1",
          { mode: "provider-idempotent", validUntil: new Date("2099-01-01") },
          () => Promise.reject(new Error("uncertain"))
        )
      ).rejects.toThrow()
      await pool.query(
        "UPDATE background_job_steps SET idempotency_until=clock_timestamp()-interval '1 second' WHERE job_id=$1",
        [id]
      )
      await expire(id)
      expect((await store.inspect(id)).jobs[0].state).toBe("reconcile")
      expect(await run(id)).toEqual({ state: "idle" })
      await expect(
        outboxDelivery(pool, [consumer])(store, lease)
      ).rejects.toMatchObject({ code: "LEASE_LOST" })
      expect(providerPosts).toBe(0)
      await resolveEffect(id, "retry-safe")
      await replay(id)
      expect(
        await runNextJob(
          store,
          outboxKind(consumer.id),
          outboxDelivery(pool, [{ ...consumer, eventVersion: 2 }]),
          id
        )
      ).toMatchObject({ state: "dead" })
      expect(providerLookups).toBe(0)
    })

    it("rejects changed provider identity, malformed lookup and invalid event payload without dispatch", async () => {
      await event()
      const [id] = await schedule()
      expect(
        await runNextJob(
          store,
          outboxKind(consumer.id),
          outboxDelivery(pool, [
            { ...consumer, providerId: "different_provider_account" },
          ]),
          id
        )
      ).toMatchObject({ state: "dead" })
      expect(providerLookups).toBe(0)
      await replay(id)
      const malformed = {
        ...consumer,
        reconcile: () => Promise.resolve({ state: "unexpected" }),
      } as unknown as OutboxConsumer
      expect(
        await runNextJob(
          store,
          outboxKind(consumer.id),
          outboxDelivery(pool, [malformed]),
          id
        )
      ).toMatchObject({ state: "reconcile" })
      expect(providerPosts).toBe(0)
      await event(consumer.topic, { malformed: true })
      const [invalid] = await schedule()
      expect(await run(invalid)).toMatchObject({ state: "dead" })
      expect(providerPosts).toBe(0)
    })

    it("fences overlapping delivery workers and preserves a committed provider receipt after a lost worker", async () => {
      await event()
      const [id] = await schedule()
      const results = await Promise.all(
        Array.from({ length: 6 }, () => run(id))
      )
      expect(
        results.filter((result) => result.state === "completed")
      ).toHaveLength(1)
      expect(providerPosts).toBe(1)
      expect(openTransactions).toBe(0)
      await event()
      const [other] = await schedule()
      const lease = (await store.claim(outboxKind(consumer.id), other))!
      await outboxDelivery(pool, [consumer])(store, lease)
      expect(providerPosts).toBe(2)
      await expire(other)
      expect(await run(other)).toMatchObject({ state: "completed" })
      expect(providerPosts).toBe(2)
      expect(providerLookups).toBe(2)
    })

    it("integrates real outbox health with the enabled operations monitor", async () => {
      await event()
      const [id] = await schedule()
      lookupUnknown = true
      await run(id)
      await pool.query(`INSERT INTO operational_metric_health(key,value,observed_at)
        VALUES('outbox-age',0,clock_timestamp()-interval '1 day')`)
      const result = await runMonitor(monitorStore(pool), env())
      expect(result.delivered).toBeGreaterThan(0)
      expect(
        alerts.some((a) => a.code === "OUTBOX_RECONCILIATION_REQUIRED")
      ).toBe(true)
      expect(
        alerts.some(
          (a) => a.code === "SIGNAL_MISSING" && a.signal === "outbox-age"
        )
      ).toBe(false)
      expect(
        alerts.some(
          (a) => a.code === "SIGNAL_STALE" && a.signal === "outbox-age"
        )
      ).toBe(false)
    })
  }
)

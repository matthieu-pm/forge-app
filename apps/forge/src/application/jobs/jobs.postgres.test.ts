// @vitest-environment node
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { journalDatabasePool } from "../../adapters/recovery/journaled-pool.server"
import { JobError, jobStore } from "./job-store"
import { jobCommand } from "./job-cli"
import { runNextJob } from "./job-runner"
import {
  WORKFLOW_RETENTION_KIND,
  enqueueWorkflowRetention,
  runWorkflowRetention,
  workflowRetention,
} from "./workflow-retention"
import type { Pool as NeonPool } from "@neondatabase/serverless"

vi.mock("@tanstack/react-start/server-only", () => ({}))

const connection = process.env.FORGE_JOB_TEST_DATABASE_URL

describe.skipIf(!connection)("FOR-64 local PostgreSQL acceptance", () => {
  let pool: Pool
  let store: ReturnType<typeof jobStore>
  const scope = `for64-${randomUUID()}`
  const ids: Array<string> = []
  const scheduledAt = new Date("2020-01-01T00:00:00Z")
  const enqueue = async (maxAttempts = 5, input: unknown = {}) => {
    const id = await store.enqueue({
      kind: "fixture-v1",
      scope,
      identity: randomUUID(),
      scheduledAt,
      input,
      maxAttempts,
    })
    ids.push(id)
    return id
  }
  const expire = async (id: string) => {
    await pool.query(
      "UPDATE background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [id]
    )
    await store.reap()
    await pool.query(
      "UPDATE background_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [id]
    )
  }
  const due = async (id: string) =>
    pool.query(
      "UPDATE background_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [id]
    )
  const recovery = async (id: string) => ({
    jobId: id,
    generation: (await store.inspect(id)).jobs[0].generation as number,
    requestId: randomUUID(),
    operatorId: randomUUID(),
    reason: "code-fixed" as const,
    action: "replay" as const,
  })
  beforeAll(async () => {
    const url = new URL(connection!)
    if (
      url.hostname !== "127.0.0.1" ||
      url.port !== "56464" ||
      url.pathname !== "/for64_jobs_test"
    )
      throw new Error("Dedicated local FOR-64 database required")
    pool = new Pool({ connectionString: connection, max: 10 })
    expect(
      (await pool.query("SELECT current_database() name")).rows[0].name
    ).toBe("for64_jobs_test")
    if (
      !(await pool.query("SELECT to_regclass('background_jobs') present"))
        .rows[0].present
    ) {
      for (const file of readdirSync("drizzle")
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await pool.query(readFileSync(`drizzle/${file}`, "utf8"))
    }
    await pool.query(
      "CREATE TABLE IF NOT EXISTS for64_job_effects(job_id uuid NOT NULL, id uuid PRIMARY KEY DEFAULT gen_random_uuid())"
    )
    store = jobStore(pool)
  }, 30000)
  afterAll(async () => {
    if (!pool) return
    if (ids.length) {
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
      await pool.query(
        "DELETE FROM for64_job_effects WHERE job_id=ANY($1::uuid[])",
        [ids]
      )
    }
    await pool.end()
  })
  it("deduplicates enqueue and rejects changed immutable inputs or schedule", async () => {
    const input = {
      kind: "fixture-v1",
      scope,
      identity: randomUUID(),
      scheduledAt,
      input: { a: 1 },
    }
    const result = await Promise.all(
      Array.from({ length: 8 }, () => store.enqueue(input))
    )
    ids.push(result[0])
    expect(new Set(result).size).toBe(1)
    await expect(
      store.enqueue({ ...input, input: { a: 2 } })
    ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" })
    await expect(
      store.enqueue({ ...input, scheduledAt: new Date() })
    ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" })
  })
  it("overlapping workers get one lease; future and completed jobs cannot be claimed", async () => {
    const id = await enqueue()
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => store.claim("fixture-v1", id))
    )
    expect(claims.filter(Boolean)).toHaveLength(1)
    await store.complete(claims.find(Boolean)!)
    expect(await store.claim("fixture-v1", id)).toBeNull()
    const future = await store.enqueue({
      kind: "fixture-v1",
      scope,
      identity: randomUUID(),
      scheduledAt: new Date("2100-01-01"),
      input: {},
    })
    ids.push(future)
    expect(await store.claim("fixture-v1", future)).toBeNull()
  })
  it("fences heartbeat, effects, failure and completion after expiry/takeover", async () => {
    const id = await enqueue(),
      old = (await store.claim("fixture-v1", id))!
    await expire(id)
    const lease = (await store.claim("fixture-v1", id))!
    expect(lease.generation).toBeGreaterThan(old.generation)
    await expect(store.heartbeat(old)).rejects.toMatchObject({
      code: "LEASE_LOST",
    })
    await expect(
      store.sqlStep(old, "x", async (tx) => {
        await tx.query("INSERT INTO for64_job_effects(job_id) VALUES($1)", [id])
        return null
      })
    ).rejects.toMatchObject({ code: "LEASE_LOST" })
    await expect(store.complete(old)).rejects.toMatchObject({
      code: "LEASE_LOST",
    })
    await expect(store.fail(old, new Error())).rejects.toMatchObject({
      code: "LEASE_LOST",
    })
    await store.complete(lease)
  })
  for (const phase of ["before-commit", "after-commit"])
    it(`AT-01: SIGKILL ${phase}, then one committed logical effect`, async () => {
      const id = await enqueue()
      const child = spawn(
        "bun",
        ["scripts/job-acceptance-worker.ts", id, phase],
        {
          env: { ...process.env, FORGE_JOB_TEST_DATABASE_URL: connection },
          stdio: ["ignore", "pipe", "pipe"],
        }
      )
      const closed = new Promise<void>((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", () => resolve())
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Worker did not reach boundary")),
            10000
          )
          child.stdout.on("data", (data) => {
            if (String(data).includes("ready")) {
              clearTimeout(timer)
              resolve()
            }
          })
          child.once("exit", () => {
            clearTimeout(timer)
            reject(new Error("Worker exited before boundary"))
          })
        })
      } finally {
        child.kill("SIGKILL")
        await closed
      }
      await expire(id)
      const lease = (await store.claim("fixture-v1", id))!
      const value = await store.sqlStep(lease, "effect-v1", async (tx) => {
        await tx.query("INSERT INTO for64_job_effects(job_id) VALUES($1)", [id])
        return { count: 1 }
      })
      expect(value).toEqual({ count: 1 })
      await store.complete(lease)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM for64_job_effects WHERE job_id=$1",
            [id]
          )
        ).rows[0].n
      ).toBe(1)
    })
  it("rolls back a failed SQL callback and retries without a checkpoint", async () => {
    const id = await enqueue(),
      lease = (await store.claim("fixture-v1", id))!
    await expect(
      store.sqlStep(lease, "x", async (tx) => {
        await tx.query("INSERT INTO for64_job_effects(job_id) VALUES($1)", [id])
        throw new Error("private payload")
      })
    ).rejects.toThrow()
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM for64_job_effects WHERE job_id=$1",
          [id]
        )
      ).rows[0].n
    ).toBe(0)
    expect((await store.inspect(id)).steps).toHaveLength(0)
  })
  it("AT-02: bounded retries, sanitized inspection, exact operator replay with retained checkpoints", async () => {
    const id = await enqueue(2, { private: "secret-payload" })
    const handler = async (
      s: typeof store,
      lease: Parameters<typeof store.complete>[0]
    ) => {
      await s.sqlStep(lease, "saved", async (tx) => {
        await tx.query("INSERT INTO for64_job_effects(job_id) VALUES($1)", [id])
        return { private: "secret-result" }
      })
      throw new Error("secret-exception")
    }
    const logs = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      expect((await runNextJob(store, "fixture-v1", handler, id)).state).toBe(
        "retry"
      )
      expect(await store.claim("fixture-v1", id)).toBeNull()
      await due(id)
      expect((await runNextJob(store, "fixture-v1", handler, id)).state).toBe(
        "dead"
      )
      const inspected = await jobCommand(store, ["inspect", id])
      expect(JSON.stringify(inspected)).toContain("bun run jobs replay")
      expect(JSON.stringify(inspected)).not.toMatch(/secret-/)
      expect(JSON.stringify(logs.mock.calls)).not.toMatch(/secret-/)
      const input = await recovery(id)
      expect(await store.recover(input)).toEqual({ replayed: false })
      expect(await store.recover(input)).toEqual({ replayed: true })
      await expect(
        store.recover({ ...input, reason: "dependency-restored" })
      ).rejects.toMatchObject({ code: "RECOVERY_CONFLICT" })
      await expect(
        store.recover({ ...input, requestId: randomUUID() })
      ).rejects.toMatchObject({ code: "RECOVERY_CONFLICT" })
      expect(
        (
          await runNextJob(
            store,
            "fixture-v1",
            async (s, lease) => {
              await s.sqlStep(lease, "saved", async () => {
                throw new Error("must not replay")
              })
            },
            id
          )
        ).state
      ).toBe("completed")
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM for64_job_effects WHERE job_id=$1",
            [id]
          )
        ).rows[0].n
      ).toBe(1)
    } finally {
      logs.mockRestore()
    }
  })
  it("requires reconciliation for ambiguous external effects, including expired final attempt", async () => {
    const id = await enqueue(1),
      lease = (await store.claim("fixture-v1", id))!
    const provider = vi.fn(async () => {
      throw new Error("unknown outcome")
    })
    await expect(
      store.externalStep(lease, "send", { mode: "reconcile" }, provider)
    ).rejects.toThrow()
    await expire(id)
    expect((await store.inspect(id)).jobs[0].state).toBe("reconcile")
    const replay = await recovery(id)
    await expect(store.recover(replay)).rejects.toMatchObject({
      code: "RECONCILIATION_REQUIRED",
    })
    await store.recover({
      ...replay,
      action: "resolve",
      step: "send",
      outcome: "completed",
      reason: "provider-confirmed",
      quiesced: true,
      evidence: "FOR-64",
    })
    await store.recover(await recovery(id))
    const next = (await store.claim("fixture-v1", id))!
    expect(
      await store.externalStep(next, "send", { mode: "reconcile" }, provider)
    ).toBeUndefined()
    expect(provider).toHaveBeenCalledTimes(1)
    await store.complete(next)
  })
  it("preserves provider idempotency identity across attempts", async () => {
    const id = await enqueue(),
      keys: Array<string> = []
    let lease = (await store.claim("fixture-v1", id))!
    await expect(
      store.externalStep(
        lease,
        "deliver",
        { mode: "provider-idempotent", validUntil: new Date("2100-01-01") },
        async (key) => {
          keys.push(key)
          throw new Error()
        }
      )
    ).rejects.toThrow()
    await expire(id)
    lease = (await store.claim("fixture-v1", id))!
    await store.externalStep(
      lease,
      "deliver",
      { mode: "provider-idempotent", validUntil: new Date("2100-01-01") },
      async (key) => {
        keys.push(key)
        return
      }
    )
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(1)
    await store.complete(lease)
  })
  it("retention freezes daily cutoff, deletes terminal records in bounded checkpoints, preserves active and recent records", async () => {
    const workspace = randomUUID(),
      now = new Date("2020-04-01T12:00:00Z")
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES($1,$1,$1,now())",
      [workspace]
    )
    const runIds = Array.from({ length: 504 }, () => randomUUID())
    try {
      for (let i = 0; i < runIds.length; i++)
        await pool.query(
          `INSERT INTO business_workflow_runs(id,workspace_id,kind,subject_type,subject_id,idempotency_key,state,completed_at,updated_at)
        VALUES($1::uuid,$2,'fixture','fixture',$1::text,$1::text,$3,$4,$4)`,
          [
            runIds[i],
            workspace,
            i === 502 ? "running" : i === 503 ? "failed-to-start" : "completed",
            i === 501 ? "2020-03-31" : "2019-01-01",
          ]
        )
      const id = await enqueueWorkflowRetention(store, now)
      ids.push(id)
      expect(
        await enqueueWorkflowRetention(store, new Date("2020-04-01T20:00:00Z"))
      ).toBe(id)
      expect(
        (
          await runNextJob(
            store,
            WORKFLOW_RETENTION_KIND,
            workflowRetention,
            id
          )
        ).state
      ).toBe("completed")
      expect(
        (
          await pool.query(
            "SELECT id FROM business_workflow_runs WHERE workspace_id=$1",
            [workspace]
          )
        ).rows
          .map((r) => r.id)
          .sort()
      ).toEqual([runIds[501], runIds[502]].sort())
      expect((await store.inspect(id)).steps).toHaveLength(3)
    } finally {
      await pool.query("DELETE FROM organization WHERE id=$1", [workspace])
    }
  }, 30000)
  it("rolls back a SQL mutation if ownership expires before checkpoint commit", async () => {
    const id = await enqueue(),
      lease = (await store.claim("fixture-v1", id))!
    await expect(
      store.sqlStep(lease, "expiry", async (tx) => {
        await tx.query("INSERT INTO for64_job_effects(job_id) VALUES($1)", [id])
        await tx.query(
          "UPDATE background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
          [id]
        )
        return null
      })
    ).rejects.toMatchObject({ code: "LEASE_LOST" })
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM for64_job_effects WHERE job_id=$1",
          [id]
        )
      ).rows[0].n
    ).toBe(0)
    expect((await store.inspect(id)).steps).toHaveLength(0)
  })
  it("stops an expired provider deduplication window and requires quiescence evidence", async () => {
    const id = await enqueue(),
      lease = (await store.claim("fixture-v1", id))!
    await expect(
      store.externalStep(
        lease,
        "external",
        { mode: "provider-idempotent", validUntil: new Date("2100-01-01") },
        async () => {
          throw new Error()
        }
      )
    ).rejects.toThrow()
    await pool.query(
      "UPDATE background_job_steps SET idempotency_until=clock_timestamp()-interval '1 second' WHERE job_id=$1",
      [id]
    )
    await expire(id)
    expect((await store.inspect(id)).jobs[0].state).toBe("reconcile")
    const base = await recovery(id)
    await expect(
      jobCommand(store, [
        "resolve",
        id,
        "--generation",
        String(base.generation),
        "--request",
        base.requestId,
        "--operator",
        base.operatorId,
        "--reason",
        "provider-confirmed",
        "--step",
        "external",
        "--outcome",
        "retry-safe",
      ])
    ).rejects.toMatchObject({ code: "INVALID_INPUT" })
    await store.recover({
      ...base,
      action: "resolve",
      reason: "provider-confirmed",
      step: "external",
      outcome: "retry-safe",
      quiesced: true,
      evidence: "FOR-64",
    })
    const audit = (
      await pool.query(
        "SELECT quiesced,evidence,database_role,outcome FROM background_job_recoveries WHERE request_id=$1",
        [base.requestId]
      )
    ).rows[0]
    expect(audit).toMatchObject({
      quiesced: true,
      evidence: "FOR-64",
      outcome: "retry-safe",
      database_role: "for64",
    })
    await store.recover(await recovery(id))
    const next = (await store.claim("fixture-v1", id))!
    await store.externalStep(
      next,
      "external",
      { mode: "provider-idempotent", validUntil: new Date("2100-01-01") },
      async () => {}
    )
    await store.complete(next)
  })
  it("does not report product retention success for a dead daily cleanup", async () => {
    const now = new Date("2020-04-02T12:00:00Z")
    const id = await enqueueWorkflowRetention(store, now)
    ids.push(id)
    const lease = (await store.claim(WORKFLOW_RETENTION_KIND, id))!
    await store.fail(lease, new JobError("JOB_FAILED", true))
    await expect(runWorkflowRetention(store, now)).rejects.toMatchObject({
      code: "JOB_FAILED",
    })
  })
  it("keeps lease/failure/completion constraints valid and rejects corrupt writes", async () => {
    const id = await enqueue()
    await expect(
      pool.query("UPDATE background_jobs SET state='running' WHERE id=$1", [id])
    ).rejects.toThrow()
    await expect(
      pool.query("UPDATE background_jobs SET max_attempts=0 WHERE id=$1", [id])
    ).rejects.toThrow()
    await expect(
      pool.query("UPDATE background_jobs SET state='completed' WHERE id=$1", [
        id,
      ])
    ).rejects.toThrow()
  })
  it("rejects oversized input and rolls back mutations when checkpoint encoding fails", async () => {
    await expect(
      enqueue(5, { large: "x".repeat(17000) })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" })
    const id = await enqueue(),
      lease = (await store.claim("fixture-v1", id))!
    await expect(
      store.sqlStep(lease, "invalid-result", async (tx) => {
        await tx.query("INSERT INTO for64_job_effects(job_id) VALUES($1)", [id])
        return { unsupported: undefined }
      })
    ).rejects.toThrow()
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM for64_job_effects WHERE job_id=$1",
          [id]
        )
      ).rows[0].n
    ).toBe(0)
    expect((await store.inspect(id)).steps).toHaveLength(0)
  })
  it("serializes competing recovery requests without replaying twice", async () => {
    const id = await enqueue(1),
      lease = (await store.claim("fixture-v1", id))!
    await store.fail(lease, new Error())
    const input = await recovery(id)
    const results = await Promise.allSettled([
      store.recover(input),
      store.recover({ ...input, requestId: randomUUID() }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find(
      (r) => r.status === "rejected"
    ) as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: "RECOVERY_CONFLICT" })
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM background_job_recoveries WHERE job_id=$1",
          [id]
        )
      ).rows[0].n
    ).toBe(1)
  })
  it("preserves primary-key coverage required by enabled deletion recovery", async () => {
    const result = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM pg_index WHERE indrelid='background_job_steps'::regclass AND indisprimary) AS present`
    )
    expect(result.rows[0].present).toBe(true)
  })
  it("deletes retained workflows through enabled recovery preparation", async () => {
    const workspace = randomUUID(),
      run = randomUUID(),
      now = new Date("2020-05-01T12:00:00Z")
    const hasPk = (
      await pool.query(
        "SELECT EXISTS(SELECT 1 FROM pg_index WHERE indrelid='background_job_steps'::regclass AND indisprimary) present"
      )
    ).rows[0].present
    if (!hasPk)
      await pool.query(
        "ALTER TABLE background_job_steps ADD PRIMARY KEY(job_id,key)"
      )
    await pool.query("SELECT forge_install_recovery_triggers()")
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES($1,$1,$1,now())",
      [workspace]
    )
    await pool.query(
      `INSERT INTO business_workflow_runs(id,workspace_id,kind,subject_type,subject_id,idempotency_key,state,completed_at) VALUES($1::uuid,$2,'fixture','fixture',$1::text,$1::text,'completed','2019-01-01')`,
      [run, workspace]
    )
    const recoveredEvents: Array<string> = []
    const operations: Array<string> = []
    const backend = {
      prepare: vi.fn(async (id: string) => {
        operations.push(id)
      }),
      abort: vi.fn(async () => {}),
      complete: vi.fn(
        async (
          _id: unknown,
          _source: unknown,
          batches: AsyncIterable<Array<{ table: string }>>
        ) => {
          for await (const batch of batches)
            recoveredEvents.push(...batch.map((event) => event.table))
        }
      ),
    }
    const journalPool = new Pool({
      connectionString: connection,
      options: "-c neon.branch_id=br-local-fixture",
    })
    journalDatabasePool(
      journalPool as unknown as NeonPool,
      backend,
      connection!,
      "store_fixture"
    )
    try {
      await pool.query(
        "UPDATE recovery_journal_state SET enabled=true WHERE id='singleton'"
      )
      const journalStore = jobStore(journalPool)
      const id = await enqueueWorkflowRetention(journalStore, now)
      ids.push(id)
      expect(
        (
          await runNextJob(
            journalStore,
            WORKFLOW_RETENTION_KIND,
            workflowRetention,
            id
          )
        ).state
      ).toBe("completed")
      expect(recoveredEvents).toContain("business_workflow_runs")
      expect(backend.prepare).toHaveBeenCalled()
      expect(backend.complete).toHaveBeenCalled()
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM business_workflow_runs WHERE id=$1",
            [run]
          )
        ).rows[0].n
      ).toBe(0)
    } finally {
      await pool.query(
        "UPDATE recovery_journal_state SET enabled=false WHERE id='singleton'"
      )
      await journalPool.end()
      await pool.query("DELETE FROM organization WHERE id=$1", [workspace])
      if (!hasPk)
        await pool.query(
          "ALTER TABLE background_job_steps DROP CONSTRAINT background_job_steps_pkey"
        )
      await pool.query(
        "DELETE FROM recovery_events WHERE operation_id=ANY($1::uuid[])",
        [operations]
      )
      await pool.query(
        "DELETE FROM recovery_operations WHERE id=ANY($1::uuid[])",
        [operations]
      )
    }
  })
  for (const phase of ["completion", "external-intent"])
    it(`rejects expired ownership delayed during ${phase}`, async () => {
      const id = await enqueue(),
        lease = (await store.claim("fixture-v1", id))!
      const blocker = await pool.connect()
      const invoked = vi.fn(async () => {})
      try {
        await blocker.query("BEGIN")
        await blocker.query(
          "LOCK TABLE background_job_steps IN ACCESS EXCLUSIVE MODE"
        )
        await pool.query(
          "UPDATE background_jobs SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1",
          [id]
        )
        const pending =
          phase === "completion"
            ? store.complete(lease)
            : store.externalStep(lease, "late", { mode: "reconcile" }, invoked)
        const observed = pending.then(
          () => ({ ok: true }),
          (error) => ({ ok: false, error })
        )
        for (let n = 0; n < 40; n++) {
          const waiting = await pool.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%background_job_steps%' AND pid<>pg_backend_pid()"
          )
          if (waiting.rows[0].n) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        await new Promise((resolve) => setTimeout(resolve, 1100))
        await blocker.query("COMMIT")
        const result = await observed
        expect(result).toMatchObject({
          ok: false,
          error: { code: "LEASE_LOST" },
        })
        expect(invoked).not.toHaveBeenCalled()
      } finally {
        await blocker.query("ROLLBACK")
        blocker.release()
      }
    })
  it("keeps an ID-specific claim from reaping another expired job", async () => {
    const first = await enqueue(),
      second = await enqueue()
    await store.claim("fixture-v1", first)
    await store.claim("fixture-v1", second)
    await pool.query(
      "UPDATE background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])",
      [[first, second]]
    )
    expect(await store.claim("fixture-v1", first)).toBeNull()
    expect((await store.inspect(first)).jobs[0].state).toBe("retry")
    expect((await store.inspect(second)).jobs[0].state).toBe("running")
  })
  it("rejects unsafe CLI arguments and live-owner replay", async () => {
    const id = await enqueue()
    await store.claim("fixture-v1", id)
    await expect(store.recover(await recovery(id))).rejects.toMatchObject({
      code: "RECOVERY_CONFLICT",
    })
    await expect(
      jobCommand(store, ["inspect", "not-a-uuid"])
    ).rejects.toBeInstanceOf(JobError)
    await expect(
      jobCommand(store, ["replay", id, "--garbage", "x"])
    ).rejects.toBeInstanceOf(JobError)
  })
})

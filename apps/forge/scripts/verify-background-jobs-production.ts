import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { JobError, jobStore } from "../src/application/jobs/job-store"
import { jobCommand } from "../src/application/jobs/job-cli"
import { runNextJob } from "../src/application/jobs/job-runner"
import {
  WORKFLOW_RETENTION_KIND,
  workflowRetention,
} from "../src/application/jobs/workflow-retention"
import { DATABASE_TARGETS } from "./lib/database-targets"

async function verify() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim()
  if (
    process.env.FORGE_JOB_PRODUCTION_AUTHORIZED_REVISION !== revision ||
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  )
    throw new Error("Exact clean source required")
  const credentials = JSON.parse(
    readFileSync(process.env.FORGE_JOB_PRODUCTION_DATABASE_FILE ?? "", "utf8")
  )
  const connection = String(
    credentials.applicationConnection ?? credentials.connection
  )
  const target = DATABASE_TARGETS.production,
    url = new URL(connection)
  if (
    url.hostname.replace("-pooler.", ".") !== target.host ||
    url.pathname !== `/${target.database}`
  )
    throw new Error("Target mismatch")
  neonConfig.webSocketConstructor = WebSocket
  const pool = new Pool({ connectionString: connection, max: 3 })
  const scope = `for64-acceptance-${randomUUID()}`,
    workspace = randomUUID(),
    oldRun = randomUUID(),
    recentRun = randomUUID(),
    activeRun = randomUUID()
  let verified = false
  const check = (condition: unknown) => {
    if (!condition) throw new Error("Acceptance assertion failed")
  }
  try {
    const identity = (
      await pool.query(
        "SELECT current_database() database,current_setting('neon.branch_id',true) branch,current_user role"
      )
    ).rows[0]
    check(
      identity.database === target.database &&
        identity.branch === target.branchId
    )
    const migrations = readMigrationFiles({
      migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
    })
    const applied = (
      await pool.query(
        "SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at"
      )
    ).rows
    check(
      applied.length === migrations.length &&
        applied.every(
          (row, i) =>
            row.hash === migrations[i].hash &&
            Number(row.created_at) === migrations[i].folderMillis
        )
    )
    check(
      (
        await pool.query(
          "SELECT enabled FROM recovery_journal_state WHERE id='singleton'"
        )
      ).rows[0].enabled === false
    )
    check(
      (
        await pool.query(`SELECT count(*)::int n FROM business_workflow_runs WHERE
      (state IN ('completed','failed','cancelled') AND completed_at<'1900-01-01') OR
      (state='failed-to-start' AND updated_at<'1900-01-01')`)
      ).rows[0].n === 0
    )
    verified = true
    console.info(JSON.stringify({ fixture: { scope, workspace } }))
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES($1,$2,$2,now())",
      [workspace, scope]
    )
    const store = jobStore(pool)
    const scheduledAt = new Date(Date.now() - 1000)
    const id = await store.enqueue({
      kind: "for64-acceptance-v1",
      scope,
      identity: "resume",
      input: { workspace },
      scheduledAt,
    })
    const claims = await Promise.all([
      store.claim("for64-acceptance-v1", id),
      store.claim("for64-acceptance-v1", id),
    ])
    check(claims.filter(Boolean).length === 1)
    const first = claims.find(Boolean)!
    await store.sqlStep(first, "effect", async (tx) => {
      await tx.query(
        `INSERT INTO business_workflow_runs(id,workspace_id,kind,subject_type,subject_id,idempotency_key,state,completed_at)
        VALUES($1::uuid,$2,'fixture','fixture',$1::text,$1::text,'completed','1899-01-01')`,
        [oldRun, workspace]
      )
      return { id: oldRun }
    })
    await pool.query(
      "UPDATE background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND scope=$2",
      [id, scope]
    )
    await store.reap("for64-acceptance-v1", id)
    await pool.query(
      "UPDATE background_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1 AND scope=$2",
      [id, scope]
    )
    const resumed = (await store.claim("for64-acceptance-v1", id))!
    check(resumed.generation > first.generation)
    let fenced = false
    try {
      await store.complete(first)
    } catch (error) {
      fenced = error instanceof JobError && error.code === "LEASE_LOST"
    }
    check(fenced)
    const saved = await store.sqlStep<{ id: string }>(resumed, "effect", () => {
      throw new Error("Duplicate callback")
    })
    check(saved.id === oldRun)
    check(
      (
        await pool.query(
          "SELECT count(*)::int n FROM business_workflow_runs WHERE id=$1",
          [oldRun]
        )
      ).rows[0].n === 1
    )
    await store.complete(resumed)
    for (const [run, state, date] of [
      [recentRun, "completed", "2099-01-01"],
      [activeRun, "running", "1899-01-01"],
    ])
      await pool.query(
        `INSERT INTO business_workflow_runs(id,workspace_id,kind,subject_type,subject_id,idempotency_key,state,completed_at)
        VALUES($1::uuid,$2,'fixture','fixture',$1::text,$1::text,$3,$4)`,
        [run, workspace, state, date]
      )
    const retention = await store.enqueue({
      kind: WORKFLOW_RETENTION_KIND,
      scope,
      identity: "retention",
      input: { cutoff: "1900-01-01T00:00:00.000Z" },
      scheduledAt,
    })
    check(
      (
        await runNextJob(
          store,
          WORKFLOW_RETENTION_KIND,
          workflowRetention,
          retention
        )
      ).state === "completed"
    )
    check(
      (
        await pool.query(
          "SELECT count(*)::int n FROM business_workflow_runs WHERE id=$1",
          [oldRun]
        )
      ).rows[0].n === 0
    )
    check(
      (
        await pool.query(
          "SELECT count(*)::int n FROM business_workflow_runs WHERE workspace_id=$1",
          [workspace]
        )
      ).rows[0].n === 2
    )
    const failed = await store.enqueue({
      kind: "for64-acceptance-v1",
      scope,
      identity: "recovery",
      input: {},
      scheduledAt,
      maxAttempts: 1,
    })
    const lease = (await store.claim("for64-acceptance-v1", failed))!
    check(
      (await store.fail(lease, new JobError("JOB_FAILED", true))) === "dead"
    )
    const cliInspection = execFileSync(
      "bun",
      ["scripts/background-jobs.ts", "inspect", failed],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: connection,
          FORGE_ENVIRONMENT: "production",
        },
        encoding: "utf8",
      }
    )
    check(JSON.parse(cliInspection).jobs[0]?.state === "dead")
    const inspection = await jobCommand(store, ["inspect", failed])
    check(JSON.stringify(inspection).includes("bun run jobs replay"))
    const request = {
      jobId: failed,
      generation: lease.generation,
      requestId: randomUUID(),
      operatorId: randomUUID(),
      reason: "code-fixed" as const,
      action: "replay" as const,
    }
    check((await store.recover(request)).replayed === false)
    check((await store.recover(request)).replayed === true)
    check(
      (await runNextJob(store, "for64-acceptance-v1", async () => {}, failed))
        .state === "completed"
    )
    console.info(
      JSON.stringify({
        sourceRevision: revision,
        identity,
        migrationCount: applied.length,
        scope,
        checks: {
          overlap: true,
          checkpointResume: true,
          staleOwnerFenced: true,
          oneEffect: true,
          terminalRetention: true,
          activeRecentPreserved: true,
          deadLetter: true,
          inspection: true,
          standaloneCLI: true,
          exactOperatorReplay: true,
        },
      })
    )
  } finally {
    if (verified) {
      const jobs = (
        await pool.query("SELECT id FROM background_jobs WHERE scope=$1", [
          scope,
        ])
      ).rows.map((row) => row.id)
      await pool.query(
        "DELETE FROM background_job_steps WHERE job_id=ANY($1::uuid[])",
        [jobs]
      )
      await pool.query(
        "DELETE FROM background_job_recoveries WHERE job_id=ANY($1::uuid[])",
        [jobs]
      )
      await pool.query(
        "DELETE FROM background_jobs WHERE id=ANY($1::uuid[]) AND scope=$2",
        [jobs, scope]
      )
      await pool.query("DELETE FROM organization WHERE id=$1 AND slug=$2", [
        workspace,
        scope,
      ])
      const cleanup = (
        await pool.query(
          `SELECT (SELECT count(*)::int FROM background_jobs WHERE scope=$1) jobs,
        (SELECT count(*)::int FROM organization WHERE id=$2) workspaces,
        (SELECT count(*)::int FROM business_workflow_runs WHERE workspace_id=$2) workflows`,
          [scope, workspace]
        )
      ).rows[0]
      check(Object.values(cleanup).every((value) => value === 0))
      console.info(JSON.stringify({ cleanup }))
    }
    await pool.end()
  }
}
try {
  await verify()
} catch {
  console.error("BACKGROUND_JOB_PRODUCTION_ACCEPTANCE_FAILED")
  process.exitCode = 1
}

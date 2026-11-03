import { createHash, randomUUID } from "node:crypto"
import { emitTelemetry } from "../../../../../packages/telemetry/server"
import { canonicalCommandInput } from "../../lib/canonical-json"

export type JobSql = {
  query: (
    text: string,
    values?: Array<unknown>
  ) => Promise<{ rows: Array<Record<string, any>> }>
}
export type JobPool = JobSql & {
  connect: () => Promise<JobSql & { release: () => void }>
}
export type JobLease = {
  id: string
  token: string
  generation: number
  attempt: number
  kind: string
  input: unknown
  queueAgeMs: number
}
export type JobState =
  "queued" | "running" | "retry" | "completed" | "dead" | "reconcile"
export type Recovery = {
  requestId: string
  jobId: string
  generation: number
  operatorId: string
  reason: "dependency-restored" | "code-fixed" | "provider-confirmed"
} & (
  | { action: "replay" }
  | {
      action: "resolve"
      step: string
      outcome: "completed" | "retry-safe"
      quiesced: true
      evidence: string
    }
)
export class JobError extends Error {
  constructor(
    readonly code:
      | "JOB_FAILED"
      | "LEASE_LOST"
      | "IDENTITY_CONFLICT"
      | "RECOVERY_CONFLICT"
      | "RECONCILIATION_REQUIRED"
      | "INVALID_INPUT",
    readonly permanent = false
  ) {
    super(code)
  }
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalCommandInput(value)).digest("hex")
const uuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const key = (v: string) => /^[a-zA-Z0-9:._-]{1,200}$/.test(v)
const json = (value: unknown) => {
  const encoded = canonicalCommandInput(value)
  if (Buffer.byteLength(encoded) > 16384) throw new JobError("INVALID_INPUT")
  return encoded
}

export function jobStore(pool: JobPool) {
  async function transaction<T>(run: (tx: JobSql) => Promise<T>): Promise<T> {
    const tx = await pool.connect()
    try {
      await tx.query("BEGIN")
      await tx.query("SET LOCAL statement_timeout='30s'")
      await tx.query("SET LOCAL lock_timeout='5s'")
      await tx.query("SET LOCAL idle_in_transaction_session_timeout='30s'")
      const result = await run(tx)
      await tx.query("COMMIT")
      return result
    } catch (error) {
      await tx.query("ROLLBACK").catch(() => {})
      throw error
    } finally {
      tx.release()
    }
  }
  async function fence(tx: JobSql, lease: JobLease) {
    const result = await tx.query(
      `SELECT id FROM background_jobs WHERE id=$1 AND lease_token=$2 AND generation=$3
      AND state='running' AND lease_until>clock_timestamp() FOR UPDATE`,
      [lease.id, lease.token, lease.generation]
    )
    if (!result.rows.length) throw new JobError("LEASE_LOST")
  }
  async function stillOwned(tx: JobSql, lease: JobLease) {
    const result = await tx.query(
      `SELECT id FROM background_jobs WHERE id=$1 AND lease_token=$2 AND generation=$3
      AND state='running' AND lease_until>clock_timestamp()`,
      [lease.id, lease.token, lease.generation]
    )
    if (!result.rows.length) throw new JobError("LEASE_LOST")
  }
  async function reap() {
    const recovered = await pool.query(`WITH expired AS (
      SELECT id FROM background_jobs WHERE state='running' AND lease_until<=clock_timestamp()
      ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED
    ) UPDATE background_jobs j SET
      state=CASE WHEN EXISTS (SELECT 1 FROM background_job_steps s WHERE s.job_id=j.id AND s.state='started' AND (s.mode='reconcile' OR s.idempotency_until<=clock_timestamp())) THEN 'reconcile'
        WHEN attempts>=max_attempts THEN 'dead' ELSE 'retry' END,
      failure_code='LEASE_EXPIRED', lease_token=NULL, lease_until=NULL,
      available_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,least(attempts-1,7)))::int), updated_at=clock_timestamp()
      FROM expired WHERE j.id=expired.id RETURNING j.id,j.state`)
    for (const row of recovered.rows)
      emitTelemetry("operation.failed", "jobs.run", {
        jobId: row.id,
        errorCode:
          row.state === "reconcile"
            ? "JOB_RECONCILIATION_REQUIRED"
            : "JOB_LEASE_LOST",
        failures: 1,
      })
    return recovered
  }
  return {
    async enqueue(input: {
      kind: string
      scope: string
      identity: string
      input: unknown
      scheduledAt: Date
      maxAttempts?: number
    }) {
      if (
        ![input.kind, input.scope, input.identity].every(key) ||
        !Number.isFinite(input.scheduledAt.getTime()) ||
        !Number.isInteger(input.maxAttempts ?? 5) ||
        (input.maxAttempts ?? 5) < 1 ||
        (input.maxAttempts ?? 5) > 20
      )
        throw new JobError("INVALID_INPUT")
      const body = json(input.input)
      const fingerprint = hash({
        input: input.input,
        scheduledAt: input.scheduledAt.toISOString(),
        maxAttempts: input.maxAttempts ?? 5,
      })
      return transaction(async (tx) => {
        await tx.query(
          `INSERT INTO background_jobs(kind,scope,identity,input_hash,input,scheduled_at,available_at,max_attempts)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$6,$7) ON CONFLICT(kind,scope,identity) DO NOTHING`,
          [
            input.kind,
            input.scope,
            input.identity,
            fingerprint,
            body,
            input.scheduledAt,
            input.maxAttempts ?? 5,
          ]
        )
        const row = (
          await tx.query(
            "SELECT id,input_hash FROM background_jobs WHERE kind=$1 AND scope=$2 AND identity=$3",
            [input.kind, input.scope, input.identity]
          )
        ).rows[0]
        if (row.input_hash !== fingerprint)
          throw new JobError("IDENTITY_CONFLICT")
        return row.id as string
      })
    },
    reap,
    async claim(kind: string, id?: string): Promise<JobLease | null> {
      if (!key(kind) || (id && !uuid(id))) throw new JobError("INVALID_INPUT")
      await reap()
      const token = randomUUID()
      const row = (
        await pool.query(
          `WITH candidate AS (
        SELECT id FROM background_jobs WHERE kind=$1 AND ($2::uuid IS NULL OR id=$2) AND state IN ('queued','retry')
        AND available_at<=clock_timestamp() AND attempts<max_attempts ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE background_jobs j SET state='running',attempts=attempts+1,total_attempts=total_attempts+1,generation=generation+1,
        lease_token=$3,lease_until=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
        FROM candidate WHERE j.id=candidate.id RETURNING j.*, greatest(0,extract(epoch FROM (clock_timestamp()-j.scheduled_at))*1000)::float8 AS queue_age_ms`,
          [kind, id ?? null, token]
        )
      ).rows[0]
      return row
        ? {
            id: row.id,
            token,
            generation: row.generation,
            attempt: row.attempts,
            kind: row.kind,
            input: row.input,
            queueAgeMs: Number(row.queue_age_ms),
          }
        : null
    },
    async heartbeat(lease: JobLease) {
      const result = await pool.query(
        `UPDATE background_jobs SET lease_until=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
        WHERE id=$1 AND lease_token=$2 AND generation=$3 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,
        [lease.id, lease.token, lease.generation]
      )
      if (!result.rows.length) throw new JobError("LEASE_LOST")
    },
    async sqlStep<T>(
      lease: JobLease,
      step: string,
      run: (tx: JobSql) => Promise<T>
    ): Promise<T> {
      if (!key(step)) throw new JobError("INVALID_INPUT")
      return transaction(async (tx) => {
        await fence(tx, lease)
        const existing = (
          await tx.query(
            "SELECT mode,state,result FROM background_job_steps WHERE job_id=$1 AND key=$2",
            [lease.id, step]
          )
        ).rows[0]
        if (existing) {
          if (
            existing.mode !== "transactional" ||
            existing.state !== "completed"
          )
            throw new JobError("IDENTITY_CONFLICT")
          return existing.result as T
        }
        // The mutation and its checkpoint share this connection and rollback boundary.
        const result = await run(tx)
        await tx.query(
          `INSERT INTO background_job_steps(job_id,key,mode,state,result) VALUES($1,$2,'transactional','completed',$3::jsonb)`,
          [lease.id, step, json(result)]
        )
        await stillOwned(tx, lease)
        return result
      })
    },
    async externalStep(
      lease: JobLease,
      step: string,
      policy:
        | { mode: "provider-idempotent"; validUntil: Date }
        | { mode: "reconcile" },
      run: (idempotencyKey: string, deadline: Date | null) => Promise<void>
    ): Promise<void> {
      const { mode } = policy
      if (
        !key(step) ||
        !["provider-idempotent", "reconcile"].includes(mode) ||
        (policy.mode === "provider-idempotent" &&
          !Number.isFinite(policy.validUntil.getTime()))
      )
        throw new JobError("INVALID_INPUT")
      const intent = await transaction(async (tx) => {
        await fence(tx, lease)
        const existing = (
          await tx.query(
            "SELECT mode,state,idempotency_until FROM background_job_steps WHERE job_id=$1 AND key=$2",
            [lease.id, step]
          )
        ).rows[0]
        if (existing?.mode && existing.mode !== mode)
          throw new JobError("IDENTITY_CONFLICT")
        if (existing?.state === "completed")
          return { completed: true, deadline: null }
        if (existing?.state === "started" && mode === "reconcile")
          throw new JobError("RECONCILIATION_REQUIRED")
        const deadline =
          existing?.idempotency_until ??
          (policy.mode === "provider-idempotent" ? policy.validUntil : null)
        if (
          mode === "provider-idempotent" &&
          !(
            await tx.query("SELECT $1::timestamptz>clock_timestamp() AS safe", [
              deadline,
            ])
          ).rows[0].safe
        )
          throw new JobError("RECONCILIATION_REQUIRED")
        await tx.query(
          `INSERT INTO background_job_steps(job_id,key,mode,state,idempotency_until) VALUES($1,$2,$3,'started',$4)
          ON CONFLICT(job_id,key) DO UPDATE SET state='started',idempotency_until=EXCLUDED.idempotency_until,updated_at=clock_timestamp()`,
          [lease.id, step, mode, deadline]
        )
        return {
          completed: false,
          deadline: deadline === null ? null : new Date(deadline),
        }
      })
      if (intent.completed) return
      await run(`forge-job-${hash({ job: lease.id, step })}`, intent.deadline)
      await transaction(async (tx) => {
        await fence(tx, lease)
        await tx.query(
          "UPDATE background_job_steps SET state='completed',result='null'::jsonb,updated_at=clock_timestamp() WHERE job_id=$1 AND key=$2",
          [lease.id, step]
        )
        await stillOwned(tx, lease)
      })
    },
    async complete(lease: JobLease) {
      await transaction(async (tx) => {
        await fence(tx, lease)
        const pending = await tx.query(
          "SELECT key FROM background_job_steps WHERE job_id=$1 AND state<>'completed'",
          [lease.id]
        )
        if (pending.rows.length) throw new JobError("RECONCILIATION_REQUIRED")
        await tx.query(
          `UPDATE background_jobs SET state='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp(),failure_code=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1`,
          [lease.id]
        )
      })
    },
    async fail(lease: JobLease, error: unknown) {
      return transaction(async (tx) => {
        await fence(tx, lease)
        const code = error instanceof JobError ? error.code : "JOB_FAILED"
        const permanent = error instanceof JobError && error.permanent
        const row = (
          await tx.query(
            `UPDATE background_jobs j SET
          state=CASE WHEN $2 OR EXISTS(SELECT 1 FROM background_job_steps s WHERE s.job_id=j.id AND s.state='started' AND (s.mode='reconcile' OR s.idempotency_until<=clock_timestamp())) THEN 'reconcile'
          WHEN $3 OR attempts>=max_attempts THEN 'dead' ELSE 'retry' END,
          failure_code=$4,available_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,least(attempts-1,7)))::int),
          lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING state`,
            [lease.id, code === "RECONCILIATION_REQUIRED", permanent, code]
          )
        ).rows[0]
        return row.state as JobState
      })
    },
    async inspect(id?: string) {
      if (id && !uuid(id)) throw new JobError("INVALID_INPUT")
      const rows = (
        await pool.query(
          `SELECT id,kind,state,scheduled_at,available_at,attempts,total_attempts,max_attempts,generation,
        lease_until,failure_code,created_at,updated_at,completed_at FROM background_jobs
        WHERE ($1::uuid IS NULL OR id=$1) ORDER BY created_at DESC,id LIMIT 100`,
          [id ?? null]
        )
      ).rows
      const steps = id
        ? (
            await pool.query(
              "SELECT key,mode,state,updated_at FROM background_job_steps WHERE job_id=$1 ORDER BY (state='started') DESC,updated_at DESC,key LIMIT 100",
              [id]
            )
          ).rows
        : []
      return { jobs: rows, steps }
    },
    async recover(input: Recovery) {
      if (
        !uuid(input.requestId) ||
        !uuid(input.jobId) ||
        !uuid(input.operatorId) ||
        !Number.isInteger(input.generation) ||
        input.generation < 0 ||
        !["dependency-restored", "code-fixed", "provider-confirmed"].includes(
          input.reason
        ) ||
        !["replay", "resolve"].includes(input.action) ||
        (input.action === "resolve" &&
          (input.quiesced !== true ||
            !key(input.evidence) ||
            !key(input.step) ||
            !["completed", "retry-safe"].includes(input.outcome) ||
            input.reason !== "provider-confirmed"))
      )
        throw new JobError("INVALID_INPUT")
      return transaction(async (tx) => {
        const fingerprint = hash(input)
        const row = (
          await tx.query(
            "SELECT state,generation FROM background_jobs WHERE id=$1 FOR UPDATE",
            [input.jobId]
          )
        ).rows[0]
        if (!row) throw new JobError("RECOVERY_CONFLICT")
        const reserved = await tx.query(
          `INSERT INTO background_job_recoveries(request_id,job_id,input_hash,operator_id,action,reason,step,outcome,evidence,quiesced)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING request_id`,
          [
            input.requestId,
            input.jobId,
            fingerprint,
            input.operatorId,
            input.action,
            input.reason,
            input.action === "resolve" ? input.step : null,
            input.action === "resolve" ? input.outcome : null,
            input.action === "resolve" ? input.evidence : null,
            input.action === "resolve" ? input.quiesced : false,
          ]
        )
        if (!reserved.rows.length) {
          const row = (
            await tx.query(
              "SELECT input_hash FROM background_job_recoveries WHERE request_id=$1",
              [input.requestId]
            )
          ).rows[0]
          if (row?.input_hash !== fingerprint)
            throw new JobError("RECOVERY_CONFLICT")
          return { replayed: true }
        }
        if (
          !row ||
          row.generation !== input.generation ||
          !["dead", "reconcile"].includes(row.state)
        )
          throw new JobError("RECOVERY_CONFLICT")
        if (input.action === "resolve") {
          const result = await tx.query(
            `UPDATE background_job_steps SET state=$3,idempotency_until=CASE WHEN $3='pending' THEN NULL ELSE idempotency_until END,result=CASE WHEN $3='completed' THEN 'null'::jsonb ELSE NULL END,updated_at=clock_timestamp()
            WHERE job_id=$1 AND key=$2 AND state='started' AND mode<>'transactional' RETURNING key`,
            [
              input.jobId,
              input.step,
              input.outcome === "completed" ? "completed" : "pending",
            ]
          )
          if (!result.rows.length) throw new JobError("RECOVERY_CONFLICT")
        } else {
          const pending = await tx.query(
            "SELECT key FROM background_job_steps WHERE job_id=$1 AND state='started' AND mode<>'transactional'",
            [input.jobId]
          )
          if (pending.rows.length) throw new JobError("RECONCILIATION_REQUIRED")
        }
        // Resolution records evidence; explicit replay is a separate operator action.
        await tx.query(
          `UPDATE background_jobs SET generation=generation+1,updated_at=clock_timestamp(),
          state=CASE WHEN $2 THEN 'queued' ELSE state END, attempts=CASE WHEN $2 THEN 0 ELSE attempts END,
          available_at=CASE WHEN $2 THEN clock_timestamp() ELSE available_at END WHERE id=$1`,
          [input.jobId, input.action === "replay"]
        )
        return { replayed: false }
      })
    },
  }
}
export type JobStore = ReturnType<typeof jobStore>

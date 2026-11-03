import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    scope: text("scope").notNull(),
    identity: text("identity").notNull(),
    inputHash: text("input_hash").notNull(),
    input: jsonb("input").notNull(),
    state: text("state").notNull().default("queued"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    totalAttempts: integer("total_attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    generation: integer("generation").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("background_jobs_identity").on(t.kind, t.scope, t.identity),
    index("background_jobs_due").on(t.state, t.availableAt),
    check(
      "background_jobs_state",
      sql`${t.state} IN ('queued','running','retry','completed','dead','reconcile')`
    ),
    check(
      "background_jobs_attempts",
      sql`${t.attempts}>=0 AND ${t.totalAttempts}>=${t.attempts} AND ${t.maxAttempts} BETWEEN 1 AND 20 AND ${t.generation}>=0`
    ),
    check(
      "background_jobs_lease",
      sql`(${t.state}='running' AND ${t.leaseToken} IS NOT NULL AND ${t.leaseUntil} IS NOT NULL) OR (${t.state}<>'running' AND ${t.leaseToken} IS NULL AND ${t.leaseUntil} IS NULL)`
    ),
    check(
      "background_jobs_completion",
      sql`(${t.state}='completed')=(${t.completedAt} IS NOT NULL)`
    ),
  ]
)

export const backgroundJobSteps = pgTable(
  "background_job_steps",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => backgroundJobs.id),
    key: text("key").notNull(),
    mode: text("mode").notNull(),
    state: text("state").notNull(),
    result: jsonb("result"),
    idempotencyUntil: timestamp("idempotency_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ name: "background_job_steps_pk", columns: [t.jobId, t.key] }),
    check(
      "background_job_steps_mode",
      sql`${t.mode} IN ('transactional','provider-idempotent','reconcile')`
    ),
    check(
      "background_job_steps_state",
      sql`${t.state} IN ('pending','started','completed')`
    ),
    check(
      "background_job_steps_atomic",
      sql`${t.mode}<>'transactional' OR ${t.state}='completed'`
    ),
    check(
      "background_job_steps_deadline",
      sql`${t.mode}<>'provider-idempotent' OR ${t.state}<>'started' OR ${t.idempotencyUntil} IS NOT NULL`
    ),
  ]
)

export const backgroundJobRecoveries = pgTable("background_job_recoveries", {
  requestId: uuid("request_id").primaryKey(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => backgroundJobs.id),
  inputHash: text("input_hash").notNull(),
  operatorId: uuid("operator_id").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  step: text("step"),
  outcome: text("outcome"),
  evidence: text("evidence"),
  quiesced: boolean("quiesced").notNull().default(false),
  databaseRole: text("database_role")
    .notNull()
    .default(sql`session_user`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
})

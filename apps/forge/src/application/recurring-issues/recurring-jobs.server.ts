import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/neon-serverless"
import { z } from "zod"
import {
  parseFeatureRollouts,
  productFeatureMode,
} from "@forge/environment/product-features"
import { JobDeferred, JobError } from "../jobs/job-store"
import { runNextJob } from "../jobs/job-runner"
import { ApplicationAccessError } from "../authorization"
import { TemplateValidationError } from "../templates/template-forms"
import {
  generateOccurrence,
  recordSkipped,
  reserveOccurrence,
} from "./occurrences.server"
import type { PoolClient } from "@neondatabase/serverless"
import type { JobPool, JobSql, JobStore } from "../jobs/job-store"
import type { JobHandler } from "../jobs/job-runner"
import type { Transaction } from "@/db"
import {
  recurringIssueEvents,
  recurringIssueOccurrences,
  schema,
  teamRecurringIssues,
} from "@/db"
import { nextRecurrenceIndex, occurrenceAt } from "@/lib/recurrence-calendar"

export const RECURRING_JOB_KIND = "recurring-issue-v1"
function executor(client: JobSql) {
  // The runner owns BEGIN/COMMIT; this executor must stay on its fenced connection.
  return drizzle(client as PoolClient, { schema }) as unknown as Transaction
}
const enabled = (workspaceId: string) =>
  productFeatureMode("recurringIssues", workspaceId, process.env) === "enabled"

function enabledWorkspaces() {
  try {
    const rollout = parseFeatureRollouts(
      process.env.FORGE_FEATURE_ROLLOUTS
    ).recurringIssues
    return (rollout?.workspaceIds ?? []).filter(enabled)
  } catch {
    return []
  }
}

export async function dispatchRecurringOccurrences(
  pool: JobPool,
  store: JobStore
) {
  const workspaceIds = enabledWorkspaces()
  if (!workspaceIds.length) return 0
  const candidates = await pool.query(
    "SELECT id,workspace_id FROM team_recurring_issues WHERE workspace_id=ANY($1::text[]) AND state='active' AND next_at<=clock_timestamp() ORDER BY next_at,id LIMIT 100",
    [workspaceIds]
  )
  for (const candidate of candidates.rows) {
    if (!enabled(candidate.workspace_id)) continue
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SET LOCAL lock_timeout='5s'")
      await client.query("SET LOCAL statement_timeout='30s'")
      await client.query(
        "SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE",
        [candidate.workspace_id]
      )
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,4040))",
        [candidate.workspace_id]
      )
      const tx = executor(client)
      const [schedule] = await tx
        .select()
        .from(teamRecurringIssues)
        .where(eq(teamRecurringIssues.id, candidate.id))
        .for("update")
      const now = new Date(
        (await client.query("SELECT clock_timestamp() AS now")).rows[0].now
      )
      if (
        schedule?.state === "active" &&
        schedule.nextAt &&
        schedule.nextAt <= now &&
        enabled(schedule.workspaceId)
      ) {
        const nextIndex = nextRecurrenceIndex(
          schedule.payload,
          now,
          schedule.nextIndex
        )
        const skipped = await recordSkipped(
          tx,
          schedule,
          "downtime-latest-only",
          schedule.nextIndex,
          nextIndex - 2
        )
        await reserveOccurrence(tx, schedule, nextIndex - 1)
        await tx
          .update(teamRecurringIssues)
          .set({
            nextIndex,
            nextAt: occurrenceAt(schedule.payload, nextIndex),
            skippedCount: schedule.skippedCount + skipped,
            lastReason: skipped ? "downtime-latest-only" : schedule.lastReason,
          })
          .where(eq(teamRecurringIssues.id, schedule.id))
      }
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }
  const pending = await pool.query(
    "SELECT id,workspace_id,scheduled_at FROM recurring_issue_occurrences WHERE workspace_id=ANY($1::text[]) AND state='pending' AND job_id IS NULL ORDER BY created_at,id LIMIT 100",
    [workspaceIds]
  )
  let dispatched = 0
  for (const row of pending.rows) {
    if (!enabled(row.workspace_id)) continue
    const id = await store.enqueue({
      kind: RECURRING_JOB_KIND,
      scope: createHash("sha256").update(row.workspace_id).digest("hex"),
      identity: row.id,
      scheduledAt: new Date(row.scheduled_at),
      input: { occurrenceId: row.id, workspaceId: row.workspace_id },
    })
    await pool.query(
      "UPDATE recurring_issue_occurrences SET job_id=$2 WHERE id=$1 AND job_id IS NULL",
      [row.id, id]
    )
    dispatched++
  }
  return dispatched
}

export const recurringIssueJob: JobHandler = async (store, lease) => {
  const parsed = z
    .object({ occurrenceId: z.uuid(), workspaceId: z.string().min(1) })
    .strict()
    .safeParse(lease.input)
  if (!parsed.success) throw new JobError("INVALID_INPUT", true)
  const input = parsed.data
  if (!enabled(input.workspaceId)) throw new JobDeferred()
  await store.sqlStep(lease, "generate", async (client) => {
    await client.query(
      "SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE",
      [input.workspaceId]
    )
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,4040))",
      [input.workspaceId]
    )
    const tx = executor(client)
    const target = (
      await tx
        .select()
        .from(recurringIssueOccurrences)
        .where(
          and(
            eq(recurringIssueOccurrences.id, input.occurrenceId),
            eq(recurringIssueOccurrences.workspaceId, input.workspaceId)
          )
        )
    )[0]
    if (!target || target.state !== "pending") return { state: "settled" }
    const [schedule] = await tx
      .select()
      .from(teamRecurringIssues)
      .where(eq(teamRecurringIssues.id, target.scheduleId))
      .for("update")
    if (!enabled(input.workspaceId)) throw new JobDeferred()
    if (!schedule || schedule.state !== "active") {
      await tx
        .update(recurringIssueOccurrences)
        .set({ state: "skipped", reason: "schedule-inactive" })
        .where(eq(recurringIssueOccurrences.id, target.id))
      return { state: "skipped" }
    }
    await client.query("SAVEPOINT recurring_generation")
    try {
      const issueId = await generateOccurrence(
        tx,
        {
          userId: schedule.createdByUserId,
          workspaceId: schedule.workspaceId,
          workspaceRole: "",
          authentication: { kind: "recurring", scheduleId: schedule.id },
          scopes: [
            "issues:read",
            "issues:write",
            "projects:read",
            "teams:read",
          ],
        },
        target
      )
      await client.query("RELEASE SAVEPOINT recurring_generation")
      return { state: "created", issueId }
    } catch (error) {
      if (!(
        error instanceof ApplicationAccessError ||
        error instanceof TemplateValidationError ||
        error instanceof z.ZodError ||
        (error instanceof Error && error.constructor === Error)
      ))
        throw error
      await client.query("ROLLBACK TO SAVEPOINT recurring_generation")
      const reason =
        error instanceof ApplicationAccessError
          ? "owner-access-lost"
          : "template-invalid"
      await tx
        .update(teamRecurringIssues)
        .set({
          state: "paused",
          nextAt: null,
          lastReason: reason,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(teamRecurringIssues.id, schedule.id))
      const skipped = await tx
        .update(recurringIssueOccurrences)
        .set({ state: "skipped", reason })
        .where(
          and(
            eq(recurringIssueOccurrences.scheduleId, schedule.id),
            eq(recurringIssueOccurrences.state, "pending")
          )
        )
        .returning({ dueDate: recurringIssueOccurrences.dueDate })
      const dates = skipped.map((item) => item.dueDate).sort()
      await tx.insert(recurringIssueEvents).values({
        workspaceId: schedule.workspaceId,
        scheduleId: schedule.id,
        reason,
        count: skipped.length,
        fromDate: dates[0] ?? null,
        toDate: dates.at(-1) ?? null,
      })
      await tx
        .update(teamRecurringIssues)
        .set({ skippedCount: schedule.skippedCount + skipped.length })
        .where(eq(teamRecurringIssues.id, schedule.id))
      return { state: "paused", reason }
    }
  })
}
export async function runRecurringJobs(pool: JobPool, store: JobStore) {
  const dispatched = await dispatchRecurringOccurrences(pool, store)
  const results = []
  await store.reap(RECURRING_JOB_KIND)
  const scopes = enabledWorkspaces().map((workspaceId) =>
    createHash("sha256").update(workspaceId).digest("hex")
  )
  const pending = await pool.query(
    "SELECT id FROM background_jobs WHERE kind=$1 AND scope=ANY($2::text[]) AND state IN ('queued','retry') AND available_at<=clock_timestamp() ORDER BY available_at,id LIMIT 100",
    [RECURRING_JOB_KIND, scopes]
  )
  for (const job of pending.rows) {
    const result = await runNextJob(
      store,
      RECURRING_JOB_KIND,
      recurringIssueJob,
      job.id
    )
    if (result.state !== "idle") results.push(result)
  }
  if (results.some((result) => result.state !== "completed"))
    throw new JobError("JOB_FAILED")
  return { dispatched, results }
}

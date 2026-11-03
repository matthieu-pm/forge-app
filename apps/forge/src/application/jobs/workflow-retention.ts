import { JobError } from "./job-store"
import { runNextJob } from "./job-runner"
import type { JobHandler } from "./job-runner"
import type { JobStore } from "./job-store"

export const WORKFLOW_RETENTION_KIND = "workflow-retention-v1"
export const workflowRetention: JobHandler = async (store, lease) => {
  const input = lease.input as { cutoff?: unknown }
  if (
    !input ||
    typeof input.cutoff !== "string" ||
    !Number.isFinite(Date.parse(input.cutoff))
  )
    throw new JobError("INVALID_INPUT", true)
  for (let batch = 0; ; batch++) {
    await store.heartbeat(lease)
    const result = await store.sqlStep(lease, `batch:${batch}`, async (tx) => {
      const expired = await tx.query(
        `SELECT id FROM business_workflow_runs WHERE
          (state IN ('completed','failed','cancelled') AND completed_at<$1::timestamptz)
          OR (state='failed-to-start' AND updated_at<$1::timestamptz)
        ORDER BY id LIMIT 500 FOR UPDATE`,
        [input.cutoff]
      )
      if (!expired.rows.length) return { deleted: 0 }
      const deleted = await tx.query(
        `DELETE FROM business_workflow_runs WHERE id=ANY($1::uuid[]) AND (
          (state IN ('completed','failed','cancelled') AND completed_at<$2::timestamptz)
          OR (state='failed-to-start' AND updated_at<$2::timestamptz)) RETURNING id`,
        [expired.rows.map((row) => row.id), input.cutoff]
      )
      return { deleted: deleted.rows.length }
    })
    if (result.deleted === 0) return
  }
}

export async function enqueueWorkflowRetention(
  store: JobStore,
  now = new Date()
) {
  const scheduledAt = new Date(now)
  scheduledAt.setUTCHours(0, 0, 0, 0)
  return store.enqueue({
    kind: WORKFLOW_RETENTION_KIND,
    scope: "global",
    identity: scheduledAt.toISOString().slice(0, 10),
    scheduledAt,
    input: {
      cutoff: new Date(scheduledAt.getTime() - 90 * 86400000).toISOString(),
    },
  })
}

export async function runWorkflowRetention(store: JobStore, now = new Date()) {
  const id = await enqueueWorkflowRetention(store, now)
  // Drain older retryable occurrences too; duplicate ticks never invent new identities.
  for (let n = 0; n < 20; n++) {
    const result = await runNextJob(
      store,
      WORKFLOW_RETENTION_KIND,
      workflowRetention
    )
    if (result.state === "idle") break
    if (result.state !== "completed") throw new JobError("JOB_FAILED")
  }
  if ((await store.inspect(id)).jobs[0]?.state !== "completed")
    throw new JobError("JOB_FAILED")
}

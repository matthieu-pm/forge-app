import { createHash } from "node:crypto"
import { JobDeferred, JobError } from "../jobs/job-store"
import { runNextJob } from "../jobs/job-runner"
import { slaGate } from "./sla-gate"
import type { JobPool, JobSql, JobStore } from "../jobs/job-store"
import type { JobHandler } from "../jobs/job-runner"

export const SLA_JOB_KIND = "sla-breach-v1"
/** The intent is committed with the issue. Enqueue/replay is idempotent after any crash. */
export async function dispatchSlaIntents(pool: JobSql, store: JobStore) {
  const pending =
    await pool.query(`SELECT g.id,g.workspace_id,g.deadline_at::text AS deadline
    FROM issue_sla_intents i JOIN issue_slas g ON g.id=i.commitment_id
    WHERE i.job_id IS NULL ORDER BY i.created_at,g.id LIMIT 100`)
  for (const row of pending.rows) {
    const id = await store.enqueue({
      kind: SLA_JOB_KIND,
      scope: createHash("sha256").update(row.workspace_id).digest("hex"),
      identity: row.id,
      scheduledAt: new Date(row.deadline),
      input: {
        commitmentId: row.id,
        workspaceId: row.workspace_id,
        deadline: row.deadline,
      },
    })
    await pool.query(
      "UPDATE issue_sla_intents SET job_id=$2 WHERE commitment_id=$1 AND job_id IS NULL",
      [row.id, id]
    )
  }
  return pending.rows.length
}
async function lockSla(tx: JobSql, commitmentId: string, workspaceId: string) {
  const workspace = await tx.query(
    "SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE",
    [workspaceId]
  )
  if (!workspace.rows.length) return null
  const target = await tx.query(
    "SELECT issue_id FROM issue_slas WHERE id=$1 AND workspace_id=$2",
    [commitmentId, workspaceId]
  )
  if (!target.rows.length) return null
  const issue = await tx.query(
    "SELECT id,purged_at FROM issues WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
    [target.rows[0].issue_id, workspaceId]
  )
  if (!issue.rows.length || issue.rows[0].purged_at) return null
  await tx.query(
    "SELECT workspace_id FROM sla_policies WHERE workspace_id=$1 FOR SHARE",
    [workspaceId]
  )
  const gate = slaGate(workspaceId)
  await tx.query(
    "SELECT set_config('forge.sla.workspace',$1,true),set_config('forge.sla.enabled',$2,true),set_config('forge.sla.identity',$3,true)",
    [workspaceId, gate.enabled ? "on" : "off", gate.identity]
  )
  await tx.query("SELECT forge_sla_touch($1,clock_timestamp())", [commitmentId])
  const state = (
    await tx.query(
      `SELECT g.*,coalesce((p.values->>'enabled')::boolean,false) AS policy_enabled,
    EXISTS(SELECT 1 FROM issue_sla_events e WHERE e.commitment_id=g.id AND e.kind='breached') AS breached,
    g.state='completed' AND g.completed_at>clock_timestamp()-interval '720 hours' AS can_reopen
    FROM issue_slas g LEFT JOIN sla_policies p ON p.workspace_id=g.workspace_id WHERE g.id=$1 FOR UPDATE OF g`,
      [commitmentId]
    )
  ).rows[0]
  return { gate, state }
}
export const slaBreachJob: JobHandler = async (store, lease) => {
  const input = lease.input as { commitmentId?: unknown; workspaceId?: unknown }
  if (
    !input ||
    typeof input.commitmentId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(input.commitmentId) ||
    typeof input.workspaceId !== "string"
  )
    throw new JobError("INVALID_INPUT", true)
  const { commitmentId, workspaceId } = input
  const observedGate = slaGate(workspaceId)
  // Preserve observation/owed metadata through a deliberate deferral. This is a
  // separate transactional checkpoint; the breach checkpoint is never recorded
  // until its visible effect or a definitive closed outcome commits.
  await store.sqlStep(
    lease,
    `gate:${observedGate.identity}:${observedGate.enabled}`,
    async (tx) => ({
      present: Boolean(await lockSla(tx, commitmentId, workspaceId)),
    })
  )
  await store.sqlStep(lease, "breach", async (tx) => {
    const locked = await lockSla(tx, commitmentId, workspaceId)
    if (!locked) return { state: "gone" }
    const { gate, state } = locked
    if (
      !gate.enabled ||
      !state.policy_enabled ||
      (state.gate_uncertain && state.owed_at)
    )
      throw new JobDeferred()
    const emitted = (
      await tx.query(
        "SELECT forge_sla_breach($1,clock_timestamp()) AS emitted",
        [commitmentId]
      )
    ).rows[0].emitted
    if (
      !emitted &&
      !state.breached &&
      ((state.state === "running" && state.current) || state.can_reopen)
    )
      throw new JobDeferred()
    return { state: emitted || state.breached ? "breached" : "closed" }
  })
}
export async function runSlaJobs(pool: JobPool, store: JobStore) {
  const dispatched = await dispatchSlaIntents(pool, store)
  const results = []
  for (let n = 0; n < 20; n++) {
    const result = await runNextJob(store, SLA_JOB_KIND, slaBreachJob)
    if (result.state === "idle") break
    results.push(result)
  }
  return { dispatched, results }
}

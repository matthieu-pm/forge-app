import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import {
  parseFeatureRollouts,
  productFeatureMode,
} from "@forge/environment/product-features"
import {
  addCycleDays,
  cycleToday,
  nextCycleDate,
} from "../../lib/cycle-calendar"
import {
  parseTeamCycles,
  teamCyclesStorageKey,
} from "../../lib/team-cycles-contract"
import { JobDeferred, JobError } from "../jobs/job-store"
import { runNextJob } from "../jobs/job-runner"
import { slaGate } from "../sla/sla-gate"
import type { JobSql, JobStore } from "../jobs/job-store"
import type { JobHandler } from "../jobs/job-runner"

export const CYCLE_ROLLOVER_KIND = "cycle-rollover-v1"
export const cycleRolloverEnabled = (workspaceId: string) =>
  productFeatureMode("cycleRollover", workspaceId, process.env) === "enabled"

export async function dispatchCycleRollovers(pool: JobSql, store: JobStore) {
  const rollouts = parseFeatureRollouts(process.env.FORGE_FEATURE_ROLLOUTS)
  const workspaceIds =
    rollouts.cycleRollover?.mode === "enabled"
      ? rollouts.cycleRollover.workspaceIds
      : []
  if (!workspaceIds.length) return 0
  await pool.query(
    `INSERT INTO cycle_rollover_teams(workspace_id,team_id)
    SELECT t.workspace_id,t.id FROM teams t JOIN product_state p
    ON p.workspace_id=t.workspace_id AND p.owner_id='workspace'
    AND p.key='forge:team-cycles:v1:'||t.id::text
    WHERE t.workspace_id=ANY($1::text[]) AND (p.encoded_value::jsonb #>> '{}')::jsonb->>'enabled'='true'
    ON CONFLICT DO NOTHING`,
    [workspaceIds]
  )
  const due = await pool.query(
    `SELECT c.id,c.workspace_id,c.team_id,
    ((c.end_date::date+1)::timestamp AT TIME ZONE c.timezone) AS due
    FROM issue_cycles c JOIN cycle_rollover_teams e ON e.team_id=c.team_id AND e.workspace_id=c.workspace_id
    WHERE c.workspace_id=ANY($1::text[])
    AND ((c.end_date::date+1)::timestamp AT TIME ZONE c.timezone)>e.enabled_at
    AND c.end_date < (clock_timestamp() AT TIME ZONE c.timezone)::date::text
    AND NOT EXISTS(SELECT 1 FROM cycle_closures x WHERE x.cycle_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM background_jobs j WHERE j.kind=$2 AND j.scope=c.team_id::text AND j.identity=c.id::text)
    ORDER BY c.end_date,c.team_id,c.id LIMIT 100`,
    [workspaceIds, CYCLE_ROLLOVER_KIND]
  )
  for (const row of due.rows)
    await store.enqueue({
      kind: CYCLE_ROLLOVER_KIND,
      scope: row.team_id,
      identity: row.id,
      scheduledAt: new Date(row.due),
      input: {
        workspaceId: row.workspace_id,
        teamId: row.team_id,
        cycleId: row.id,
      },
    })
  return due.rows.length
}

const rolloverInputSchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
    teamId: z.uuid(),
    cycleId: z.uuid(),
  })
  .strict()
type RolloverInput = z.infer<typeof rolloverInputSchema>

export async function closeCycle(tx: JobSql, input: RolloverInput) {
  const { workspaceId, teamId, cycleId } = input
  if (!cycleRolloverEnabled(workspaceId)) throw new JobDeferred()
  const workspace = await tx.query(
    "SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE",
    [workspaceId]
  )
  if (!workspace.rows.length) return { state: "gone" }
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,4040)),forge_lock_issue_graph($1)",
    [workspaceId]
  )
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,4055))", [
    teamId,
  ])
  const cycle = (
    await tx.query(
      `SELECT c.*,clock_timestamp() AS now,
    (clock_timestamp() AT TIME ZONE c.timezone)::date::text AS today,
    ((c.end_date::date+1)::timestamp AT TIME ZONE c.timezone)>e.enabled_at AS eligible
    FROM issue_cycles c JOIN cycle_rollover_teams e ON e.team_id=c.team_id AND e.workspace_id=c.workspace_id
    WHERE c.id=$1 AND c.workspace_id=$2 AND c.team_id=$3`,
      [cycleId, workspaceId, teamId]
    )
  ).rows[0]
  if (!cycle) return { state: "gone" }
  if (
    (
      await tx.query("SELECT cycle_id FROM cycle_closures WHERE cycle_id=$1", [
        cycleId,
      ])
    ).rows.length
  )
    return { state: "closed" }
  if (!cycle.eligible) return { state: "excluded" }
  if (cycle.end_date >= cycle.today) throw new JobDeferred()
  const config = (
    await tx.query(
      `SELECT encoded_value FROM product_state
    WHERE workspace_id=$1 AND owner_id='workspace' AND key=$2 FOR SHARE`,
      [workspaceId, teamCyclesStorageKey(teamId)]
    )
  ).rows[0]
  if (!config?.encoded_value) throw new JobDeferred()
  const settings = parseTeamCycles(JSON.parse(config.encoded_value))
  if (!settings.enabled) throw new JobDeferred()
  // Lock the latest canonical rows before snapshotting. The checkpoint, membership,
  // revisions, receipt, audit and outbox all commit on this same job connection.
  await tx.query(
    `SELECT id FROM issues WHERE workspace_id=$1 AND team_id=$2 AND cycle_id=$3
    AND archived_at IS NULL AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
    [workspaceId, teamId, cycleId]
  )
  const unfinished = Number(
    (
      await tx.query(
        `SELECT count(*) AS count FROM issues i JOIN issue_statuses s
    ON s.workspace_id=i.workspace_id AND s.team_id=i.team_id AND s.id=i.status_id
    WHERE i.workspace_id=$1 AND i.team_id=$2 AND i.cycle_id=$3 AND i.archived_at IS NULL AND i.deleted_at IS NULL
    AND s.status_group NOT IN ('completed','canceled','duplicate')`,
        [workspaceId, teamId, cycleId]
      )
    ).rows[0].count
  )
  const carryover = settings.carryover ?? true
  let target: string | null = null
  if (carryover && unfinished) {
    const next = (
      await tx.query(
        `SELECT id FROM issue_cycles c WHERE workspace_id=$1 AND team_id=$2
      AND start_date>$3 AND end_date >= (clock_timestamp() AT TIME ZONE c.timezone)::date::text
      AND NOT EXISTS(SELECT 1 FROM cycle_closures x WHERE x.cycle_id=c.id) ORDER BY start_date LIMIT 1`,
        [workspaceId, teamId, cycle.end_date]
      )
    ).rows[0]
    target = next?.id ?? null
    if (!target) {
      const latest = (
        await tx.query(
          "SELECT end_date FROM issue_cycles WHERE team_id=$1 ORDER BY start_date DESC LIMIT 1",
          [teamId]
        )
      ).rows[0]
      const timezone = settings.timezone ?? cycle.timezone
      const today = cycleToday(timezone, new Date(cycle.now))
      let start = nextCycleDate(
        addCycleDays(latest.end_date, settings.cooldown * 7 + 1),
        settings.startDay,
        false
      )
      if (start <= today) start = nextCycleDate(today, settings.startDay)
      target = (
        await tx.query(
          `INSERT INTO issue_cycles(workspace_id,team_id,start_date,end_date,timezone)
        VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [
            workspaceId,
            teamId,
            start,
            addCycleDays(start, settings.duration * 7 - 1),
            timezone,
          ]
        )
      ).rows[0].id
    }
  }
  await tx.query(
    `INSERT INTO cycle_closures(workspace_id,team_id,cycle_id,target_cycle_id,carryover,closed_at)
    VALUES($1,$2,$3,$4,$5,clock_timestamp())`,
    [workspaceId, teamId, cycleId, target, carryover]
  )
  await tx.query(
    `INSERT INTO cycle_membership_history(workspace_id,team_id,cycle_id,issue_id,issue_revision,status_group,carried)
    SELECT i.workspace_id,i.team_id,i.cycle_id,i.id,i.revision,s.status_group,
      $4::uuid IS NOT NULL AND s.status_group NOT IN ('completed','canceled','duplicate')
    FROM issues i JOIN issue_statuses s ON s.workspace_id=i.workspace_id AND s.team_id=i.team_id AND s.id=i.status_id
    WHERE i.workspace_id=$1 AND i.team_id=$2 AND i.cycle_id=$3 AND i.archived_at IS NULL AND i.deleted_at IS NULL`,
    [workspaceId, teamId, cycleId, target]
  )
  const gate = slaGate(workspaceId)
  await tx.query(
    "SELECT set_config('forge.sla.workspace',$1,true),set_config('forge.sla.enabled',$2,true),set_config('forge.sla.identity',$3,true)",
    [workspaceId, gate.enabled ? "on" : "off", gate.identity]
  )
  const moved = await tx.query(
    `UPDATE issues i SET cycle_id=$4::uuid,
    properties=jsonb_set(i.properties,'{cycle}',to_jsonb($4::text),true)
    FROM cycle_membership_history h WHERE h.cycle_id=$3 AND h.carried AND h.issue_id=i.id
    AND i.workspace_id=$1 AND i.team_id=$2 AND i.cycle_id=$3 AND i.revision=h.issue_revision
    RETURNING i.id`,
    [workspaceId, teamId, cycleId, target]
  )
  if (moved.rows.length !== (target ? unfinished : 0))
    throw new JobError("JOB_FAILED")
  const commandId = randomUUID()
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex")
  await tx.query(
    `INSERT INTO command_receipts(id,workspace_id,user_id,principal,operation,command_key,input_hash,
    response_body,response_status,resource_type,resource_id,completed_at)
    VALUES($1,$2,'system:cycle-rollover','system:cycle-rollover','cycles.close@1',$3,$4,$5,200,'cycle',$3,clock_timestamp())`,
    [
      commandId,
      workspaceId,
      cycleId,
      hash,
      JSON.stringify({
        cycleId,
        targetCycleId: target,
        carried: moved.rows.length,
      }),
    ]
  )
  await tx.query(
    `INSERT INTO command_audit_events(workspace_id,command_id,actor_user_id,operation,resource_type,resource_id)
    VALUES($1,$2,'system:cycle-rollover','cycles.close@1','cycle',$3)`,
    [workspaceId, commandId, cycleId]
  )
  await tx.query(
    `INSERT INTO command_outbox_events(workspace_id,command_id,ordinal,topic,payload,created_at)
    SELECT $1,$2,(row_number() OVER(ORDER BY issue_id)-1)::int,'issue.cycle.carried',
    jsonb_build_object('issueId',issue_id,'teamId',team_id,'history',jsonb_build_object('version',1,'origin','system',
      'actor',jsonb_build_object('userId','system:cycle-rollover','name','Forge cycles','kind','system'),
      'changes',jsonb_build_array(jsonb_build_object('field','cycle','from',$3::text,'to',$4::text)))),clock_timestamp()
    FROM cycle_membership_history WHERE cycle_id=$3::uuid AND carried`,
    [workspaceId, commandId, cycleId, target]
  )
  return { state: "closed", carried: moved.rows.length }
}

export const cycleRollover: JobHandler = async (store, lease) => {
  const parsed = rolloverInputSchema.safeParse(lease.input)
  if (!parsed.success) throw new JobError("INVALID_INPUT", true)
  const input = parsed.data
  if (!cycleRolloverEnabled(input.workspaceId)) throw new JobDeferred()
  await store.sqlStep(lease, "close", (tx) => closeCycle(tx, input))
}

export async function runCycleRollovers(pool: JobSql, store: JobStore) {
  const dispatched = await dispatchCycleRollovers(pool, store)
  const results = []
  for (let n = 0; n < 20; n++) {
    const result = await runNextJob(store, CYCLE_ROLLOVER_KIND, cycleRollover)
    if (result.state === "idle") break
    results.push(result)
  }
  return { dispatched, results }
}

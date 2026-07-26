import { resolve } from "node:path"
import { config } from "dotenv"

import { and, eq, inArray, isNull, lte } from "drizzle-orm"

const packageRoot = resolve(import.meta.dirname, "..")
const repositoryRoot = resolve(packageRoot, "../..")
config({ path: resolve(repositoryRoot, ".env") })
config({ path: resolve(repositoryRoot, ".env.local"), override: true })

const { businessWorkflowEffects, businessWorkflowRuns, db } =
  await import("@/db")

const now = new Date()
const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1_000)
const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1_000)
const reminderDeadline = new Date(now.getTime() - (24 * 60 + 15) * 60 * 1_000)
const issues: Array<{
  code: string
  businessRunId: string
  state: string
}> = []

const missingSdkRuns = await db
  .select({ id: businessWorkflowRuns.id, state: businessWorkflowRuns.state })
  .from(businessWorkflowRuns)
  .where(
    and(
      isNull(businessWorkflowRuns.sdkRunId),
      inArray(businessWorkflowRuns.state, ["queued", "starting"]),
      lte(businessWorkflowRuns.createdAt, fiveMinutesAgo)
    )
  )
for (const run of missingSdkRuns) {
  issues.push({
    code: "sdk_run_id_missing_5m",
    businessRunId: run.id,
    state: run.state,
  })
}

const terminalRuns = await db
  .select({ id: businessWorkflowRuns.id, state: businessWorkflowRuns.state })
  .from(businessWorkflowRuns)
  .where(
    inArray(businessWorkflowRuns.state, [
      "failed-to-start",
      "failed",
      "cancelled",
    ])
  )
for (const run of terminalRuns) {
  issues.push({
    code: "terminal_workflow_failure",
    businessRunId: run.id,
    state: run.state,
  })
}

const runningInvitations = await db
  .select({
    id: businessWorkflowRuns.id,
    state: businessWorkflowRuns.state,
    startedAt: businessWorkflowRuns.startedAt,
  })
  .from(businessWorkflowRuns)
  .where(
    and(
      eq(businessWorkflowRuns.kind, "workspace-invitation-lifecycle-v1"),
      eq(businessWorkflowRuns.state, "running")
    )
  )
if (runningInvitations.length > 0) {
  const effects = await db
    .select({
      businessRunId: businessWorkflowEffects.businessRunId,
      effectKey: businessWorkflowEffects.effectKey,
      state: businessWorkflowEffects.state,
      completedAt: businessWorkflowEffects.completedAt,
    })
    .from(businessWorkflowEffects)
    .where(
      inArray(
        businessWorkflowEffects.businessRunId,
        runningInvitations.map(({ id }) => id)
      )
    )

  for (const run of runningInvitations) {
    const runEffects = effects.filter(
      ({ businessRunId }) => businessRunId === run.id
    )
    const initial = runEffects.find(({ effectKey }) =>
      effectKey.includes(":initial:")
    )
    if (
      run.startedAt &&
      run.startedAt <= fifteenMinutesAgo &&
      initial?.state !== "completed"
    ) {
      issues.push({
        code: "initial_effect_incomplete_15m",
        businessRunId: run.id,
        state: run.state,
      })
      continue
    }

    const reminder = runEffects.find(({ effectKey }) =>
      effectKey.includes(":reminder-24h:")
    )
    if (
      initial?.completedAt &&
      initial.completedAt <= reminderDeadline &&
      reminder?.state !== "completed"
    ) {
      issues.push({
        code: "reminder_overdue_15m",
        businessRunId: run.id,
        state: run.state,
      })
    }
  }
}

console.log(
  JSON.stringify({
    event: "workflow.health",
    checkedAt: now.toISOString(),
    healthy: issues.length === 0,
    issues,
  })
)
if (issues.length > 0) process.exitCode = 1

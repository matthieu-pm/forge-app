import { runMonitoredJob } from "./lib/monitored-job"
import { and, eq, inArray, isNull, lte } from "drizzle-orm"
import { emitTelemetry } from "../../../packages/telemetry/server"
import { validateJobEnvironment } from "./lib/script-environment"

validateJobEnvironment("workflow-health")

await runMonitoredJob("workflow.health", async () => {
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
    .select({
      id: businessWorkflowRuns.id,
      state: businessWorkflowRuns.state,
      createdAt: businessWorkflowRuns.createdAt,
    })
    .from(businessWorkflowRuns)
    .where(
      and(
        isNull(businessWorkflowRuns.sdkRunId),
        inArray(businessWorkflowRuns.state, ["queued", "starting"]),
        lte(businessWorkflowRuns.createdAt, fiveMinutesAgo)
      )
    )
  for (const run of missingSdkRuns) {
    emitTelemetry("job.health", "workflow.health", {
      businessRunId: run.id,
      queueAgeMs: Math.max(0, now.getTime() - run.createdAt.getTime()),
    })
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

  for (const issue of issues) {
    emitTelemetry("operation.failed", "workflow.health", {
      businessRunId: issue.businessRunId,
      errorCode: "WORKFLOW_EXECUTION_FAILED",
    })
  }
  emitTelemetry("job.health", "workflow.health", {
    failures: issues.length,
    count: missingSdkRuns.length,
  })
  if (issues.length > 0) process.exitCode = 1
})

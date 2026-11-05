import { JobError } from "./job-store"
import { runNextJob } from "./job-runner"
import {
  WORKFLOW_RETENTION_KIND,
  enqueueWorkflowRetention,
  workflowRetention,
} from "./workflow-retention"
import type { JobStore, Recovery } from "./job-store"

export async function jobCommand(store: JobStore, args: Array<string>) {
  const [action, id, ...rest] = args
  if (action === "run-cycles" && args.length === 1) {
    const { runCycleRollovers } = await import("../cycles/cycle-rollover")
    const { databaseClient } = await import("@/db")
    return runCycleRollovers(databaseClient, store)
  }
  if (action === "run-recurring" && args.length === 1) {
    const { runRecurringJobs } =
      await import("../recurring-issues/recurring-jobs.server")
    const { databaseClient } = await import("@/db")
    return runRecurringJobs(databaseClient, store)
  }
  if (
    (action === "activate-inbox" || action === "run-inbox") &&
    args.length === 1
  ) {
    const { activateInbox, runInbox } =
      await import("../inbox/inbox-delivery.server")
    const { databaseClient } = await import("@/db")
    return action === "activate-inbox"
      ? activateInbox(databaseClient)
      : runInbox(databaseClient)
  }
  if (action === "run-sla" && args.length === 1) {
    const { runSlaJobs } = await import("../sla/sla-jobs")
    const { databaseClient } = await import("@/db")
    return runSlaJobs(databaseClient, store)
  }
  if (action === "list" && args.length === 1) return store.inspect()
  if (action === "inspect" && id && !rest.length) {
    const result = await store.inspect(id)
    return {
      ...result,
      recovery: result.jobs.map((job) => ({
        id: job.id,
        guidance:
          job.state === "reconcile"
            ? "Reconcile started external steps against provider records; resolve each, then replay."
            : job.state === "dead"
              ? "Fix the dependency or handler, then replay this same job. Checkpoints are retained."
              : job.state === "running"
                ? "Wait for the live owner or reap an expired lease. Never clear a live lease."
                : "No operator recovery required.",
        command: ["dead", "reconcile"].includes(job.state)
          ? `bun run jobs replay ${job.id} --generation ${job.generation} --request <uuid> --operator <uuid> --reason code-fixed`
          : null,
      })),
    }
  }
  if (action === "reap" && args.length === 1) {
    const result = await store.reap()
    return { recovered: result.rows }
  }
  if (action === "schedule-retention" && args.length === 1)
    return { id: await enqueueWorkflowRetention(store) }
  if (action === "run" && (args.length === 1 || (args.length === 2 && id)))
    return runNextJob(store, WORKFLOW_RETENTION_KIND, workflowRetention, id)
  if ((action !== "replay" && action !== "resolve") || !id || rest.length % 2)
    throw new JobError("INVALID_INPUT")
  const options = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    if (
      ![
        "--generation",
        "--request",
        "--operator",
        "--reason",
        "--step",
        "--outcome",
        "--quiesced",
        "--evidence",
      ].includes(rest[i]) ||
      options.has(rest[i])
    )
      throw new JobError("INVALID_INPUT")
    options.set(rest[i], rest[i + 1])
  }
  if (action === "resolve" && options.get("--quiesced") !== "true")
    throw new JobError("INVALID_INPUT")
  const base = {
    jobId: id,
    generation: Number(options.get("--generation")),
    requestId: options.get("--request") ?? "",
    operatorId: options.get("--operator") ?? "",
    reason: options.get("--reason") as Recovery["reason"],
  }
  if (
    action === "replay" &&
    (options.has("--step") ||
      options.has("--outcome") ||
      options.has("--quiesced") ||
      options.has("--evidence"))
  )
    throw new JobError("INVALID_INPUT")
  return store.recover(
    action === "replay"
      ? { ...base, action }
      : {
          ...base,
          action,
          step: options.get("--step") ?? "",
          outcome: options.get("--outcome") as "completed" | "retry-safe",
          quiesced: true,
          evidence: options.get("--evidence") ?? "",
        }
  )
}

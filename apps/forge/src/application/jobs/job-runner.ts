import {
  emitTelemetry,
  withCorrelation,
} from "../../../../../packages/telemetry/server"
import { JobDeferred, JobError } from "./job-store"
import type { JobLease, JobStore } from "./job-store"

export type JobHandler = (store: JobStore, lease: JobLease) => Promise<void>

export async function runNextJob(
  store: JobStore,
  kind: string,
  handler: JobHandler,
  id?: string
) {
  const lease = await store.claim(kind, id)
  if (!lease) return { state: "idle" as const }
  return withCorrelation({ jobId: lease.id }, async () => {
    emitTelemetry("lease.acquired", "jobs.run", {
      attempt: lease.attempt,
      queueAgeMs: lease.queueAgeMs,
    })
    try {
      await handler(store, lease)
      await store.complete(lease)
      emitTelemetry("operation.completed", "jobs.run", {
        attempt: lease.attempt,
      })
      return { state: "completed" as const, id: lease.id }
    } catch (error) {
      if (error instanceof JobDeferred) {
        try {
          await store.defer(lease)
          return { state: "deferred" as const, id: lease.id }
        } catch (failure) {
          if (failure instanceof JobError && failure.code === "LEASE_LOST")
            return { state: "lost" as const, id: lease.id }
          throw failure
        }
      }
      if (error instanceof JobError && error.code === "LEASE_LOST") {
        emitTelemetry("operation.rejected", "jobs.run", {
          errorCode: "JOB_LEASE_LOST",
        })
        return { state: "lost" as const, id: lease.id }
      }
      try {
        const state = await store.fail(lease, error)
        emitTelemetry("operation.failed", "jobs.run", {
          errorCode:
            state === "reconcile"
              ? "JOB_RECONCILIATION_REQUIRED"
              : "JOB_FAILED",
          attempt: lease.attempt,
          failures: 1,
        })
        return { state, id: lease.id }
      } catch (failure) {
        if (failure instanceof JobError && failure.code === "LEASE_LOST")
          return { state: "lost" as const, id: lease.id }
        throw new JobError("JOB_FAILED")
      }
    }
  })
}

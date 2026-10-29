import { and, eq, inArray, isNotNull } from "drizzle-orm"
import { emitTelemetry } from "../../../packages/telemetry/server"
import { runMonitoredJob } from "./lib/monitored-job"
import { validateJobEnvironment } from "./lib/script-environment"

validateJobEnvironment("calls-sync")

await runMonitoredJob("calls.sync", async () => {
  const { db, callConnections, calls } = await import("@/db")
  const { syncCallConnection, generateCallSummary, sweepCallTranscripts } =
    await import("@/application/calls/calls.server")
  let failures = 0
  let imported = 0
  const expired = await sweepCallTranscripts()
  const connections = await db
    .select({
      id: callConnections.id,
      syncLeaseAt: callConnections.syncLeaseAt,
    })
    .from(callConnections)
    .where(isNotNull(callConnections.secret))
  for (const connection of connections) {
    if (connection.syncLeaseAt)
      emitTelemetry("job.health", "calls.sync", {
        leaseAgeMs: Math.max(0, Date.now() - connection.syncLeaseAt.getTime()),
      })
    try {
      imported += await syncCallConnection(connection.id)
    } catch {
      failures++
    }
  }
  const pending = await db
    .select({
      id: calls.id,
      summaryLeaseAt: calls.summaryLeaseAt,
    })
    .from(calls)
    .where(
      and(
        eq(calls.status, "ready"),
        inArray(calls.summaryStatus, ["pending", "error"])
      )
    )
  emitTelemetry("job.health", "calls.summary", { count: pending.length })
  // Failed summaries retry on the next run; successfully summarized calls are no-ops.
  for (const call of pending) {
    emitTelemetry("job.health", "calls.summary", {
      ...(call.summaryLeaseAt
        ? {
            leaseAgeMs: Math.max(0, Date.now() - call.summaryLeaseAt.getTime()),
          }
        : {}),
    })
    try {
      await generateCallSummary(call.id)
    } catch {
      failures++
    }
  }
  emitTelemetry("job.health", "calls.sync", {
    count: imported + expired,
    failures,
  })
  process.exitCode = failures ? 1 : 0
})

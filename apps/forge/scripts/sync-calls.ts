import { and, eq, inArray, isNotNull } from "drizzle-orm"
import { validateJobEnvironment } from "./lib/script-environment"

validateJobEnvironment("calls-sync")
const { db, callConnections, calls } = await import("@/db")
const { syncCallConnection, generateCallSummary, sweepCallTranscripts } =
  await import("@/application/calls/calls.server")
let failures = 0
let imported = 0
const expired = await sweepCallTranscripts()
const connections = await db
  .select({ id: callConnections.id })
  .from(callConnections)
  .where(isNotNull(callConnections.secret))
for (const connection of connections) {
  try {
    imported += await syncCallConnection(connection.id)
  } catch {
    failures++
  }
}
const pending = await db
  .select({ id: calls.id })
  .from(calls)
  .where(
    and(
      eq(calls.status, "ready"),
      inArray(calls.summaryStatus, ["pending", "error"])
    )
  )
// Failed summaries retry on the next run; successfully summarized calls are no-ops.
for (const call of pending) {
  try {
    await generateCallSummary(call.id)
  } catch {
    failures++
  }
}
console.log(
  JSON.stringify({ event: "calls.sync", imported, expired, failures })
)
process.exitCode = failures ? 1 : 0

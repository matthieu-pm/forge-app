import { runJob } from "../../../../packages/telemetry/server"
import { monitorStore } from "../../src/application/operations/monitor-store"
import type { JobName } from "../../src/application/operations/monitor"

export async function runMonitoredJob(key: JobName, run: () => Promise<void>) {
  return runJob(key, async () => {
    const { databaseClient } = await import("@/db")
    const store = monitorStore(databaseClient)
    try {
      await run()
      await store.heartbeat(key, !process.exitCode)
    } catch {
      await store.heartbeat(key, false)
      throw new Error("Scheduled operation failed.")
    }
  })
}

import "@tanstack/react-start/server-only"
import { sql } from "drizzle-orm"
import { observeOperation } from "../../../../../packages/telemetry/server"
import { purgeDeletedIssues } from "./purge-issues.server"
import { createFileBlobStore } from "@/adapters/files/file-blob-store.server"
import { databaseClient, db } from "@/db"
import { monitorStore } from "@/application/operations/monitor-store"

export async function runIssueRetention() {
  return observeOperation("issues.retention", async () => {
    const store = monitorStore(databaseClient)
    try {
      const result = await purgeDeletedIssues(createFileBlobStore(), 1)
      const pending = await db.execute<{ pending: boolean }>(
        sql`SELECT EXISTS(SELECT 1 FROM issues WHERE deleted_at+interval '720 hours'<=clock_timestamp() AND purged_at IS NULL) pending`
      )
      await store.heartbeat("issues.retention", result.failed === 0)
      return { ...result, pending: pending.rows[0].pending }
    } catch {
      await store.heartbeat("issues.retention", false)
      throw new Error("Issue retention failed.")
    }
  })
}

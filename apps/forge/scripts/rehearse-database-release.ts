import { Pool, neonConfig } from "@neondatabase/serverless"
import {
  applyRehearsalRelease,
  backfillRehearsalChunk,
  cleanupRehearsal,
  retireRehearsalReaders,
} from "../src/application/operations/database-release-rehearsal"
import { assertIsolatedTestConnection } from "./lib/isolated-test-database"

const [action, runId] = process.argv.slice(2)
if (
  !["prior", "expand", "backfill", "retire", "contract", "cleanup"].includes(
    action
  ) ||
  !runId
)
  throw new Error(
    "Use db:rehearse prior|expand|backfill|retire|contract|cleanup <run-uuid> [batch-size]."
  )
const connection = process.env.FORGE_FIXTURE_DATABASE_URL
if (!connection)
  throw new Error("Explicit FORGE_FIXTURE_DATABASE_URL is required.")
assertIsolatedTestConnection(connection)
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: connection, max: 1 })
const client = await pool.connect()
try {
  const result =
    action === "backfill"
      ? await backfillRehearsalChunk(
          client,
          runId,
          Number(process.argv[4] ?? 2)
        )
      : action === "retire"
        ? await retireRehearsalReaders(client, runId)
        : action === "cleanup"
          ? await cleanupRehearsal(client, runId)
          : await applyRehearsalRelease(
              client,
              runId,
              action as "prior" | "expand" | "contract"
            )
  console.log(JSON.stringify({ action, runId, result }))
} catch {
  console.error(
    "Database release rehearsal failed; inspect the run journal and checkpoint on the verified staging target before retrying. Details are redacted."
  )
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}

import { Pool, neonConfig } from "@neondatabase/serverless"
import { assertIsolatedTestConnection } from "./lib/isolated-test-database"
import { manageIntegrationFixtures } from "./lib/integration-fixtures"

// Do not read/fall back to local app credentials. Bun may load .env but only this explicit key is used.
const connection = process.env.FORGE_FIXTURE_DATABASE_URL
const [action, runId] = process.argv.slice(2)
if (!connection || !["seed", "cleanup"].includes(action) || !runId)
  throw new Error(
    "Use FORGE_FIXTURE_DATABASE_URL with integration:fixtures seed|cleanup <run-uuid>."
  )
assertIsolatedTestConnection(connection)
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: connection, max: 1 })
try {
  const client = await pool.connect()
  try {
    console.log(
      JSON.stringify(
        await manageIntegrationFixtures(
          client,
          action,
          runId
        )
      )
    )
  } finally {
    client.release()
  }
} catch {
  console.error(
    "Fixture operation failed. Inspect the exact isolated run IDs before retrying; no success is confirmed."
  )
  process.exitCode = 1
} finally {
  await pool.end()
}

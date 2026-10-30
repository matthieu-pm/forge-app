import { readFileSync } from "node:fs"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { DATABASE_TARGETS } from "./lib/database-targets"
import {
  assertMigrationTarget,
  runSerializedMigrations,
} from "./lib/serialized-migrations"

const { connection } = JSON.parse(
  readFileSync(process.env.FORGE_ISSUE_TEST_DATABASE_FILE!, "utf8")
)
const target = {
  environment: "issue-creation-acceptance" as const,
  ...DATABASE_TARGETS["issue-creation-acceptance"],
}
assertMigrationTarget(connection, target)
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: connection }),
  client = await pool.connect()
try {
  console.log(
    await runSerializedMigrations(
      client,
      readMigrationFiles({ migrationsFolder: "drizzle" }),
      target
    )
  )
  await client.query("GRANT USAGE ON SCHEMA public TO forge_staging_web")
  await client.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO forge_staging_web"
  )
  await client.query(
    "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO forge_staging_web"
  )
  await client.query(
    "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO forge_staging_web"
  )
} finally {
  client.release()
  await pool.end()
}

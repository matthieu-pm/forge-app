import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { parse } from "dotenv"
import { readMigrationFiles } from "drizzle-orm/migrator"
import {
  assertMigrationTarget,
  runSerializedMigrations,
} from "./lib/serialized-migrations"
import type { MigrationTarget } from "./lib/serialized-migrations"

// Explicit process values win over local files, including operator-selected URLs.
const values: Record<string, string> = {}
for (const path of ["../../../.env", "../../../.env.local"]) {
  try {
    Object.assign(values, parse(await readFile(new URL(path, import.meta.url))))
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error
  }
}
for (const [key, value] of Object.entries(values)) process.env[key] ??= value

const connection = process.env.DATABASE_URL_UNPOOLED
if (!connection)
  throw new Error(
    "DATABASE_URL_UNPOOLED is required; application pooled URLs are not migration credentials."
  )
const target: MigrationTarget = {
  environment: process.env
    .FORGE_MIGRATION_ENVIRONMENT as MigrationTarget["environment"],
  branchId: process.env.FORGE_MIGRATION_BRANCH_ID ?? "",
  host: process.env.FORGE_MIGRATION_HOST ?? "",
  database: process.env.FORGE_MIGRATION_DATABASE ?? "",
}
assertMigrationTarget(connection, target)
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: connection, max: 1 })
const client = await pool.connect()
try {
  const result = await runSerializedMigrations(
    client,
    readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    }),
    target
  )
  console.log(JSON.stringify({ ...target, ...result }))
} catch {
  // Driver errors may contain SQL values/credentials. Keep the CLI log redacted.
  console.error(
    "Migration failed. No success is confirmed; inspect the journal on the verified target before retrying."
  )
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}

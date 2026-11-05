import { Pool, neonConfig } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-serverless"
import { assertStagingEnvironment } from "../../../../packages/environment/staging-environment"
import { configuredDeletionJournal } from "../adapters/recovery/r2-deletion-journal.server"
import { journalDatabasePool } from "../adapters/recovery/journaled-pool.server"
import * as appSchema from "./schema"
import * as planningSchema from "./planning-schema"
import * as loopsSchema from "./loops-schema"
import * as authSchema from "./auth-schema"
import * as jobsSchema from "./jobs-schema"
import * as slaSchema from "./sla-schema"
import * as resourceSchema from "./resources-schema"

assertStagingEnvironment(process.env, "web")

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to initialize the database client.")
}

// Standalone Neon queries avoid a WebSocket handshake. Pool.connect() still
// provides a dedicated connection for Drizzle's interactive transactions.
neonConfig.poolQueryViaFetch = new URL(databaseUrl).hostname.endsWith(
  ".neon.tech"
)
const client = new Pool({ connectionString: databaseUrl })
const deletionJournal = configuredDeletionJournal()
if (deletionJournal)
  journalDatabasePool(
    client,
    deletionJournal,
    databaseUrl,
    process.env.BLOB_STORE_ID ?? ""
  )
export const databaseClient = client

import * as recurringSchema from "./recurring-schema"

export const schema = {
  ...recurringSchema,
  ...appSchema,
  ...jobsSchema,
  ...slaSchema,
  ...loopsSchema,
  ...planningSchema,
  ...authSchema,
  ...resourceSchema,
}

export const db = drizzle(client, { schema })
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** Repositories accept the caller's executor so every write uses one connection. */
export type DatabaseExecutor = typeof db | Transaction

export * from "./schema"
export * from "./auth-schema"

export * from "./planning-schema"

export * from "./resources-schema"

export * from "./loops-schema"

export * from "./jobs-schema"
export * from "./sla-schema"

export * from "./recurring-schema"

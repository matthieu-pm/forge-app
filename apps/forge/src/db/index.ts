import { Pool, neonConfig } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-serverless"
import { assertStagingEnvironment } from "../../../../packages/environment/staging-environment"
import * as appSchema from "./schema"
import * as planningSchema from "./planning-schema"
import * as authSchema from "./auth-schema"

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
export const databaseClient = client

export const schema = {
  ...appSchema,
  ...planningSchema,
  ...authSchema,
}

export const db = drizzle(client, { schema })
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** Repositories accept the caller's executor so every write uses one connection. */
export type DatabaseExecutor = typeof db | Transaction

export * from "./schema"
export * from "./auth-schema"

export * from "./planning-schema"

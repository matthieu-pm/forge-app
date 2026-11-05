import { Pool } from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import * as app from "../../../src/db/schema"
import * as auth from "../../../src/db/auth-schema"
import * as planning from "../../../src/db/planning-schema"
import * as jobs from "../../../src/db/jobs-schema"
import * as sla from "../../../src/db/sla-schema"
import * as inbox from "../../../src/db/inbox-schema"
import * as loops from "../../../src/db/loops-schema"
import * as resources from "../../../src/db/resources-schema"

export * from "../../../src/db/schema"
export * from "../../../src/db/auth-schema"
export * from "../../../src/db/planning-schema"
export * from "../../../src/db/jobs-schema"
export * from "../../../src/db/sla-schema"
export * from "../../../src/db/inbox-schema"
export * from "../../../src/db/loops-schema"
export * from "../../../src/db/resources-schema"

const connectionString = process.env.FORGE_INBOX_TEST_DATABASE_URL
const target = new URL(connectionString ?? "http://invalid")
if (
  target.hostname !== "127.0.0.1" ||
  target.port !== "56565" ||
  target.pathname !== "/for65_inbox_test"
)
  throw new Error("Dedicated local FOR-65 database required")
export const databaseClient = new Pool({ connectionString })
export const schema = {
  ...app,
  ...auth,
  ...planning,
  ...jobs,
  ...sla,
  ...inbox,
  ...loops,
  ...resources,
}
export const db = drizzle(databaseClient, { schema })

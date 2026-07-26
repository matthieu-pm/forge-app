import { neon } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-http"
import * as appSchema from "./schema"
import * as authSchema from "./auth-schema"

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to initialize the database client.")
}

const client = neon(databaseUrl)

export const schema = {
  ...appSchema,
  ...authSchema,
}

export const db = drizzle(client, { schema })

export * from "./schema"
export * from "./auth-schema"

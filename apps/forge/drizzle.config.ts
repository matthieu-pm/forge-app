import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { defineConfig } from "drizzle-kit"
import { config } from "dotenv"

const packageRoot = fileURLToPath(new URL(".", import.meta.url))
const repositoryRoot = resolve(packageRoot, "../..")

config({ path: resolve(repositoryRoot, ".env") })
config({
  path: resolve(repositoryRoot, ".env.local"),
  override: true,
})

// Migrations need a direct connection; application queries keep using the pool.
const databaseUrl =
  process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to use Drizzle.")
}

export default defineConfig({
  out: "./drizzle",
  schema: [
    "./src/db/schema.ts",
    "./src/db/auth-schema.ts",
    "./src/db/planning-schema.ts",
  ],
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
})

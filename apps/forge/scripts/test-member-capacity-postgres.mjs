import { spawnSync } from "node:child_process"

if (!process.env.FORGE_TEST_DATABASE_URL) {
  console.error(
    "FORGE_TEST_DATABASE_URL is required. Only the checked-in isolated staging database is accepted."
  )
  process.exit(1)
}

const result = spawnSync(
  "bunx",
  ["vitest", "run", "src/application/billing/member-capacity.postgres.test.ts"],
  { stdio: "inherit" }
)
if (result.error) {
  console.error("Could not start the PostgreSQL member-capacity tests.")
  process.exit(1)
}
process.exit(result.status ?? 1)

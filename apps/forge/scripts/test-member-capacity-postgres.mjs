import { spawnSync } from "node:child_process"

for (const key of [
  "FORGE_TEST_DATABASE_URL",
  "FORGE_TEST_DATABASE_HOST",
  "FORGE_TEST_NEON_BRANCH_ID",
]) {
  if (!process.env[key]) {
    console.error(
      `${key} is required. Use a fresh, isolated schema-only Neon branch.`
    )
    process.exit(1)
  }
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

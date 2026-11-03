import { Pool } from "pg"
import { jobStore } from "../src/application/jobs/job-store"

const target = new URL(
  process.env.FORGE_JOB_TEST_DATABASE_URL ?? "http://invalid"
)
if (
  target.hostname !== "127.0.0.1" ||
  target.port !== "56464" ||
  target.pathname !== "/for64_jobs_test"
)
  throw new Error("Dedicated local FOR-64 database required")
const pool = new Pool({
  connectionString: process.env.FORGE_JOB_TEST_DATABASE_URL,
})
const store = jobStore(pool)
const [id, phase] = process.argv.slice(2)
const lease = await store.claim("fixture-v1", id)
if (!lease) throw new Error("No lease")
const effect = async () =>
  store.sqlStep(lease, "effect-v1", async (tx) => {
    await tx.query("INSERT INTO for64_job_effects(job_id) VALUES($1)", [id])
    if (phase === "before-commit") {
      console.info("ready")
      await new Promise(() => {})
    }
    return { count: 1 }
  })
await effect()
if (phase === "after-commit") {
  console.info("ready")
  await new Promise(() => {})
}
await store.complete(lease)
console.info("completed")
await pool.end()

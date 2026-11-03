import { Pool } from "pg"
import { jobStore } from "../src/application/jobs/job-store"
import { SLA_JOB_KIND, slaBreachJob } from "../src/application/sla/sla-jobs"

const connection = process.env.FORGE_SLA_TEST_DATABASE_URL
const target = new URL(connection ?? "http://invalid")
if (
  target.hostname !== "127.0.0.1" ||
  target.port !== "56525" ||
  target.pathname !== "/for125_sla_test"
)
  throw new Error("Dedicated local FOR-125 database required")
const pool = new Pool({ connectionString: connection })
const store = jobStore(pool)
const [id, phase] = process.argv.slice(2)
const lease = await store.claim(SLA_JOB_KIND, id)
if (!lease) throw new Error("No lease")
const actualStep = store.sqlStep.bind(store)
store.sqlStep = async (claim, name, run) => {
  const result = await actualStep(claim, name, async (tx) => {
    const value = await run(tx)
    if (name === "breach" && phase === "before-commit") {
      console.info("ready")
      await new Promise(() => {})
    }
    return value
  })
  if (name === "breach" && phase === "after-commit") {
    console.info("ready")
    await new Promise(() => {})
  }
  return result
}
await slaBreachJob(store, lease)
await store.complete(lease)
console.info("completed")
await pool.end()

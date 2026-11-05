import { Pool } from "pg"
import { jobStore } from "../src/application/jobs/job-store"
import {
  CYCLE_ROLLOVER_KIND,
  closeCycle,
} from "../src/application/cycles/cycle-rollover"

const connection = process.env.FORGE_ROLLOVER_TEST_DATABASE_URL
const target = new URL(connection ?? "http://invalid")
if (
  target.hostname !== "127.0.0.1" ||
  target.port !== "56469" ||
  target.pathname !== "/for69_cycles_test"
)
  throw new Error("Dedicated local FOR-69 database required")
const pool = new Pool({ connectionString: connection })
const store = jobStore(pool)
const [id, phase] = process.argv.slice(2)
const lease = await store.claim(CYCLE_ROLLOVER_KIND, id)
if (!lease) throw new Error("No lease")
await store.sqlStep(lease, "close", async (tx) => {
  const result = await closeCycle(
    tx,
    lease.input as Parameters<typeof closeCycle>[1]
  )
  if (phase === "before-commit") {
    console.info("ready")
    await new Promise(() => {})
  }
  return result
})
if (phase === "after-commit") {
  console.info("ready")
  await new Promise(() => {})
}
await store.complete(lease)
await pool.end()

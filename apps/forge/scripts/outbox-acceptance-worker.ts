import { Pool } from "pg"
import { jobStore } from "../src/application/jobs/job-store"
import {
  outboxDelivery,
  outboxKind,
} from "../src/application/jobs/outbox-delivery"
import { runNextJob } from "../src/application/jobs/job-runner"
import { fixtureConsumer } from "./fixtures/outbox-provider"

const target = new URL(
  process.env.FORGE_OUTBOX_TEST_DATABASE_URL ?? "http://invalid"
)
if (
  target.hostname !== "127.0.0.1" ||
  target.port !== "56433" ||
  target.pathname !== "/for33_outbox_test"
)
  throw new Error("Dedicated local FOR-33 database required")
const pool = new Pool({
  connectionString: target.href,
  application_name: "for33-acceptance",
})
try {
  const [id, origin, phase] = process.argv.slice(2)
  const consumer = fixtureConsumer(origin, phase)
  await runNextJob(
    jobStore(pool),
    outboxKind(consumer.id),
    outboxDelivery(pool, [consumer]),
    id
  )
} finally {
  await pool.end()
}

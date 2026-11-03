import { JobError } from "../src/application/jobs/job-store"
import { validateJobEnvironment } from "./lib/script-environment"

try {
  // Operator commands use an explicit target; local dotenv must not select it.
  if (!process.env.DATABASE_URL || !process.env.FORGE_ENVIRONMENT)
    throw new JobError("INVALID_INPUT")
  validateJobEnvironment("background-jobs", { loadLocal: false })
  const { databaseClient } = await import("../src/db")
  try {
    const [{ jobStore }, { jobCommand }] = await Promise.all([
      import("../src/application/jobs/job-store"),
      import("../src/application/jobs/job-cli"),
    ])
    const result = await jobCommand(
      jobStore(databaseClient),
      process.argv.slice(2)
    )
    console.info(JSON.stringify(result, null, 2))
    if (
      "state" in result &&
      !["idle", "completed"].includes(String(result.state))
    )
      process.exitCode = 1
  } finally {
    await databaseClient.end()
  }
} catch (error) {
  console.error(
    JSON.stringify({
      code: error instanceof JobError ? error.code : "JOB_FAILED",
    })
  )
  process.exitCode = 1
}

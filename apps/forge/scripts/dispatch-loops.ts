import { readFile } from "node:fs/promises"
import { setTimeout } from "node:timers/promises"
import { parse } from "dotenv"
// Like the other operator jobs, explicit process settings win over local files.
for (const name of ["../../../.env", "../../../.env.local"]) {
  try {
    for (const [key, value] of Object.entries(
      parse(await readFile(new URL(name, import.meta.url)))
    ))
      process.env[key] ??= value
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error
  }
}
let stopping = false
process.on("SIGTERM", () => {
  stopping = true
})
process.on("SIGINT", () => {
  stopping = true
})
try {
  const { dispatchLoops } =
    await import("../src/application/loops/loop-dispatch.server")
  do {
    const result = await dispatchLoops({ limit: 1 })
    console.log(JSON.stringify({ job: "loops.dispatch", ...result }))
    if (!process.argv.includes("--watch") || !result.enabled) break
    if (!result.executed) await setTimeout(5000)
  } while (!stopping)
} catch {
  console.error(
    "Loop dispatch failed. Check the verified environment and run history; values are redacted."
  )
  process.exitCode = 1
} finally {
  try {
    const { databaseClient } = await import("../src/db")
    await databaseClient.end()
  } catch {
    process.exitCode = 1
  }
}

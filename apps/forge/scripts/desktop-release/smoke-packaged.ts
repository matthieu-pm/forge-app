import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const appOrigin = new URL(required("FORGE_DESKTOP_APP_ORIGIN"))
const loginResponse = await fetch(new URL("/login", appOrigin), {
  redirect: "manual",
})
if (loginResponse.status < 200 || loginResponse.status >= 400) {
  throw new Error(
    `The packaged application origin failed its login preflight (${loginResponse.status}).`
  )
}

const userDataDirectory = await mkdtemp(
  join(tmpdir(), "forge-packaged-smoke-")
)
const child = spawn(
  required("FORGE_PACKAGED_APP_PATH"),
  [`--user-data-dir=${userDataDirectory}`],
  {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }
)

async function stopAndCleanUp() {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM")
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ])
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
  }
  await rm(userDataDirectory, { recursive: true, force: true })
}

let output = ""
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    output += chunk
  })
}

const launchWindowMs = Number(
  process.env.FORGE_PACKAGED_SMOKE_DURATION_MS ?? 8_000
)
const result = await Promise.race([
  new Promise<{ kind: "exit"; code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) =>
        resolve({ kind: "exit", code, signal })
      )
    }
  ),
  new Promise<{ kind: "healthy" }>((resolve) => {
    setTimeout(() => resolve({ kind: "healthy" }), launchWindowMs)
  }),
])

if (result.kind === "exit") {
  await rm(userDataDirectory, { recursive: true, force: true })
  throw new Error(
    `The packaged application exited during launch (code ${result.code ?? "none"}, signal ${result.signal ?? "none"}).`
  )
}
if (/Failed to load URL|ERR_[A-Z_]+/.test(output)) {
  await stopAndCleanUp()
  throw new Error("The packaged application reported a renderer load failure.")
}

await stopAndCleanUp()

console.log(
  `Packaged Forge stayed healthy for ${launchWindowMs}ms against ${appOrigin.origin}.`
)

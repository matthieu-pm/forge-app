import { spawn } from "node:child_process"
import { resolve } from "node:path"

import { config } from "dotenv"

const workspace = resolve(import.meta.dirname, "..")
const service = resolve(workspace, "services/agent-runtime")
const runtimeEnvironment = { ...process.env }

config({
  path: resolve(workspace, ".env.local"),
  processEnv: runtimeEnvironment,
  quiet: true,
})
config({
  path: resolve(service, ".env"),
  processEnv: runtimeEnvironment,
  override: true,
  quiet: true,
})
runtimeEnvironment.FORGE_APP_ORIGIN ??= "http://localhost:3000"

const child = spawn(
  "npm",
  ["run", "dev", "--", "--host", "127.0.0.1", "--port", "2000"],
  {
    cwd: service,
    env: runtimeEnvironment,
    stdio: "inherit",
    shell: false,
  }
)

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal))
}

child.on("error", (error) => {
  process.stderr.write(`Unable to start the EVE runtime: ${error.message}\n`)
  process.exitCode = 1
})
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1)
})

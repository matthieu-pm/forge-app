import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"

import { applyDiagnosticPolicy } from "./apply-diagnostic-policy.mjs"
import { createRootEnvironment } from "./root-environment.mjs"
import {
  assertServiceConfiguration,
  inspectServiceConfiguration,
} from "../../../packages/environment/service-config.ts"

const serviceRoot = resolve(import.meta.dirname, "..")
const repositoryRoot = resolve(serviceRoot, "../..")
const runtimeEnvironment = await createRootEnvironment({
  repositoryRoot,
  serviceRoot,
})
const [command, ...args] = process.argv.slice(2)
if (!command) {
  throw new Error("A command is required.")
}

// EVE evaluates authored modules while compiling. Local/CI builds do not need
// deployment secrets: use an ephemeral channel key only for the build process.
// The serving bundle still evaluates the schema against its own environment.
if (
  command === "eve" &&
  args[0] === "build" &&
  inspectServiceConfiguration(runtimeEnvironment, "runtime").environment ===
    "development"
)
  runtimeEnvironment.FORGE_AGENT_CHANNEL_SECRET ||=
    randomBytes(32).toString("base64url")
assertServiceConfiguration(runtimeEnvironment, "runtime")

if (command === "eve") await applyDiagnosticPolicy()

const child = spawn(command, args, {
  cwd: serviceRoot,
  env: runtimeEnvironment,
  stdio: "inherit",
  shell: false,
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal))
}

child.on("error", (error) => {
  process.stderr.write(`Unable to start ${command}: ${error.message}\n`)
  process.exitCode = 1
})

child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1)
})

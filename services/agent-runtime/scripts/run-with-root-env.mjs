import { spawn } from "node:child_process"
import { resolve } from "node:path"

import { createRootEnvironment } from "./root-environment.mjs"

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

import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { delimiter, resolve } from "node:path"
import { parseEnv } from "node:util"

const serviceRoot = resolve(import.meta.dirname, "..")
const repositoryRoot = resolve(serviceRoot, "../..")
const runtimeEnvironment = { ...process.env }

for (const [path, override] of [
  [resolve(repositoryRoot, ".env"), false],
  [resolve(repositoryRoot, ".env.local"), true],
  [resolve(serviceRoot, ".env"), true],
]) {
  const source = await readFile(path, "utf8").catch(() => null)
  if (!source) continue

  for (const [name, value] of Object.entries(parseEnv(source))) {
    if (override || runtimeEnvironment[name] === undefined) {
      runtimeEnvironment[name] = value
    }
  }
}

runtimeEnvironment.FORGE_APP_ORIGIN ??= "http://127.0.0.1:3000"
runtimeEnvironment.PATH = [
  resolve(repositoryRoot, "node_modules/.bin"),
  resolve(serviceRoot, "node_modules/.bin"),
  runtimeEnvironment.PATH,
]
  .filter(Boolean)
  .join(delimiter)

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

import { readFile } from "node:fs/promises"
import { delimiter, resolve } from "node:path"
import { parseEnv } from "node:util"

export async function createRootEnvironment({
  baseEnvironment = process.env,
  repositoryRoot,
  serviceRoot,
  environmentFiles = [
    [resolve(repositoryRoot, ".env"), false],
    [resolve(repositoryRoot, ".env.local"), true],
    [resolve(serviceRoot, ".env"), true],
  ],
}) {
  const runtimeEnvironment = { ...baseEnvironment }

  for (const [path, override] of environmentFiles) {
    const source = await readFile(path, "utf8").catch(() => null)
    if (!source) continue

    for (const [name, value] of Object.entries(parseEnv(source))) {
      if (override || runtimeEnvironment[name] === undefined) {
        runtimeEnvironment[name] = value
      }
    }
  }

  runtimeEnvironment.FORGE_APP_ORIGIN ??= "http://localhost:3000"
  runtimeEnvironment.PATH = [
    resolve(repositoryRoot, "node_modules/.bin"),
    resolve(serviceRoot, "node_modules/.bin"),
    runtimeEnvironment.PATH,
  ]
    .filter(Boolean)
    .join(delimiter)

  return runtimeEnvironment
}

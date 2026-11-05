import { randomBytes, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

import { applyDiagnosticPolicy } from "./apply-diagnostic-policy.mjs"

import { SignJWT } from "jose"

await applyDiagnosticPolicy()

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const workspaceRoot = dirname(dirname(root))
const temporaryWorkspace = await mkdtemp(join(tmpdir(), "forge-eve-eval-"))
const temporaryRoot = join(temporaryWorkspace, "services", "agent-runtime")
async function bindWorkspaceImports(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) {
      await bindWorkspaceImports(file)
      continue
    }
    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue
    const source = await readFile(file, "utf8")
    const bound = source.replace(
      /(from\s+|import\s*\(\s*|import\s+)(["'])(\.{1,2}\/[^"']+)\2/g,
      (original, prefix, _quote, specifier) => {
        const target = resolve(dirname(file), specifier)
        return target.startsWith(
          `${join(temporaryWorkspace, "packages")}${sep}`
        )
          ? prefix + JSON.stringify(target)
          : original
      }
    )
    if (bound !== source) await writeFile(file, bound)
  }
}

const secret = randomBytes(32).toString("base64url")
const capabilityToken = `eval-capability-${randomBytes(24).toString("base64url")}`
const modelToken = `eval-model-${randomBytes(24).toString("base64url")}`
const token = await new SignJWT({
  workspaceId: "forge-eval-workspace",
  runId: randomUUID(),
  forgeCapabilityToken: capabilityToken,
  forgeModelAccessToken: modelToken,
  provider: "openai",
  modelId: "gpt-5.4-mini",
  reasoningEffort: "low",
})
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setSubject("forge-eval-user")
  .setIssuer("forge")
  .setAudience("forge-agent-runtime")
  .setIssuedAt()
  .setExpirationTime("10m")
  .sign(new TextEncoder().encode(secret))

try {
  await mkdir(temporaryRoot, { recursive: true })
  await cp(
    join(workspaceRoot, "packages"),
    join(temporaryWorkspace, "packages"),
    {
      recursive: true,
      filter: (source) => !source.split(sep).includes("node_modules"),
    }
  )
  await symlink(
    join(workspaceRoot, "node_modules"),
    join(temporaryWorkspace, "node_modules")
  )
  for (const name of await readdir(join(workspaceRoot, "packages"))) {
    const dependencies = join(workspaceRoot, "packages", name, "node_modules")
    if (existsSync(dependencies))
      await symlink(
        dependencies,
        join(temporaryWorkspace, "packages", name, "node_modules")
      )
  }
  await Promise.all(
    ["agent", "evals", "src", "package.json", "tsconfig.json"].map((entry) =>
      cp(join(root, entry), join(temporaryRoot, entry), { recursive: true })
    )
  )
  await symlink(join(root, "node_modules"), join(temporaryRoot, "node_modules"))
  // Eve snapshots the service alone; keep its authored workspace imports resolvable.
  await Promise.all(
    ["agent", "src", "evals"].map((directory) =>
      bindWorkspaceImports(join(temporaryRoot, directory))
    )
  )
  const eveBinary = join(root, "node_modules", "eve", "bin", "eve.js")
  const child = spawn(
    process.execPath,
    [eveBinary, "eval", "--strict", ...process.argv.slice(2)],
    {
      cwd: temporaryRoot,
      env: {
        ...process.env,
        EVE_EVAL_AUTH_TOKEN: token,
        EVE_EVAL_FIXTURE_MODE: "true",
        FORGE_AGENT_CHANNEL_SECRET: secret,
      },
      stdio: "inherit",
    }
  )
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`EVE eval exited with signal ${signal}.`))
      else resolve(code ?? 1)
    })
  })
  process.exitCode = exitCode
} finally {
  await rm(temporaryWorkspace, { recursive: true, force: true })
}

import { randomBytes, randomUUID } from "node:crypto"
import { cp, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

import { SignJWT } from "jose"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temporaryRoot = await mkdtemp(join(tmpdir(), "forge-eve-eval-"))
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
  await Promise.all(
    ["agent", "evals", "src", "package.json", "tsconfig.json"].map((entry) =>
      cp(join(root, entry), join(temporaryRoot, entry), { recursive: true })
    )
  )
  await symlink(join(root, "node_modules"), join(temporaryRoot, "node_modules"))
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
  await rm(temporaryRoot, { recursive: true, force: true })
}

import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:net"
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

// Built-server smoke only: synthetic credentials, no cookies, no reachable DB,
// disabled providers. Never inherit the operator's service credentials.
const app = fileURLToPath(new URL("../", import.meta.url))
const socket = createServer()
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve))
const address = socket.address()
if (!address || typeof address === "string") throw new Error("No fixture port")
const port = address.port
await new Promise<void>((resolve, reject) =>
  socket.close((error) => (error ? reject(error) : resolve()))
)
const child = spawn("node", [".output/server/index.mjs"], {
  cwd: app,
  env: {
    PATH: process.env.PATH,
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    FORGE_ENVIRONMENT: "production",
    DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
    BETTER_AUTH_URL: "https://fixture.example.test",
    BETTER_AUTH_SECRET: `fixture-only-auth-secret-${"a".repeat(40)}`,
    RESEND_API_KEY: "fixture-only-mail-key",
    RESEND_FROM_EMAIL: "Forge <mail@fixture.example.test>",
    BLOB_STORE_ID: "store_fixture",
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_fixture_private",
    FORGE_FEATURE_AGENT_UI: "false",
    FORGE_CALLS_ENABLED: "false",
    FORGE_DESKTOP_RELEASE_ENABLED: "false",
    FORGE_BILLING_ENABLED: "false",
    FORGE_BILLING_WEBHOOKS_ENABLED: "false",
    PUBLIC_API_ENABLED: "true",
    FORGE_FEATURE_ROLLOUTS: "{}",
  },
  stdio: ["ignore", "pipe", "pipe"],
})
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Fixture server startup timed out")),
      15_000
    )
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("exit", () => {
      clearTimeout(timeout)
      reject(new Error("Fixture server exited before listening"))
    })
    child.stderr.on("data", () => {
      /* drain bounded fixture process output */
    })
    child.stdout.on("data", (data: Buffer) => {
      if (data.toString().includes("Listening on:")) {
        clearTimeout(timeout)
        resolve()
      }
    })
  })
  const results: Array<Record<string, unknown>> = []
  const origin = `http://127.0.0.1:${port}`
  for (const path of [
    "/workspace/signals?preview=true",
    "/reviews?preview=true",
    "/reviews/created",
    "/workspace/insights",
    "/settings/signals",
    "/settings/billing",
    "/settings/applications",
    "/settings/account/agents",
    "/settings/sla",
    "/settings/project-updates",
    "/settings/teams/forged/recurring-issues/new",
    "/settings/teams/forged/agent-skills/new",
  ]) {
    const response = await fetch(origin + path, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    const login = response.headers.get("location")?.startsWith("/login")
    const noStore = response.headers.get("cache-control")?.includes("no-store")
    await response.body?.cancel()
    if (
      ![301, 302, 303, 307, 308].includes(response.status) ||
      !login ||
      !noStore
    )
      throw new Error(`UI denial failed: ${path}`)
    results.push({
      path,
      status: response.status,
      redirectsToLogin: login,
      noStore,
    })
  }
  for (const feature of [
    "signals",
    "reviews",
    "insights",
    "billing",
    "applications",
    "integrations",
    "imports",
    "exports",
  ])
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const path = `/api/v1/${feature}`
      const response = await fetch(
        `${origin}${path}?workspaceId=allowed&enabled=true`,
        {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
          headers: {
            authorization: "Bearer forged",
            "x-workspace-id": "allowed",
            "x-feature-enabled": "true",
          },
        }
      )
      await response.body?.cancel()
      if (response.status !== 404)
        throw new Error(`API denial failed: ${method} ${path}`)
      results.push({ path, method, status: response.status })
    }
  const evidence = {
    checkedAt: new Date().toISOString(),
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: app,
      encoding: "utf8",
    }).trim(),
    environment:
      "local built production server; synthetic credentials; no cookies; unreachable fixture DB; providers disabled",
    results,
  }
  await writeFile(
    new URL(
      "../../../docs/operations/for103-local-http-evidence.json",
      import.meta.url
    ),
    JSON.stringify(evidence, null, 2) + "\n"
  )
  process.stdout.write(`Passed ${results.length} built-server denial checks.\n`)
} finally {
  child.kill("SIGTERM")
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000)
  child.once("exit", () => clearTimeout(timeout))
}

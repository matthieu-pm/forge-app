import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { STAGING } from "../packages/environment/staging-environment"

const token = process.env.FORGE_OPERATIONS_CHECK_TOKEN ?? ""
if (!/^[A-Za-z0-9_-]{43}$/.test(token))
  throw new Error("A short-lived operations operator token is required.")
const source = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })
if (source.status !== 0)
  throw new Error("Could not identify verification source.")
const revision = source.stdout.trim(),
  challenge = randomBytes(16).toString("hex")

function call(
  service: "web" | "runtime",
  path: string,
  method: "POST" | "GET",
  authorized = false
) {
  const config = [
    `request = "${method}"`,
    `header = "x-environment-check-challenge: ${challenge}"`,
    ...(authorized ? [`header = "authorization: Bearer ${token}"`] : []),
  ].join("\n")
  const result = spawnSync(
    "bunx",
    [
      "--package",
      "vercel@50.4.11",
      "vercel",
      "curl",
      path,
      "--deployment",
      service === "web" ? STAGING.webOrigin : STAGING.runtimeOrigin,
      "--scope",
      "matthieu-pm",
      "--",
      "--silent",
      "--show-error",
      "--include",
      "--max-time",
      "45",
      "--config",
      "-",
    ],
    {
      encoding: "utf8",
      input: config,
      env: {
        ...process.env,
        VERCEL_ORG_ID: "team_KddvwwnftxOOhP8UymRnP0PX",
        VERCEL_PROJECT_ID:
          service === "web" ? STAGING.webProjectId : STAGING.runtimeProjectId,
      },
    }
  )
  if (result.status !== 0 || (result.stdout + result.stderr).includes(token))
    throw new Error("Operations HTTP verification failed.")
  const statuses = [...result.stdout.matchAll(/^HTTP\/\S+ (\d+)/gm)]
  const delimiter = [...result.stdout.matchAll(/\r?\n\r?\n/g)].at(-1)
  if (!delimiter) throw new Error("Invalid verification response.")
  const text = result.stdout.slice(delimiter.index! + delimiter[0].length)
  return {
    httpStatus: Number(statuses.at(-1)?.[1]),
    body: text ? JSON.parse(text) : null,
  }
}

for (const [service, path] of [
  ["web", "/api/internal/operations-check"],
  ["runtime", "/internal/operations-inbox"],
] as const) {
  if (call(service, path, "POST").httpStatus !== 404)
    throw new Error("Anonymous acceptance probe was not denied.")
}
const health = {
  webLive: call("web", "/api/health/live", "GET"),
  webReady: call("web", "/api/health/ready", "GET"),
  runtimeLive: call("runtime", "/health/live", "GET"),
  runtimeReady: call("runtime", "/health/ready", "GET"),
}
for (const [name, response] of Object.entries(health))
  if (
    response.httpStatus !== 200 ||
    response.body?.code !== (name.endsWith("Live") ? "ALIVE" : "READY")
  )
    throw new Error(`Hosted ${name} check failed.`)
const response = call("web", "/api/internal/operations-check", "POST", true)
const value = response.body
if (
  response.httpStatus !== 200 ||
  value?.challenge !== challenge ||
  value.sourceRevision !== revision ||
  !/^dpl_[A-Za-z0-9]+$/.test(value.deploymentId ?? "") ||
  value.schemaMissing?.httpStatus !== 503 ||
  value.schemaMissing.code !== "SCHEMA_NOT_READY" ||
  value.databaseUnavailable?.httpStatus !== 503 ||
  value.databaseUnavailable.code !== "DATABASE_UNAVAILABLE" ||
  value.delivery?.delivered !== 1 ||
  value.delivery.failed !== 0 ||
  value.retry?.suppressed !== 1 ||
  value.retry.delivered !== 0 ||
  value.receipts?.length !== 1 ||
  !/^[a-f0-9]{64}$/.test(value.receipts[0]?.id ?? "")
)
  throw new Error("Hosted operational acceptance did not pass.")
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      sourceRevision: revision,
      challenge,
      anonymousProbesDenied: true,
      health,
      acceptance: value,
    },
    null,
    2
  )
)

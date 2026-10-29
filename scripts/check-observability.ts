import { spawnSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { STAGING } from "../packages/environment/staging-environment"
import {
  ACCEPTANCE_FIXTURES,
  acceptanceEnvelope,
} from "../packages/telemetry/acceptance"

const token = process.env.FORGE_OBSERVABILITY_CHECK_TOKEN ?? ""
if (!/^[A-Za-z0-9_-]{43}$/.test(token))
  throw new Error("A short-lived observability operator token is required.")
const source = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })
if (source.status !== 0)
  throw new Error("Could not identify acceptance source.")
const expectedRevision = source.stdout.trim()
const challenge = randomBytes(16).toString("hex")
const correlationId = randomUUID()

function call(service: "web" | "runtime", authorized: boolean) {
  const config = [
    'request = "POST"',
    `header = "x-environment-check-challenge: ${challenge}"`,
    `header = "x-correlation-id: ${correlationId}"`,
    ...(authorized ? [`header = "authorization: Bearer ${token}"`] : []),
  ].join("\n")
  // The operator token goes over stdin, never a process argument, URL or file.
  const result = spawnSync(
    "bunx",
    [
      "--package",
      "vercel@50.4.11",
      "vercel",
      "curl",
      service === "web"
        ? "/api/internal/observability-check"
        : "/internal/observability-check",
      "--deployment",
      service === "web" ? STAGING.webOrigin : STAGING.runtimeOrigin,
      "--scope",
      "matthieu-pm",
      "--",
      "--silent",
      "--show-error",
      "--include",
      "--max-time",
      "35",
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
  if (
    result.status !== 0 ||
    [token, ...ACCEPTANCE_FIXTURES].some((value) =>
      (result.stdout + result.stderr).includes(value)
    )
  )
    throw new Error(
      "Observability HTTP check failed or exposed fixture content."
    )
  const statuses = [...result.stdout.matchAll(/^HTTP\/\S+ (\d+)/gm)]
  const breaks = [...result.stdout.matchAll(/\r?\n\r?\n/g)]
  const last = breaks.at(-1)
  if (!last) throw new Error("Invalid acceptance HTTP response.")
  return {
    status: Number(statuses.at(-1)?.[1]),
    headers: result.stdout.slice(0, last.index),
    body: result.stdout.slice(last.index! + last[0].length),
  }
}

for (const service of ["web", "runtime"] as const) {
  if (call(service, false).status !== 404)
    throw new Error("The unauthenticated acceptance probe was not denied.")
}
const response = call("web", true)
if (response.status !== 200)
  throw new Error("Hosted observability acceptance did not pass.")
const result = JSON.parse(response.body)
const envelope = acceptanceEnvelope(result.worker?.envelope)
if (
  result.outcome !== "passed" ||
  result.challenge !== challenge ||
  result.errorCode !== "ISSUE_WRITE_FAILED" ||
  result.worker?.errorCode !== "WORKER_EXECUTION_FAILED" ||
  envelope.correlationId !== correlationId ||
  result.sourceRevision !== expectedRevision ||
  result.runtime?.sourceRevision !== expectedRevision ||
  !/^dpl_[A-Za-z0-9]+$/.test(result.deploymentId) ||
  !/^dpl_[A-Za-z0-9]+$/.test(result.runtime?.deploymentId) ||
  !response.headers
    .toLowerCase()
    .includes(`x-request-id: ${envelope.requestId}`)
)
  throw new Error("Hosted acceptance identity or correlation mismatch.")
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      sourceRevision: expectedRevision,
      scenario: "synthetic-issue-write-failure",
      outcome: "passed",
      correlation: envelope,
      web: { deploymentId: result.deploymentId },
      runtime: { deploymentId: result.runtime.deploymentId },
      unauthenticatedProbesDenied: true,
      fixtureContentAbsentFromResponses: true,
    },
    null,
    2
  )
)

import { handleEnvironmentCheck } from "../environment/operator-check.js"
import { STAGING } from "../environment/staging-environment.js"

type Environment = Record<string, string | undefined>
export function healthCheckSchema(env: Environment) {
  const schema = env.FORGE_OPERATIONS_CHECK_SCHEMA ?? ""
  if (!/^for30_[a-f0-9]{32}$/.test(schema))
    throw new Error("Invalid isolated operations schema.")
  return schema
}

export function operationsAcceptance(
  request: Request,
  env: Environment,
  service: "web" | "runtime",
  run: (challenge: string) => Promise<unknown>,
  now = Date.now()
) {
  const expires = Date.parse(env.FORGE_OPERATIONS_CHECK_EXPIRES_AT ?? "")
  if (
    request.method !== "POST" ||
    env.FORGE_ENVIRONMENT !== "staging" ||
    env.VERCEL_PROJECT_ID !==
      (service === "web" ? STAGING.webProjectId : STAGING.runtimeProjectId) ||
    !Number.isFinite(expires) ||
    expires > now + 7_200_000
  )
    return Promise.resolve(
      new Response(null, {
        status: 404,
        headers: { "cache-control": "no-store" },
      })
    )
  return handleEnvironmentCheck(
    request,
    {
      tokenSha256: env.FORGE_OPERATIONS_CHECK_TOKEN_SHA256,
      expiresAt: env.FORGE_OPERATIONS_CHECK_EXPIRES_AT,
    },
    run,
    now
  )
}

/** Isolated synthetic operator receiver. No model, database or customer side effects. */
export function receiveOperatorAcceptance(
  request: Request,
  env: Environment,
  now = Date.now()
) {
  return operationsAcceptance(
    request,
    env,
    "runtime",
    async (challenge) => {
      const body = await request.text()
      if (body.length > 2_048) throw new Error("Invalid operator alert.")
      const alert = JSON.parse(body)
      if (
        alert.version !== 1 ||
        alert.objectiveVersion !== 1 ||
        !/^[a-f0-9]{64}$/.test(alert.id) ||
        alert.environment !== "staging" ||
        alert.code !== "SWEEP_STALE" ||
        alert.signal !== "agent.retention" ||
        alert.severity !== "page" ||
        !/^[a-f0-9]{40}$/.test(env.FORGE_SOURCE_REVISION ?? "") ||
        alert.runbookUrl !==
          `https://github.com/matthieu-pm/forge-app/blob/${env.FORGE_SOURCE_REVISION}/docs/operations/readiness-and-alerts.md`
      )
        throw new Error("Invalid operator alert.")
      const receipt = {
        event: "operator.test-alert.received",
        id: alert.id,
        code: "SWEEP_STALE",
        signal: "agent.retention",
        severity: "page",
        runbookUrl: alert.runbookUrl,
        sourceRevision: env.FORGE_SOURCE_REVISION,
        deploymentId: env.VERCEL_DEPLOYMENT_ID,
      }
      console.info(JSON.stringify(receipt))
      return { challenge, accepted: true, id: alert.id }
    },
    now
  )
}

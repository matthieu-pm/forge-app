import { handleEnvironmentCheck } from "../environment/operator-check.js"
import {
  STAGING,
  assertStagingEnvironment,
} from "../environment/staging-environment.js"
import {
  acceptanceEnvelope,
  failSyntheticIssueWrite,
  runIssueWriteAcceptance,
} from "./acceptance.js"
import type { WorkerFailure } from "./acceptance.js"
import { observeRequest } from "./server.js"

type Environment = Record<string, string | undefined>
const denied = () =>
  new Response(null, { status: 404, headers: { "cache-control": "no-store" } })
function identity(env: Environment) {
  return {
    deploymentId: /^dpl_[A-Za-z0-9]{1,100}$/.test(
      env.VERCEL_DEPLOYMENT_ID ?? ""
    )
      ? env.VERCEL_DEPLOYMENT_ID
      : null,
    sourceRevision: /^[a-f0-9]{40}$/i.test(env.FORGE_SOURCE_REVISION ?? "")
      ? env.FORGE_SOURCE_REVISION
      : null,
  }
}

// Probe authority is deployment-local, time-bound and staging-only. No database,
// model, file or domain mutation is imported or performed by this path.
export async function handleObservabilityAcceptance(
  request: Request,
  env: Environment,
  service: "web" | "runtime",
  fetcher: typeof fetch = fetch,
  now = Date.now()
) {
  const expires = Date.parse(env.FORGE_OBSERVABILITY_CHECK_EXPIRES_AT ?? "")
  if (
    request.method !== "POST" ||
    env.FORGE_ENVIRONMENT !== "staging" ||
    env.VERCEL_PROJECT_ID !==
      (service === "web" ? STAGING.webProjectId : STAGING.runtimeProjectId) ||
    !Number.isFinite(expires) ||
    expires > now + 2 * 60 * 60 * 1000
  )
    return denied()

  return observeRequest(
    request,
    service === "web" ? "http" : "runtime.issue-worker",
    () =>
      handleEnvironmentCheck(
        request,
        {
          tokenSha256: env.FORGE_OBSERVABILITY_CHECK_TOKEN_SHA256,
          expiresAt: env.FORGE_OBSERVABILITY_CHECK_EXPIRES_AT,
        },
        async (challenge) => {
          assertStagingEnvironment(env, service)
          if (service === "runtime") {
            const text = await request.text()
            if (text.length > 1024)
              throw new Error("Invalid acceptance envelope.")
            const envelope = acceptanceEnvelope(JSON.parse(text))
            const worker = await failSyntheticIssueWrite(envelope)
            return { challenge, ...identity(env), ...worker }
          }
          let runtimeIdentity: ReturnType<typeof identity> | undefined
          const result = await runIssueWriteAcceptance(async (envelope) => {
            const response = await fetcher(
              new URL("/internal/observability-check", STAGING.runtimeOrigin),
              {
                method: "POST",
                headers: {
                  authorization: request.headers.get("authorization")!,
                  "content-type": "application/json",
                  "x-correlation-id": envelope.correlationId,
                  "x-environment-check-challenge": challenge,
                },
                body: JSON.stringify(envelope),
                redirect: "error",
                signal: AbortSignal.timeout(20_000),
              }
            )
            if (!response.ok)
              throw new Error("Acceptance worker is unavailable.")
            const body = await response.text()
            if (body.length > 2048)
              throw new Error("Invalid acceptance worker response.")
            const value = JSON.parse(body) as WorkerFailure & {
              challenge?: string
              deploymentId?: string
              sourceRevision?: string
            }
            if (
              value.challenge !== challenge ||
              value.sourceRevision !== env.FORGE_SOURCE_REVISION ||
              !/^dpl_[A-Za-z0-9]{1,100}$/.test(value.deploymentId ?? "")
            ) {
              throw new Error("Acceptance worker identity mismatch.")
            }
            runtimeIdentity = identity({
              VERCEL_DEPLOYMENT_ID: value.deploymentId,
              FORGE_SOURCE_REVISION: value.sourceRevision,
            })
            return {
              outcome: value.outcome,
              errorCode: value.errorCode,
              envelope: acceptanceEnvelope(value.envelope),
            }
          })
          return {
            challenge,
            ...identity(env),
            runtime: runtimeIdentity,
            ...result,
          }
        },
        now
      )
  )
}

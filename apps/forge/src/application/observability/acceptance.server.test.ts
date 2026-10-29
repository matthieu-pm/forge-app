// @vitest-environment node
import { createHash, randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { handleObservabilityAcceptance } from "../../../../../packages/telemetry/acceptance-handler"
import {
  ACCEPTANCE_FIXTURES,
  acceptanceEnvelope,
} from "../../../../../packages/telemetry/acceptance"
import { STAGING } from "../../../../../packages/environment/staging-environment"

const token = "x".repeat(43),
  challenge = "a".repeat(32),
  revision = "b".repeat(40)
const base = {
  FORGE_ENVIRONMENT: "staging",
  FORGE_EXTERNAL_INTEGRATIONS: "disabled",
  VERCEL: "1",
  VERCEL_PROJECT_ID: STAGING.webProjectId,
  VERCEL_DEPLOYMENT_ID: "dpl_WebFixture",
  FORGE_SOURCE_REVISION: revision,
  BETTER_AUTH_URL: STAGING.webOrigin,
  EVE_AGENT_RUNTIME_URL: STAGING.runtimeOrigin,
  FORGE_AGENT_BLOB_ADAPTER: "vercel-private",
  BLOB_STORE_ID: STAGING.blobStoreId,
  FORGE_BILLING_ENABLED: "false",
  FORGE_BILLING_WEBHOOKS_ENABLED: "false",
  FORGE_AGENT_CHANNEL_SECRET: "isolated-fixture-secret-with-32-characters",
  DATABASE_URL: `postgresql://${STAGING.databaseRole}:fixture@${STAGING.database.host.replace(".", "-pooler.")}/${STAGING.database.database}?sslmode=require`,
  FORGE_OBSERVABILITY_CHECK_TOKEN_SHA256: createHash("sha256")
    .update(token)
    .digest("hex"),
  FORGE_OBSERVABILITY_CHECK_EXPIRES_AT: new Date(
    Date.now() + 3600_000
  ).toISOString(),
}
const runtime = {
  ...base,
  VERCEL_PROJECT_ID: STAGING.runtimeProjectId,
  VERCEL_DEPLOYMENT_ID: "dpl_RuntimeFixture",
  FORGE_APP_ORIGIN: STAGING.webOrigin,
}
function request(headers: Record<string, string> = {}, body?: string) {
  return new Request(`${STAGING.webOrigin}/api/internal/observability-check`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-environment-check-challenge": challenge,
      ...headers,
    },
    body,
  })
}
const envelope = () => ({
  correlationId: randomUUID(),
  requestId: randomUUID(),
  commandId: randomUUID(),
  runId: randomUUID(),
})
afterEach(() => vi.restoreAllMocks())

describe("staging observability acceptance", () => {
  it("connects a failing issue-write request, command and separate worker without fixture content (AT-01/AT-02)", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    const correlationId = randomUUID()
    const fetcher = vi.fn((url, init) =>
      handleObservabilityAcceptance(
        new Request(String(url), init),
        runtime,
        "runtime"
      )
    ) as unknown as typeof fetch
    const response = await handleObservabilityAcceptance(
      request({ "x-correlation-id": correlationId }),
      base,
      "web",
      fetcher
    )
    const result = await response.json()
    expect(response.status).toBe(200)
    expect(result).toMatchObject({
      outcome: "passed",
      scenario: "synthetic-issue-write-failure",
      errorCode: "ISSUE_WRITE_FAILED",
      runtime: { deploymentId: "dpl_RuntimeFixture", sourceRevision: revision },
      worker: {
        outcome: "failed",
        errorCode: "WORKER_EXECUTION_FAILED",
        envelope: {
          correlationId,
          requestId: response.headers.get("x-request-id"),
        },
      },
    })
    const records = log.mock.calls.map(([line]) => JSON.parse(String(line)))
    const command = records.find(
      (record) =>
        record.operation === "issues.write" &&
        record.event === "forge.operation.failed"
    )
    expect(command).toBeDefined()
    expect(records).toContainEqual(
      expect.objectContaining({
        operation: "runtime.issue-worker",
        event: "forge.operation.failed",
        service: "runtime",
        errorCode: "WORKER_EXECUTION_FAILED",
        correlationId,
        requestId: command.requestId,
        commandId: command.commandId,
        runId: result.worker.envelope.runId,
      })
    )
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "forge.request.completed",
        correlationId,
        requestId: command.requestId,
      })
    )
    const captured = JSON.stringify(log.mock.calls) + JSON.stringify(result)
    for (const sensitive of [...ACCEPTANCE_FIXTURES, token, base.DATABASE_URL])
      expect(captured).not.toContain(sensitive)
  })

  it.each([
    { FORGE_ENVIRONMENT: "production" },
    { VERCEL_PROJECT_ID: "prj_Production" },
    { FORGE_OBSERVABILITY_CHECK_TOKEN_SHA256: undefined },
    { FORGE_OBSERVABILITY_CHECK_EXPIRES_AT: new Date(0).toISOString() },
    {
      FORGE_OBSERVABILITY_CHECK_EXPIRES_AT: new Date(
        Date.now() + 3 * 3600_000
      ).toISOString(),
    },
  ])(
    "fails closed before dispatch for an unavailable or unsafe probe: %j",
    async (overrides) => {
      const fetcher = vi.fn()
      const response = await handleObservabilityAcceptance(
        request(),
        { ...base, ...overrides },
        "web",
        fetcher
      )
      expect(response.status).toBe(404)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it("denies wrong credentials before reading private input", async () => {
    const req = request(
      { authorization: `Bearer ${"y".repeat(43)}` },
      ACCEPTANCE_FIXTURES[1]
    )
    const read = vi.spyOn(req, "text")
    const response = await handleObservabilityAcceptance(
      req,
      base,
      "web",
      vi.fn()
    )
    expect(response.status).toBe(404)
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    { challenge: "c".repeat(32) },
    { sourceRevision: "d".repeat(40) },
    { deploymentId: ACCEPTANCE_FIXTURES[2] },
    { errorCode: "ARBITRARY_WORKER_ERROR" },
  ])(
    "does not pass acceptance for a mismatched worker: %j",
    async (overrides) => {
      vi.spyOn(console, "info").mockImplementation(() => {})
      const fetcher = vi.fn(async (_url, init) =>
        Response.json({
          challenge,
          sourceRevision: revision,
          deploymentId: "dpl_RuntimeFixture",
          outcome: "failed",
          errorCode: "WORKER_EXECUTION_FAILED",
          envelope: JSON.parse(String(init!.body)),
          ...overrides,
        })
      ) as typeof fetch
      const response = await handleObservabilityAcceptance(
        request(),
        base,
        "web",
        fetcher
      )
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain("passed")
    }
  )

  it("does not expose unreachable-worker errors", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    const fetcher = vi
      .fn()
      .mockRejectedValue(new Error(ACCEPTANCE_FIXTURES.join(" ")))
    const response = await handleObservabilityAcceptance(
      request(),
      base,
      "web",
      fetcher
    )
    expect(response.status).toBe(503)
    for (const secret of ACCEPTANCE_FIXTURES)
      expect(
        JSON.stringify(log.mock.calls) + (await response.clone().text())
      ).not.toContain(secret)
  })

  it("accepts only bounded UUID envelopes without private fields", async () => {
    const clean = envelope()
    expect(acceptanceEnvelope(clean)).toEqual(clean)
    expect(() =>
      acceptanceEnvelope({ ...clean, prompt: ACCEPTANCE_FIXTURES[1] })
    ).toThrow()
    expect(() =>
      acceptanceEnvelope({ ...clean, commandId: ACCEPTANCE_FIXTURES[0] })
    ).toThrow()
    const response = await handleObservabilityAcceptance(
      request({}, JSON.stringify({ ...clean, prompt: ACCEPTANCE_FIXTURES[1] })),
      runtime,
      "runtime"
    )
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain(ACCEPTANCE_FIXTURES[1])
  })
})

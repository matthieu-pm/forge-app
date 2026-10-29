// @vitest-environment node
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  boundedErrorCode,
  classifyError,
  correlateIterable,
  currentCorrelation,
  emitTelemetry,
  observeCommand,
  observeOperation,
  observeRequest,
  runJob,
  withCorrelation,
} from "./telemetry.server"

const TOKEN = "sk-secret-for29-fixture"
const TRANSCRIPT = "A private transcript containing a customer plan"
const URL = "https://private.test/file?token=signed-secret-for29"
const privateError = () =>
  Object.assign(new Error(`${TOKEN} ${TRANSCRIPT} ${URL}`), {
    name: TOKEN,
    code: TRANSCRIPT,
    cause: { token: TOKEN },
  })
function capture() {
  const log = vi.spyOn(console, "info").mockImplementation(() => {})
  return {
    log,
    records: () =>
      log.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>
      ),
  }
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("payload-free telemetry", () => {
  it("projects identifiers, fixed labels and finite nonnegative measurements only", () => {
    const { log, records } = capture()
    const correlationId = randomUUID()
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_For29Fixture")
    vi.stubEnv("FORGE_SOURCE_REVISION", "a".repeat(40))
    withCorrelation({ correlationId }, () =>
      emitTelemetry("run.usage", "agent.run", {
        runId: randomUUID(),
        costMicros: 12,
        inputTokens: 200,
        durationMs: 1.5,
        queueAgeMs: NaN,
        leaseAgeMs: -1,
        outputTokens: Infinity,
        commandId: TOKEN,
        errorCode: URL,
        ...({
          prompt: TRANSCRIPT,
          token: TOKEN,
          signedUrl: URL,
          error: privateError(),
          headers: { authorization: TOKEN },
          body: TRANSCRIPT,
        } as object),
      })
    )
    expect(records()).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        correlationId,
        costMicros: 12,
        inputTokens: 200,
        durationMs: 1.5,
        errorCode: "INTERNAL_ERROR",
        deploymentId: "dpl_For29Fixture",
        sourceRevision: "a".repeat(40),
      }),
    ])
    for (const field of [
      "queueAgeMs",
      "leaseAgeMs",
      "outputTokens",
      "prompt",
      "error",
      "headers",
      "body",
      "commandId",
    ])
      expect(records()[0]).not.toHaveProperty(field)
    for (const secret of [TOKEN, TRANSCRIPT, URL])
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
  })

  it("bounds errors and never reads user-controlled error getters", () => {
    const error = Object.defineProperty({}, "code", {
      get() {
        throw new Error(TOKEN)
      },
    })
    expect(classifyError(error)).toBe("INTERNAL_ERROR")
    expect(classifyError(privateError())).toBe("INTERNAL_ERROR")
    expect(classifyError({ code: "ECONNREFUSED" })).toBe("DATABASE_UNAVAILABLE")
    expect(boundedErrorCode(URL, TOKEN)).toBe("INTERNAL_ERROR")
  })

  it("rejects unsafe request IDs and never logs URL, headers or private error data", async () => {
    const { log, records } = capture()
    const response = await observeRequest(
      new Request(`${URL}&body=private`, {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-correlation-id": TRANSCRIPT,
          "x-request-id": TOKEN,
        },
      }),
      "public_api",
      async () => {
        throw privateError()
      }
    )
    expect(response.status).toBe(500)
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/)
    expect(response.headers.get("x-correlation-id")).toBe(
      response.headers.get("x-request-id")
    )
    expect(records()).toEqual([
      expect.objectContaining({
        event: "forge.request.failed",
        errorCode: "INTERNAL_ERROR",
        status: 500,
      }),
    ])
    const output = JSON.stringify(log.mock.calls) + (await response.text())
    for (const secret of [TOKEN, TRANSCRIPT, URL])
      expect(output).not.toContain(secret)
  })

  it("connects a request, command and deferred failing worker after the request scope ends (AT-01)", async () => {
    const { log, records } = capture()
    const correlationId = randomUUID(),
      runId = randomUUID()
    let worker: AsyncIterable<never> | undefined
    const response = await observeRequest(
      new Request("https://forge.test/api/agent/runs", {
        headers: { "x-correlation-id": correlationId },
      }),
      "agent_http",
      async () => {
        await observeCommand("capability.invoke", async () => {
          emitTelemetry("run.linked", "agent.run", { runId })
          worker = correlateIterable(
            (async function* () {
              yield await observeOperation("agent.run", async () => {
                throw privateError()
              })
            })(),
            { runId }
          )
        })
        return new Response(null, { status: 202 })
      }
    )
    await expect(worker![Symbol.asyncIterator]().next()).rejects.toThrow(TOKEN)
    const linked = records().find(
      (record) => record.event === "forge.run.linked"
    )!
    const failure = records().find(
      (record) => record.event === "forge.operation.failed"
    )!
    expect(failure).toMatchObject({
      correlationId,
      requestId: response.headers.get("x-request-id"),
      commandId: linked.commandId,
      runId,
      errorCode: "INTERNAL_ERROR",
    })
    expect(currentCorrelation()).toEqual({})
    for (const secret of [TOKEN, TRANSCRIPT, URL])
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
  })

  it("isolates concurrent requests and nested commands across awaits", async () => {
    const { records } = capture()
    const ids = [randomUUID(), randomUUID()]
    await Promise.all(
      ids.map((id, n) =>
        observeRequest(
          new Request("https://forge.test/api/v1/teams", {
            headers: { "x-correlation-id": id },
          }),
          "public_api",
          async () => {
            await observeCommand("teams.update", async () => {
              await new Promise((resolve) =>
                setTimeout(resolve, n === 0 ? 10 : 1)
              )
              expect(currentCorrelation().correlationId).toBe(id)
              emitTelemetry("run.linked", "agent.run", { runId: id })
            })
            return new Response(null)
          }
        )
      )
    )
    const links = records().filter(
      (record) => record.event === "forge.run.linked"
    )
    expect(new Set(links.map((record) => record.commandId)).size).toBe(2)
    for (const link of links) expect(link.correlationId).toBe(link.runId)
    expect(currentCorrelation()).toEqual({})
  })

  it("does not change business results when the sink fails", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw privateError()
    })
    await expect(
      observeCommand("teams.update", () => Promise.resolve({ ok: true }))
    ).resolves.toEqual({ ok: true })
  })

  it("captures rejected commands and job failures without printing exceptions", async () => {
    const { log, records } = capture()
    await observeCommand("teams.update", async () => ({
      ok: false,
      code: TOKEN,
      message: TRANSCRIPT,
    }))
    const previous = process.exitCode
    try {
      await runJob("calls.sync", async () => {
        throw privateError()
      })
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = previous
    }
    expect(records()).toContainEqual(
      expect.objectContaining({
        event: "forge.operation.rejected",
        errorCode: "COMMAND_REJECTED",
      })
    )
    expect(records()).toContainEqual(
      expect.objectContaining({
        event: "forge.operation.failed",
        jobId: expect.any(String),
      })
    )
    for (const secret of [TOKEN, TRANSCRIPT, URL])
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
  })
})

it("does not duplicate nested transport logs and assigns separate IDs to subsequent requests", async () => {
  const { records } = capture()
  const request = new Request("https://forge.test/api/v1/teams")
  const response = await observeRequest(request, "http", () =>
    observeRequest(request, "public_api", async () => new Response(null))
  )
  expect(records()).toHaveLength(1)
  expect(response.headers.get("x-request-id")).toBe(records()[0].requestId)
  const subsequent = await observeRequest(
    request,
    "http",
    async () => new Response(null)
  )
  expect(records()).toHaveLength(2)
  expect(subsequent.headers.get("x-request-id")).not.toBe(
    response.headers.get("x-request-id")
  )
})

it("preserves explicitly thrown HTTP response control flow", async () => {
  const response = await observeRequest(
    new Request("https://forge.test/"),
    "http",
    () => Promise.reject(Response.redirect("https://forge.test/login"))
  )
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe("https://forge.test/login")
  expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
})

it("keeps a stable run correlation when consumed without any request context", async () => {
  const { records } = capture()
  const runId = randomUUID()
  const events = correlateIterable(
    (async function* () {
      emitTelemetry("run.usage", "agent.run", { count: 1 })
      yield 1
      emitTelemetry("run.usage", "agent.run", { count: 2 })
      yield 2
    })(),
    { runId }
  )
  for await (const _event of events) {
    /* consume outside a request */
  }
  expect(records().map((record) => record.correlationId)).toEqual([
    runId,
    runId,
  ])
})

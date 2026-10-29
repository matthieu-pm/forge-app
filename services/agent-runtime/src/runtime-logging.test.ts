import { afterEach, describe, expect, it, vi } from "vitest"
import instrumentation from "../agent/instrumentation.js"

// Import the actual pinned implementation; a mock would miss payload capture
// inside the framework before Forge sees a failed run event.
const logging = (await import(
  new URL(
    "./dist/src/internal/logging.js",
    import.meta.resolve("eve/package.json")
  ).href
)) as {
  createLogger: (namespace: string) => {
    error: (message: string, fields: Record<string, unknown>) => void
  }
  formatError: (error: unknown) => Record<string, unknown>
  inspectError: (error: unknown) => string
  logError: (
    logger: unknown,
    message: string,
    error: unknown,
    fields?: Record<string, unknown>
  ) => string
  recordErrorOnSpan: (span: unknown, error: unknown) => void
  setLogRecordSubscriber: (
    subscriber: ((record: unknown) => void) | undefined
  ) => void
}

afterEach(() => {
  logging.setLogRecordSubscriber(undefined)
  vi.restoreAllMocks()
})

describe("pinned EVE diagnostic projection", () => {
  it("excludes provider bodies, tokens and cause chains from real framework sinks", () => {
    const sensitive =
      "sk-private-token private transcript https://test/file?sig=private"
    const error = Object.assign(new Error(sensitive), {
      responseBody: sensitive,
      cause: new Error(sensitive),
      name: sensitive,
    })
    const output = vi.spyOn(console, "error").mockImplementation(() => {})
    const logger = logging.createLogger(sensitive)
    const id = logging.logError(logger, sensitive, error, {
      body: sensitive,
      headers: { authorization: sensitive },
      prompt: sensitive,
    })
    logger.error(sensitive, { error, url: sensitive, result: sensitive })
    const span = { setStatus: vi.fn(), recordException: vi.fn() }
    logging.recordErrorOnSpan(span, error)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(output).toHaveBeenCalledTimes(2)
    expect(span.recordException).toHaveBeenCalledWith({
      name: "RuntimeError",
      message: "Runtime execution failed.",
    })
    expect(
      JSON.stringify(output.mock.calls) +
        JSON.stringify(span.setStatus.mock.calls) +
        JSON.stringify(span.recordException.mock.calls) +
        JSON.stringify(logging.formatError(error)) +
        logging.inspectError(error)
    ).not.toContain(sensitive)
  })
  it("projects fields before a framework subscriber can receive them", () => {
    const subscriber = vi.fn()
    logging.setLogRecordSubscriber(subscriber)
    logging
      .createLogger("private namespace")
      .error("private transcript", {
        token: "secret",
        runId: "00000000-0000-4000-8000-000000000001",
      })
    expect(subscriber).toHaveBeenCalledWith({
      level: "error",
      namespace: "runtime",
      message: "Runtime diagnostic.",
      fields: { runId: "00000000-0000-4000-8000-000000000001" },
    })
  })
  it("explicitly disables model input/output and HTTP span capture", () => {
    expect(instrumentation).toMatchObject({
      recordInputs: false,
      recordOutputs: false,
      traceChannelRequests: false,
    })
  })
})

import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

// This is a projection, never a recursive scrubber. New fields must be reviewed
// here; Error objects, stacks, URLs, headers and bodies cannot enter the sink.
export type Correlation = {
  correlationId?: string
  requestId?: string
  commandId?: string
  runId?: string
  jobId?: string
  businessRunId?: string
}
export type Operation =
  | "http"
  | "public_api"
  | "agent_http"
  | "capability_http"
  | "model_proxy"
  | "issues.write"
  | "runtime.issue-worker"
  | "teams.create"
  | "teams.update"
  | "teams.archive"
  | "teams.restore"
  | "teams.join"
  | "teams.leave"
  | "capability.invoke"
  | "agent.run"
  | "invitation.start"
  | "invitation.claim"
  | "invitation.deliver"
  | "invitation.complete"
  | "invitation.fail"
  | "mail.send"
  | "calls.sync"
  | "calls.summary"
  | "agent.retention"
  | "product.retention"
  | "workflow.health"
  | "runtime.authenticate"
  | "runtime.callback"
export type Event =
  | "api.mutation"
  | "request.completed"
  | "request.failed"
  | "operation.started"
  | "operation.completed"
  | "operation.failed"
  | "operation.rejected"
  | "run.linked"
  | "run.usage"
  | "run.failed"
  | "run.finished"
  | "job.health"
  | "lease.acquired"
  | "lease.skipped"
  | "lease.released"
export type Measurements = {
  durationMs?: number
  queueAgeMs?: number
  leaseAgeMs?: number
  costMicros?: number
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  count?: number
  failures?: number
  attempt?: number
  status?: number
}
const operations = new Set<Operation>([
  "http",
  "public_api",
  "agent_http",
  "capability_http",
  "model_proxy",
  "issues.write",
  "runtime.issue-worker",
  "teams.create",
  "teams.update",
  "teams.archive",
  "teams.restore",
  "teams.join",
  "teams.leave",
  "capability.invoke",
  "agent.run",
  "invitation.start",
  "invitation.claim",
  "invitation.deliver",
  "invitation.complete",
  "invitation.fail",
  "mail.send",
  "calls.sync",
  "calls.summary",
  "agent.retention",
  "product.retention",
  "workflow.health",
  "runtime.authenticate",
  "runtime.callback",
])
const events = new Set<Event>([
  "api.mutation",
  "request.completed",
  "request.failed",
  "operation.started",
  "operation.completed",
  "operation.failed",
  "operation.rejected",
  "run.linked",
  "run.usage",
  "run.failed",
  "run.finished",
  "job.health",
  "lease.acquired",
  "lease.skipped",
  "lease.released",
])
const errorCodes = new Set([
  "INTERNAL_ERROR",
  "ISSUE_WRITE_FAILED",
  "WORKER_EXECUTION_FAILED",
  "INVALID_INPUT",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "CONFLICT",
  "ABORTED",
  "TIMEOUT",
  "DATABASE_UNAVAILABLE",
  "CAPABILITY_EXECUTION_FAILED",
  "INVALID_CAPABILITY_INPUT",
  "CAPABILITY_NOT_FOUND",
  "CAPABILITY_RESULT_TOO_LARGE",
  "POLICY_BLOCKED",
  "IDEMPOTENCY_KEY_REQUIRED",
  "APPROVAL_REQUIRED",
  "APPROVAL_UNAVAILABLE",
  "APPROVAL_INVALID",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_BINDING_MISMATCH",
  "APPROVAL_EXPIRED",
  "APPROVAL_ALREADY_RESOLVED",
  "RUN_BINDING_MISMATCH",
  "IDEMPOTENCY_KEY_CONFLICT",
  "IDEMPOTENCY_IN_PROGRESS",
  "RUNTIME_EXECUTION_FAILED",
  "STREAM_FAILED",
  "RUN_WALL_CLOCK_LIMIT",
  "INPUT_TOKEN_LIMIT",
  "OUTPUT_TOKEN_LIMIT",
  "BUDGET_EXCEEDED",
  "WORKFLOW_START_FAILED",
  "WORKFLOW_EXECUTION_FAILED",
  "EMAIL_DELIVERY_FAILED",
  "JOB_FAILED",
  "COMMAND_REJECTED",
])
const ids = [
  "correlationId",
  "requestId",
  "commandId",
  "runId",
  "jobId",
  "businessRunId",
] as const
const measures = [
  "durationMs",
  "queueAgeMs",
  "leaseAgeMs",
  "costMicros",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "count",
  "failures",
  "attempt",
  "status",
] as const
const context = new AsyncLocalStorage<Correlation>()
const activeRequest = new AsyncLocalStorage<Request>()

export function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  )
}
export function projectCorrelation(value: Correlation): Correlation {
  return Object.fromEntries(
    ids.flatMap((key) => (validId(value[key]) ? [[key, value[key]]] : []))
  )
}
export function currentCorrelation(): Correlation {
  return { ...context.getStore() }
}
export function withCorrelation<T>(value: Correlation, run: () => T): T {
  const parent = currentCorrelation()
  return context.run(
    {
      correlationId: parent.correlationId ?? randomUUID(),
      ...parent,
      ...projectCorrelation(value),
    },
    run
  )
}
export function boundedErrorCode(value: unknown, fallback = "INTERNAL_ERROR") {
  return typeof value === "string" && errorCodes.has(value)
    ? value
    : errorCodes.has(fallback)
      ? fallback
      : "INTERNAL_ERROR"
}
export function classifyError(error: unknown) {
  // Do not read message, name, stack, cause or toJSON; these may contain payloads.
  if (error && typeof error === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code")
    if (descriptor && "value" in descriptor) {
      if (
        ["ECONNREFUSED", "ECONNRESET", "57P01", "53300"].includes(
          descriptor.value
        )
      )
        return "DATABASE_UNAVAILABLE"
      return boundedErrorCode(descriptor.value)
    }
  }
  return "INTERNAL_ERROR"
}

export function emitTelemetry(
  event: Event,
  operation: Operation,
  data: Measurements &
    Correlation & {
      errorCode?: string
      outcome?: "succeeded" | "replayed" | "rejected"
    } = {}
) {
  try {
    if (!events.has(event) || !operations.has(operation)) return
    const correlation = {
      ...projectCorrelation(currentCorrelation()),
      ...projectCorrelation(data),
    }
    correlation.correlationId ??=
      correlation.runId ??
      correlation.businessRunId ??
      correlation.jobId ??
      correlation.requestId
    const record: Record<string, unknown> = {
      schemaVersion: 1,
      event: `forge.${event}`,
      timestamp: new Date().toISOString(),
      operation,
      service: operation.startsWith("runtime.") ? "runtime" : "app",
      ...correlation,
    }
    const deployment = process.env.VERCEL_DEPLOYMENT_ID
    if (deployment && /^dpl_[A-Za-z0-9]{1,100}$/.test(deployment))
      record.deploymentId = deployment
    const revision =
      process.env.FORGE_SOURCE_REVISION ?? process.env.VERCEL_GIT_COMMIT_SHA
    if (revision && /^[a-f0-9]{40}$/i.test(revision))
      record.sourceRevision = revision
    for (const key of measures) {
      const value = data[key]
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER
      )
        record[key] = value
    }
    if (["succeeded", "replayed", "rejected"].includes(data.outcome ?? ""))
      record.outcome = data.outcome
    if (data.errorCode !== undefined)
      record.errorCode = boundedErrorCode(data.errorCode)
    console.info(JSON.stringify(record))
  } catch {
    // Diagnostic sink failure must never change a business outcome.
  }
}

export async function observeOperation<T>(
  operation: Operation,
  run: () => Promise<T>,
  correlation: Correlation = {}
): Promise<T> {
  return withCorrelation(correlation, async () => {
    const started = performance.now()
    emitTelemetry("operation.started", operation)
    try {
      const result = await run()
      const outcome = result as {
        ok?: boolean
        code?: unknown
        errorCode?: unknown
      } | null
      const rejected =
        outcome && typeof outcome === "object" && outcome.ok === false
      emitTelemetry(
        rejected ? "operation.rejected" : "operation.completed",
        operation,
        {
          durationMs: performance.now() - started,
          ...(rejected
            ? {
                errorCode: boundedErrorCode(
                  outcome.errorCode ?? outcome.code,
                  "COMMAND_REJECTED"
                ),
              }
            : {}),
        }
      )
      return result
    } catch (error) {
      const status =
        error && typeof error === "object"
          ? Object.getOwnPropertyDescriptor(error, "statusCode")?.value
          : undefined
      emitTelemetry("operation.failed", operation, {
        durationMs: performance.now() - started,
        errorCode: classifyError(error),
        ...(typeof status === "number" && status >= 100 && status <= 599
          ? { status }
          : {}),
      })
      throw error
    }
  })
}
export function observeCommand<T>(operation: Operation, run: () => Promise<T>) {
  return observeOperation(operation, run, {
    commandId: currentCorrelation().commandId ?? randomUUID(),
  })
}

// Async generators execute when consumed, often after the request has returned.
// Re-enter a captured context for every next/return/throw, including reconnects.
export function correlateIterable<T>(
  iterable: AsyncIterable<T>,
  correlation: Correlation
): AsyncIterable<T> {
  const captured = projectCorrelation({
    correlationId: correlation.runId ?? randomUUID(),
    ...currentCorrelation(),
    ...correlation,
  })
  return {
    [Symbol.asyncIterator]() {
      const iterator = iterable[Symbol.asyncIterator]()
      return {
        next: (...args: [] | [undefined]) =>
          withCorrelation(captured, async () => {
            try {
              return await iterator.next(...args)
            } catch (error) {
              emitTelemetry("run.failed", "agent.run", {
                errorCode: classifyError(error),
              })
              throw error
            }
          }),
        return: (value?: unknown) =>
          withCorrelation(captured, () =>
            iterator.return
              ? iterator.return(value)
              : Promise.resolve({ done: true as const, value: value as T })
          ),
        throw: (error?: unknown) =>
          withCorrelation(captured, () =>
            iterator.throw ? iterator.throw(error) : Promise.reject(error)
          ),
      }
    },
  }
}

export async function observeRequest(
  request: Request,
  operation: Operation,
  handle: () => Promise<Response>
): Promise<Response> {
  // A global middleware and directly testable transport handlers may both wrap
  // the same request. Only the outer wrapper assigns identity and emits latency.
  if (activeRequest.getStore() === request) return handle()
  const requestId = randomUUID()
  const supplied =
    request.headers.get("x-correlation-id") ??
    request.headers.get("x-request-id")
  return activeRequest.run(request, () =>
    withCorrelation(
      { requestId, correlationId: validId(supplied) ? supplied : requestId },
      async () => {
        const started = performance.now()
        const finish = (response: Response) => {
          const headers = new Headers(response.headers)
          headers.set("x-request-id", requestId)
          headers.set("x-correlation-id", currentCorrelation().correlationId!)
          emitTelemetry(
            response.status >= 500 ? "request.failed" : "request.completed",
            operation,
            {
              status: response.status,
              durationMs: performance.now() - started,
              ...(response.status >= 500
                ? { errorCode: "INTERNAL_ERROR" }
                : {}),
            }
          )
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        }
        try {
          return finish(await handle())
        } catch (error) {
          if (error instanceof Response) return finish(error)
          emitTelemetry("request.failed", operation, {
            status: 500,
            durationMs: performance.now() - started,
            errorCode: classifyError(error),
          })
          return Response.json(
            {
              error: {
                code: "INTERNAL_ERROR",
                message: "The request could not be completed.",
              },
            },
            {
              status: 500,
              headers: {
                "cache-control": "no-store",
                "x-request-id": requestId,
                "x-correlation-id": currentCorrelation().correlationId!,
              },
            }
          )
        }
      }
    )
  )
}

export async function runJob(operation: Operation, run: () => Promise<void>) {
  await observeOperation(operation, run, { jobId: randomUUID() }).catch(() => {
    // The bounded failure was already recorded; don't let the CLI print the raw exception.
    process.exitCode = 1
  })
}

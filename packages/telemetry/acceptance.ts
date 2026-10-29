import { randomUUID } from "node:crypto"
import {
  currentCorrelation,
  emitTelemetry,
  observeCommand,
  observeOperation,
  validId,
  withCorrelation,
} from "./server.js"

// Synthetic values only. They are deliberately placed in exceptions to prove
// that diagnostics cannot serialize payloads before the caller handles failure.
export const ACCEPTANCE_FIXTURES = [
  "sk-for29-synthetic-token-do-not-log",
  "FOR29 synthetic private transcript do not log",
  "https://fixture.invalid/file?signature=for29-synthetic-private",
] as const
export type AcceptanceEnvelope = {
  correlationId: string
  requestId: string
  commandId: string
  runId: string
}
export type WorkerFailure = {
  outcome: "failed"
  errorCode: "WORKER_EXECUTION_FAILED"
  envelope: AcceptanceEnvelope
}

export function acceptanceEnvelope(value: unknown): AcceptanceEnvelope {
  if (!value || typeof value !== "object")
    throw new Error("Invalid acceptance envelope.")
  const fields = ["correlationId", "requestId", "commandId", "runId"] as const
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !validId(Reflect.get(value, key)))
  ) {
    throw new Error("Invalid acceptance envelope.")
  }
  return Object.fromEntries(
    fields.map((key) => [key, Reflect.get(value, key)])
  ) as AcceptanceEnvelope
}

export async function failSyntheticIssueWrite(
  envelope: AcceptanceEnvelope
): Promise<WorkerFailure> {
  return withCorrelation(envelope, async () => {
    try {
      await observeOperation("runtime.issue-worker", () =>
        Promise.reject(
          Object.assign(new Error(ACCEPTANCE_FIXTURES.join("\n")), {
            code: "WORKER_EXECUTION_FAILED",
            name: ACCEPTANCE_FIXTURES[0],
            cause: {
              transcript: ACCEPTANCE_FIXTURES[1],
              url: ACCEPTANCE_FIXTURES[2],
            },
          })
        )
      )
    } catch {
      return {
        outcome: "failed",
        errorCode: "WORKER_EXECUTION_FAILED",
        envelope,
      }
    }
    throw new Error("The injected worker failure did not execute.")
  })
}

export async function runIssueWriteAcceptance(
  dispatch: (envelope: AcceptanceEnvelope) => Promise<WorkerFailure>
) {
  let worker: WorkerFailure | undefined
  const runId = randomUUID()
  try {
    await observeCommand("issues.write", async () => {
      const envelope = acceptanceEnvelope({ ...currentCorrelation(), runId })
      emitTelemetry("run.linked", "issues.write", envelope)
      worker = await dispatch(envelope)
      if (
        worker.outcome !== "failed" ||
        worker.errorCode !== "WORKER_EXECUTION_FAILED" ||
        JSON.stringify(acceptanceEnvelope(worker.envelope)) !==
          JSON.stringify(envelope)
      ) {
        throw new Error(
          "The acceptance worker did not confirm its correlation."
        )
      }
      throw Object.assign(
        new Error("Synthetic issue write failed downstream."),
        { code: "ISSUE_WRITE_FAILED" }
      )
    })
  } catch (error) {
    if (
      worker &&
      error &&
      typeof error === "object" &&
      Reflect.get(error, "code") === "ISSUE_WRITE_FAILED"
    ) {
      return {
        scenario: "synthetic-issue-write-failure" as const,
        outcome: "passed" as const,
        errorCode: "ISSUE_WRITE_FAILED" as const,
        worker,
      }
    }
    // An unavailable/malformed worker is an acceptance failure, not a passing
    // injected error. Do not return its body or exception.
    throw new Error("Observability acceptance did not complete.")
  }
  throw new Error("The injected command failure did not execute.")
}

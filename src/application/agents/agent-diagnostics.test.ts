import { describe, expect, it } from "vitest"

import { summarizeAgentDiagnostics } from "@/application/agents/agent-diagnostics"

describe("agent diagnostics", () => {
  it("aggregates release metrics without copying prompts or tool payloads", () => {
    const since = new Date("2026-07-01T00:00:00.000Z")
    const result = summarizeAgentDiagnostics({
      since,
      runs: [
        {
          id: "run-1",
          state: "completed",
          executionKind: "forge-native",
          requestedSelection: { mode: "auto", provider: "openai" },
          resolvedModelId: "gpt-5.6-terra",
          reasoningEffort: "medium",
          routingReason: JSON.stringify({ difficulty: "standard" }),
          inputTokens: 100,
          outputTokens: 25,
          cachedInputTokens: 10,
          costMicros: 900,
          createdAt: new Date("2026-07-24T10:00:00.000Z"),
          startedAt: new Date("2026-07-24T10:00:01.000Z"),
          completedAt: new Date("2026-07-24T10:00:03.000Z"),
        },
      ],
      events: [
        {
          runId: "run-1",
          type: "run.created",
          occurredAt: new Date("2026-07-24T10:00:00.000Z"),
        },
        {
          runId: "run-1",
          type: "progress.note",
          payload: { state: "reconnecting", privateDetail: "not reported" },
          occurredAt: new Date("2026-07-24T10:00:00.250Z"),
        },
        {
          runId: "run-1",
          type: "code.started",
          occurredAt: new Date("2026-07-24T10:00:00.300Z"),
        },
        {
          runId: "run-1",
          type: "code.completed",
          occurredAt: new Date("2026-07-24T10:00:00.400Z"),
        },
        {
          runId: "run-1",
          type: "assistant.delta",
          occurredAt: new Date("2026-07-24T10:00:00.500Z"),
        },
      ],
      approvals: [{ state: "approved" }],
      invocations: [{ outcome: "succeeded", durationMs: 42 }],
    })

    expect(result).toMatchObject({
      runs: {
        total: 1,
        states: { completed: 1 },
        durationMs: { p50: 2_000, p95: 2_000 },
        timeToFirstProgressMs: { p50: 250, p95: 250 },
        timeToFirstTokenMs: { p50: 500, p95: 500 },
        rates: { completion: 1, cancellation: 0, failure: 0 },
      },
      routing: {
        providers: { openai: 1 },
        models: { "gpt-5.6-terra": 1 },
        autoDifficulties: { standard: 1 },
      },
      usage: { inputTokens: 100, outputTokens: 25, costMicros: 900 },
      approvals: {
        states: { approved: 1 },
        acceptanceRate: 1,
        denialRate: 0,
      },
      tools: {
        calls: 1,
        failures: 0,
        failureRate: 0,
        latencyMs: { p50: 42, p95: 42 },
      },
      sandbox: {
        starts: 1,
        completions: 1,
        failures: 0,
        failureRate: 0,
      },
      recovery: { reconnects: 1, reconnectedRuns: 1 },
    })
    expect(JSON.stringify(result)).not.toContain("prompt")
    expect(JSON.stringify(result)).not.toContain("payload")
  })
})

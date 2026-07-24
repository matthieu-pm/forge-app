import { describe, expect, it } from "vitest"

import { agentCommandSchema } from "@/application/agents/agent-contract"
import { agentEventSchema } from "@/application/agents/event-contract"
import { capabilityResultSchema } from "@/application/agents/capability-contract"

const threadId = "00000000-0000-4000-8000-000000000001"
const runId = "00000000-0000-4000-8000-000000000002"
const connectionId = "00000000-0000-4000-8000-000000000003"

describe("agent contracts", () => {
  it("requires manual turns to name a connection-qualified model", () => {
    expect(() =>
      agentCommandSchema.parse({
        type: "turn.start",
        input: {
          threadId,
          message: "Summarize the workspace",
          selectionMode: "manual",
        },
      })
    ).toThrow("Manual selection requires a model")

    expect(
      agentCommandSchema.parse({
        type: "turn.start",
        input: {
          threadId,
          message: "Summarize the workspace",
          selectionMode: "manual",
          model: {
            selectionId: "openai-personal:gpt-5.6-terra",
            connectionId,
            executionKind: "forge-native",
            provider: "openai",
            modelId: "gpt-5.6-terra",
          },
        },
      })
    ).toMatchObject({ type: "turn.start" })
  })

  it("rejects a pinned model in Auto mode", () => {
    expect(() =>
      agentCommandSchema.parse({
        type: "turn.start",
        input: {
          threadId,
          message: "Summarize the workspace",
          selectionMode: "auto",
          model: {
            selectionId: "openai-personal:gpt-5.6-terra",
            connectionId,
            executionKind: "forge-native",
            provider: "openai",
            modelId: "gpt-5.6-terra",
          },
        },
      })
    ).toThrow("Auto selection cannot pin a model")
  })

  it("validates canonical runtime events", () => {
    const event = agentEventSchema.parse({
      id: "00000000-0000-4000-8000-000000000004",
      sourceEventId: "eve-1",
      threadId,
      runId,
      sequence: 1,
      occurredAt: "2026-07-23T20:00:00.000Z",
      source: "eve",
      type: "tool.started",
      payload: { capabilityId: "teams.list" },
    })

    expect(event.schemaVersion).toBe(1)
  })

  it("requires structured details for failed capability results", () => {
    expect(() => capabilityResultSchema.parse({ ok: false })).toThrow(
      "structured error"
    )
    expect(
      capabilityResultSchema.parse({
        ok: false,
        errorCode: "FORBIDDEN",
        errorMessage: "The actor cannot invoke this capability.",
      })
    ).toMatchObject({ ok: false })
  })
})

import { describe, expect, it } from "vitest"

import {
  MAX_INLINE_AGENT_EVENT_BYTES,
  assertSafeAgentEventPayload,
} from "@/application/agents/event-safety"

describe("agent event payload safety", () => {
  it.each([
    { authorization: "Bearer credential" },
    { nested: { api_key: "value" } },
    { output: "The leaked key is sk-proj-abcdefghijklmnop" },
    { output: "The leaked key is sk-ant-api03-abcdefghijklmnop" },
    { output: "The leaked key is AIzaabcdefghijklmnopqrstuvwx" },
    { output: "-----BEGIN PRIVATE KEY-----" },
  ])("rejects credentials before persistence", (payload) => {
    expect(() => assertSafeAgentEventPayload(payload)).toThrow(
      "cannot contain credentials"
    )
  })

  it("requires oversized output to use an artifact", () => {
    expect(() =>
      assertSafeAgentEventPayload({
        output: "x".repeat(MAX_INLINE_AGENT_EVENT_BYTES),
      })
    ).toThrow("as an artifact")
  })

  it("allows normal structured tool output", () => {
    expect(() =>
      assertSafeAgentEventPayload({
        teams: [{ id: "team-1", name: "Forge" }],
      })
    ).not.toThrow()
  })
})

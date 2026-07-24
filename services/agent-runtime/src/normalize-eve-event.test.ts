import { describe, expect, it } from "vitest"

import { normalizeEveEvent } from "./normalize-eve-event.js"

describe("normalizeEveEvent", () => {
  it("maps EVE message and tool events to Forge runtime events", () => {
    expect(
      normalizeEveEvent(
        {
          id: "eve-1",
          type: "message.completed",
          data: { content: "Done" },
        },
        "fallback"
      )
    ).toEqual({
      sourceEventId: "eve-1",
      source: "eve",
      type: "assistant.message",
      payload: { content: "Done" },
    })
  })

  it("ignores EVE lifecycle events owned by the coordinator", () => {
    expect(
      normalizeEveEvent({ type: "session.completed" }, "fallback")
    ).toBeNull()
  })

  it("emits typed code events for sandbox actions", () => {
    expect(
      normalizeEveEvent(
        {
          id: "eve-code-1",
          type: "actions.requested",
          data: { toolName: "run_code", callId: "call-1" },
        },
        "fallback"
      )
    ).toMatchObject({
      type: "code.started",
      payload: { toolName: "run_code", callId: "call-1" },
    })
    expect(
      normalizeEveEvent(
        {
          id: "eve-code-2",
          type: "action.result",
          data: {
            action: { name: "run_code" },
            callId: "call-1",
            stdout: "42",
          },
        },
        "fallback"
      )
    ).toMatchObject({ type: "code.completed" })
  })
})

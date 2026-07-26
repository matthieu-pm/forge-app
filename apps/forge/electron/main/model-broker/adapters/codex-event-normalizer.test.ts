import { describe, expect, it } from "vitest"

import {
  CodexEventNormalizer,
  parseCodexServerRequest,
} from "./codex-event-normalizer"

describe("Codex event normalization", () => {
  it("normalizes streaming assistant output and the authoritative message", () => {
    const normalizer = new CodexEventNormalizer()
    expect(
      normalizer.normalize({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-1",
          delta: "Hello",
        },
      })
    ).toMatchObject([
      {
        type: "assistant.delta",
        payload: { messageId: "message-1", delta: "Hello" },
      },
    ])
    expect(
      normalizer.normalize({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "message-1",
            type: "agentMessage",
            status: "completed",
            text: "Hello there",
          },
        },
      })
    ).toMatchObject([
      {
        type: "assistant.message",
        payload: { messageId: "message-1", content: "Hello there" },
      },
    ])
  })

  it("does not expose raw reasoning text", () => {
    const normalizer = new CodexEventNormalizer()
    expect(
      normalizer.normalize({
        method: "item/reasoning/textDelta",
        params: { itemId: "reasoning-1", delta: "private chain of thought" },
      })
    ).toEqual([])
    expect(
      normalizer.normalize({
        method: "item/reasoning/summaryTextDelta",
        params: { itemId: "reasoning-1", delta: "Checking the workspace" },
      })
    ).toMatchObject([
      {
        type: "progress.note",
        payload: { delta: "Checking the workspace" },
      },
    ])
  })

  it.each([
    ["commandExecution", "code.started", "code.completed"],
    ["fileChange", "file.patch.proposed", "file.patch.applied"],
    ["webSearch", "file.search.started", "file.search.completed"],
    ["dynamicToolCall", "tool.started", "tool.completed"],
  ])("maps %s lifecycle events", (itemType, started, completed) => {
    const normalizer = new CodexEventNormalizer()
    const item = { id: "item-1", type: itemType, status: "completed" }
    expect(
      normalizer.normalize({
        method: "item/started",
        params: { item },
      })[0]?.type
    ).toBe(started)
    expect(
      normalizer.normalize({
        method: "item/completed",
        params: { item },
      })[0]?.type
    ).toBe(completed)
  })

  it("promotes activity details used by the transcript", () => {
    const normalizer = new CodexEventNormalizer()
    expect(
      normalizer.normalize({
        method: "item/started",
        params: {
          item: {
            id: "command-1",
            type: "commandExecution",
            status: "inProgress",
            command: ["bun", "test"],
            title: "Run the focused test suite",
          },
        },
      })
    ).toMatchObject([
      {
        type: "code.started",
        payload: {
          callId: "command-1",
          command: "bun test",
          title: "Run the focused test suite",
        },
      },
    ])

    expect(
      normalizer.normalize({
        method: "item/completed",
        params: {
          item: {
            id: "search-1",
            type: "webSearch",
            status: "completed",
            query: "Forge agent activity",
          },
        },
      })
    ).toMatchObject([
      {
        type: "file.search.completed",
        payload: { query: "Forge agent activity" },
      },
    ])
  })

  it("parses approval requests without treating them as responses", () => {
    expect(
      parseCodexServerRequest({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-1",
          command: ["git", "status"],
          reason: "Inspect the working tree",
        },
      })
    ).toMatchObject({
      requestId: "approval-1",
      itemId: "command-1",
      summary: "Inspect the working tree",
      details: { command: "git status" },
    })
  })

  it("parses dynamic tool calls independently from approvals", () => {
    expect(
      parseCodexServerRequest({
        id: 60,
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "forge",
          tool: "teams_list",
          arguments: { limit: 10 },
        },
      })
    ).toEqual({
      requestId: 60,
      method: "item/tool/call",
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: "forge",
      tool: "teams_list",
      arguments: { limit: 10 },
    })
  })
})

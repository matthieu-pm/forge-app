import { describe, expect, it } from "vitest"

import { normalizeEveRuntimeEvent } from "@/adapters/agents/eve-event-normalizer"

describe("EVE event normalizer", () => {
  it("normalizes assistant deltas without persisting raw reasoning", () => {
    expect(
      normalizeEveRuntimeEvent(
        {
          type: "message.appended",
          data: {
            messageDelta: "Hello",
            messageSoFar: "Hello",
            sequence: 4,
            stepIndex: 0,
            turnId: "turn-1",
          },
        },
        "session-1"
      )
    ).toMatchObject([
      {
        sourceEventId: "session-1:message.appended:4",
        type: "assistant.delta",
        payload: { delta: "Hello" },
      },
    ])

    expect(
      normalizeEveRuntimeEvent(
        {
          type: "reasoning.appended",
          data: { reasoningDelta: "hidden", sequence: 5 },
        },
        "session-1"
      )
    ).toEqual([])
  })

  it.each([
    ["bash", "code.started"],
    ["execute_program", "code.started"],
    ["grep", "file.search.started"],
    ["read_file", "tool.started"],
    ["write_file", "file.patch.proposed"],
    ["list_teams", "tool.started"],
  ])("maps %s action requests to %s", (toolName, type) => {
    expect(
      normalizeEveRuntimeEvent(
        {
          type: "actions.requested",
          data: {
            sequence: 6,
            actions: [
              {
                callId: "call-1",
                kind: "tool-call",
                toolName,
                input: {},
              },
            ],
          },
        },
        "session-1"
      )
    ).toMatchObject([{ type }])
  })

  it("normalizes EVE authorization as a structured approval request", () => {
    expect(
      normalizeEveRuntimeEvent(
        {
          type: "authorization.required",
          data: {
            sequence: 7,
            capabilityId: "teams.update",
            risk: "reversible-write",
            summary: "Update the Forge team description",
            input: { slug: "forge" },
          },
        },
        "session-1"
      )
    ).toMatchObject([
      {
        type: "approval.requested",
        payload: {
          capabilityId: "teams.update",
          capabilityVersion: "1",
          risk: "reversible-write",
          summary: "Update the Forge team description",
          input: { slug: "forge" },
        },
      },
    ])
  })

  it("normalizes EVE tool approval input with its durable request binding", () => {
    expect(
      normalizeEveRuntimeEvent(
        {
          type: "input.requested",
          data: {
            sequence: 8,
            stepIndex: 1,
            turnId: "turn-1",
            requests: [
              {
                requestId: "request-1",
                prompt: "Allow updating the Forge team?",
                display: "confirmation",
                action: {
                  callId: "call-1",
                  kind: "tool-call",
                  toolName: "update_team",
                  input: {
                    slug: "forge",
                    settings: { description: "Updated" },
                  },
                },
                options: [
                  { id: "approve", label: "Approve" },
                  { id: "deny", label: "Deny" },
                ],
              },
            ],
          },
        },
        "session-1"
      )
    ).toMatchObject([
      {
        sourceEventId: "session-1:input.requested:8:request-1",
        type: "approval.requested",
        payload: {
          capabilityId: "teams.update",
          risk: "reversible-write",
          input: {
            slug: "forge",
            settings: { description: "Updated" },
          },
          details: {
            runtimeRequestId: "request-1",
            callId: "call-1",
            toolName: "update_team",
          },
        },
      },
    ])
  })

  it("binds a program write approval to its declared manifest", () => {
    expect(
      normalizeEveRuntimeEvent(
        {
          type: "input.requested",
          data: {
            sequence: 8,
            requests: [
              {
                requestId: "request-program-1",
                prompt: "Allow this program to update a team?",
                display: "confirmation",
                action: {
                  callId: "program-1",
                  kind: "tool-call",
                  toolName: "execute_program",
                  input: {
                    language: "javascript",
                    code: "return forge.call('teams.update', input)",
                    capabilityManifest: [
                      {
                        id: "teams.update",
                        version: "1",
                        maximumCalls: 1,
                      },
                    ],
                    timeoutMs: 1_000,
                  },
                },
              },
            ],
          },
        },
        "session-1"
      )
    ).toMatchObject([
      {
        type: "approval.requested",
        payload: {
          capabilityId: "program.execute",
          risk: "reversible-write",
          details: {
            programManifest: [
              { id: "teams.update", version: "1", maximumCalls: 1 },
            ],
          },
        },
      },
    ])
  })

  it("normalizes model usage without provider metadata or credentials", () => {
    expect(
      normalizeEveRuntimeEvent(
        {
          type: "step.completed",
          data: {
            sequence: 9,
            stepIndex: 1,
            turnId: "turn-1",
            finishReason: "stop",
            usage: {
              inputTokens: 120,
              outputTokens: 30,
              cacheReadTokens: 40,
              costUsd: 0.00125,
            },
            providerMetadata: { requestId: "not-persisted" },
          },
        },
        "session-1"
      )
    ).toMatchObject([
      {
        type: "run.usage",
        payload: {
          inputTokens: 120,
          outputTokens: 30,
          cachedInputTokens: 40,
          costMicros: 1250,
        },
      },
    ])
  })

  it("emits typed tool rows for Forge calls made by generated JavaScript", () => {
    expect(
      normalizeEveRuntimeEvent(
        {
          type: "action.result",
          data: {
            sequence: 10,
            status: "completed",
            result: {
              callId: "program-1",
              kind: "tool-call",
              toolName: "execute_program",
              output: {
                result: { names: ["Forge"] },
                calls: [
                  {
                    capabilityId: "teams.list",
                    input: { limit: 10 },
                    result: { items: [{ id: "team-1", name: "Forge" }] },
                  },
                ],
              },
            },
          },
        },
        "session-1"
      )
    ).toMatchObject([
      {
        type: "tool.completed",
        payload: {
          callId: "program-1:program:0",
          toolName: "teams.list",
          input: { limit: 10 },
        },
      },
      {
        type: "code.completed",
        payload: { callId: "program-1", toolName: "execute_program" },
      },
    ])
  })

  it("emits a stable artifact event for a generated file", () => {
    const artifactId = "00000000-0000-4000-8000-000000000030"
    expect(
      normalizeEveRuntimeEvent(
        {
          type: "action.result",
          data: {
            sequence: 11,
            status: "completed",
            result: {
              callId: "artifact-call-1",
              kind: "tool-call",
              toolName: "create_artifact",
              output: {
                type: "json",
                value: {
                  id: artifactId,
                  runId: "00000000-0000-4000-8000-000000000020",
                  kind: "report",
                  name: "summary.md",
                  contentType: "text/markdown",
                  sizeBytes: 128,
                  checksum: "a".repeat(64),
                },
              },
            },
          },
        },
        "session-1"
      )
    ).toMatchObject([
      {
        sourceEventId: `artifact:${artifactId}`,
        type: "artifact.created",
        payload: {
          id: artifactId,
          name: "summary.md",
          contentType: "text/markdown",
        },
      },
      {
        type: "tool.completed",
        payload: {
          callId: "artifact-call-1",
          toolName: "create_artifact",
        },
      },
    ])
  })
})

import { describe, expect, it, vi } from "vitest"

import type { AgentEvent } from "@/application/agents/event-contract"
import type { ForgeHost, HostEvent } from "@/host/forge-host"
import { DesktopAgentClient } from "@/lib/agent-client/desktop-agent-client"

const threadId = "00000000-0000-4000-8000-000000000020"
const runId = "00000000-0000-4000-8000-000000000010"

function event(
  type: AgentEvent["type"],
  sequence: number,
  payload: Record<string, unknown>
): AgentEvent {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sourceEventId: `source-${sequence}`,
    threadId,
    runId,
    sequence,
    occurredAt: "2026-07-24T00:00:00.000Z",
    source: sequence <= 3 ? "forge" : "codex",
    type,
    schemaVersion: 1,
    payload,
  }
}

describe("DesktopAgentClient", () => {
  it("starts Codex locally and persists each event through the run token", async () => {
    let listener: ((event: HostEvent) => void) | null = null
    const host = {
      subscribe: vi.fn((next) => {
        listener = next
        return () => {
          listener = null
        }
      }),
      startLocalRuntimeRun: vi.fn(async () => {
        queueMicrotask(() => {
          listener?.({
            type: "local-agent-event",
            message: {
              type: "runtime-event",
              runId,
              event: {
                sourceEventId: "codex-message",
                source: "codex",
                type: "assistant.message",
                occurredAt: "2026-07-24T00:00:01.000Z",
                payload: { messageId: "message-1", content: "Done" },
              },
            },
          })
          listener?.({
            type: "local-agent-event",
            message: {
              type: "runtime-event",
              runId,
              event: {
                sourceEventId: "codex-tool-started",
                source: "codex",
                type: "tool.started",
                occurredAt: "2026-07-24T00:00:02.000Z",
                payload: { callId: "call-1", toolName: "teams_list" },
              },
            },
          })
          listener?.({
            type: "local-agent-event",
            message: {
              type: "tool-call-request",
              runId,
              requestId: "90000000-0000-4000-8000-000000000001",
              namespace: "forge",
              tool: "teams_list",
              arguments: { limit: 10 },
            },
          })
        })
        return {
          runtimeSessionId: "codex-thread-1",
          runtimeRunId: "codex-turn-1",
        }
      }),
      cancelLocalRuntimeRun: vi.fn().mockResolvedValue(undefined),
      resolveLocalRuntimeToolCall: vi.fn(async () => {
        queueMicrotask(() => {
          listener?.({
            type: "local-agent-event",
            message: {
              type: "runtime-event",
              runId,
              event: {
                sourceEventId: "codex-tool-completed",
                source: "codex",
                type: "tool.completed",
                occurredAt: "2026-07-24T00:00:03.000Z",
                payload: {
                  callId: "call-1",
                  toolName: "teams_list",
                  output: { items: [], nextCursor: null },
                },
              },
            },
          })
          listener?.({
            type: "local-agent-event",
            message: {
              type: "runtime-event",
              runId,
              event: {
                sourceEventId: "codex-completed",
                source: "codex",
                type: "run.completed",
                occurredAt: "2026-07-24T00:00:04.000Z",
                payload: {},
              },
            },
          })
        })
      }),
    } as unknown as ForgeHost

    let sequence = 3
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith("/local-runs")) {
          return Response.json(
            {
              run: { id: runId },
              initialEvents: [
                event("run.created", 1, {}),
                event("run.routing-resolved", 2, {}),
                event("run.started", 3, {}),
              ],
              runtimeSessionId: null,
              attachments: [],
              ingestToken: "opaque-run-token",
            },
            { status: 201 }
          )
        }
        if (url.includes(`/local-runs/${runId}`)) {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer opaque-run-token"
          )
          return Response.json({ ok: true })
        }
        if (url.endsWith("/local-ingest")) {
          const body = JSON.parse(String(init?.body)) as {
            events: Array<{
              sourceEventId: string
              source: "codex"
              type: AgentEvent["type"]
              payload: Record<string, unknown>
            }>
          }
          const runtimeEvent = body.events[0]
          sequence += 1
          return Response.json([
            {
              ...event(runtimeEvent.type, sequence, runtimeEvent.payload),
              sourceEventId: runtimeEvent.sourceEventId,
              source: runtimeEvent.source,
            },
          ])
        }
        if (url.endsWith("/local-tool-calls")) {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer opaque-run-token"
          )
          return Response.json({
            success: true,
            output: { items: [], nextCursor: null },
          })
        }
        throw new Error(`Unexpected request ${url}`)
      }
    )
    const client = new DesktopAgentClient(
      host,
      undefined,
      "/api/agent",
      fetcher as typeof fetch
    )

    const events: Array<AgentEvent> = []
    for await (const next of client.streamTurn({
      threadId,
      message: "Summarize this workspace",
      selectionMode: "manual",
      model: {
        selectionId: "local:codex:gpt-codex",
        connectionId: "00000000-0000-4000-8000-000000000099",
        executionKind: "external-agent",
        provider: "openai",
        modelId: "gpt-codex",
      },
      reasoningEffort: "high",
      attachmentIds: [],
    })) {
      events.push(next)
    }

    expect(events.map((next) => next.type)).toEqual([
      "run.created",
      "run.routing-resolved",
      "run.started",
      "assistant.message",
      "tool.started",
      "tool.completed",
      "run.completed",
    ])
    expect(host.startLocalRuntimeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        modelId: "gpt-codex",
        reasoningEffort: "high",
      })
    )
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/local-ingest")
      )
    ).toHaveLength(4)
    expect(host.resolveLocalRuntimeToolCall).toHaveBeenCalledWith({
      runId,
      requestId: "90000000-0000-4000-8000-000000000001",
      success: true,
      output: { items: [], nextCursor: null },
    })
  })
})

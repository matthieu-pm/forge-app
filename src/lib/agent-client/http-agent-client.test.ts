// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { HttpAgentClient } from "@/lib/agent-client/http-agent-client"

const threadId = "00000000-0000-4000-8000-000000000001"
const runId = "00000000-0000-4000-8000-000000000002"

function event(sequence: number, type: "run.created" | "run.completed") {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sourceEventId: `${runId}:${type}`,
    threadId,
    runId,
    sequence,
    occurredAt: "2026-07-24T00:00:00.000Z",
    source: "forge",
    type,
    schemaVersion: 1,
    payload: type === "run.created" ? { message: "Hello" } : {},
  }
}

describe("HTTP agent client stream recovery", () => {
  it("does not rebind the browser fetch receiver to the client instance", async () => {
    const receiverCheckedFetch = vi.fn(function (
      this: unknown,
      _input: RequestInfo | URL
    ) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError(
          "Failed to execute 'fetch' on 'Window': Illegal invocation"
        )
      }
      return Promise.resolve(
        Response.json({
          agent_ui: true,
          agent_model_connections: true,
        })
      )
    })
    vi.stubGlobal("fetch", receiverCheckedFetch)

    try {
      const client = new HttpAgentClient()

      await expect(client.getFeatureFlags()).resolves.toMatchObject({
        agent_ui: true,
        agent_model_connections: true,
      })
      expect(receiverCheckedFetch.mock.contexts[0]).not.toBe(client)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("replays from the last sequence when the live stream ends early", async () => {
    const created = event(1, "run.created")
    const completed = event(2, "run.completed")
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(`id: 1\ndata: ${JSON.stringify(created)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      )
      .mockResolvedValueOnce(Response.json([completed]))
    const client = new HttpAgentClient("/api/agent", fetcher, 0)
    const events = []

    for await (const received of client.streamTurn({
      threadId,
      message: "Hello",
      selectionMode: "auto",
      attachmentIds: [],
    })) {
      events.push(received)
    }

    expect(events.map((received) => received.type)).toEqual([
      "run.created",
      "run.completed",
    ])
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/api/agent/runs/${runId}/events?after=1`
    )
  })
})

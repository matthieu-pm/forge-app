// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ReconnectRuntimeRunInput,
  ResumeRuntimeRunInput,
  StartRuntimeRunInput,
} from "@/application/agents/runtime-contract"
import { EveAgentRuntime } from "@/adapters/agents/eve-runtime.server"

function runtimeInput(
  checkpointRuntimeSession: (runtimeSessionId: string) => Promise<void>
): StartRuntimeRunInput {
  return {
    threadId: "00000000-0000-4000-8000-000000000010",
    runId: "00000000-0000-4000-8000-000000000020",
    identity: {
      workspaceId: "workspace-1",
      userId: "user-1",
      workspaceRole: "member",
    },
    message: "List the teams",
    model: {
      selectionId: "00000000-0000-4000-8000-000000000030:gpt-5.6-luna",
      connectionId: "00000000-0000-4000-8000-000000000030",
      executionKind: "forge-native",
      provider: "openai",
      modelId: "gpt-5.6-luna",
    },
    reasoningEffort: "low",
    attachments: [],
    runtimeSessionId: null,
    checkpointRuntimeSession,
  }
}

async function collect<T>(iterable: AsyncIterable<T>) {
  const values: Array<T> = []
  for await (const value of iterable) values.push(value)
  return values
}

describe("EVE runtime adapter", () => {
  beforeEach(() => {
    process.env.FORGE_AGENT_CAPABILITY_SECRET =
      "test-secret-that-is-at-least-thirty-two-characters"
    process.env.FORGE_AGENT_MODEL_ACCESS_SECRET =
      "model-access-test-secret-with-at-least-32-characters"
  })

  afterEach(() => {
    delete process.env.FORGE_AGENT_CAPABILITY_SECRET
    delete process.env.FORGE_AGENT_MODEL_ACCESS_SECRET
  })

  it("starts an authenticated session, normalizes NDJSON, and checkpoints", async () => {
    const stream = [
      {
        type: "message.appended",
        data: {
          messageDelta: "Done",
          messageSoFar: "Done",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      {
        type: "message.completed",
        data: {
          message: "Done",
          finishReason: "stop",
          sequence: 2,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      {
        type: "session.waiting",
        data: { continuationToken: "eve:next", sequence: 3 },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")
      .concat("\n")
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          sessionId: "ses_1",
          continuationToken: "eve:first",
        })
      )
      .mockResolvedValueOnce(
        new Response(stream, {
          headers: { "content-type": "application/x-ndjson" },
        })
      )
    const checkpoints: Array<string> = []
    const runtime = new EveAgentRuntime({
      baseUrl: "http://eve.test",
      channelSecret: "channel-secret-that-is-at-least-thirty-two-characters",
      fetcher,
    })

    const events = await collect(
      runtime.start(
        runtimeInput((checkpoint) => {
          checkpoints.push(checkpoint)
          return Promise.resolve()
        })
      )
    )

    expect(events.map((event) => event.type)).toEqual([
      "assistant.delta",
      "assistant.message",
    ])
    expect(checkpoints.length).toBeGreaterThanOrEqual(4)
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      new URL("http://eve.test/eve/v1/session"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Bearer /),
        }),
      })
    )
    const firstRequest = fetcher.mock.calls[0]?.[1]
    expect(JSON.parse(String(firstRequest?.body))).toMatchObject({
      message: "List the teams",
    })
  })

  it("starts a new session when EVE omits the continuation token from the delivery response", async () => {
    const stream = [
      {
        type: "message.completed",
        data: {
          message: "Done",
          finishReason: "stop",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      {
        type: "session.waiting",
        data: { continuationToken: "eve:next", sequence: 2 },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")
      .concat("\n")
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: true,
            sessionId: "ses_1",
          },
          { status: 202 }
        )
      )
      .mockResolvedValueOnce(new Response(stream))
    const checkpoints: Array<string> = []
    const runtime = new EveAgentRuntime({
      baseUrl: "http://eve.test",
      channelSecret: "channel-secret-that-is-at-least-thirty-two-characters",
      fetcher,
    })

    const events = await collect(
      runtime.start(
        runtimeInput((checkpoint) => {
          checkpoints.push(checkpoint)
          return Promise.resolve()
        })
      )
    )

    expect(events).toEqual([
      expect.objectContaining({
        type: "assistant.message",
        payload: expect.objectContaining({ content: "Done" }),
      }),
    ])
    expect(checkpoints).not.toHaveLength(0)
    const finalCheckpoint = JSON.parse(
      Buffer.from(checkpoints.at(-1) ?? "", "base64url").toString("utf8")
    )
    expect(finalCheckpoint).toMatchObject({
      sessionId: "ses_1",
      continuationToken: "eve:next",
      streamIndex: 2,
    })
  })

  it("keeps every streamed assistant chunk when EVE repeats data.sequence", async () => {
    const stream = [
      {
        type: "message.appended",
        data: {
          messageDelta: "H",
          messageSoFar: "H",
          sequence: 7,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      {
        type: "message.appended",
        data: {
          messageDelta: "el",
          messageSoFar: "Hel",
          sequence: 7,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      {
        type: "message.appended",
        data: {
          messageDelta: "lo",
          messageSoFar: "Hello",
          sequence: 7,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      {
        type: "message.completed",
        data: {
          message: "Hello",
          finishReason: "stop",
          sequence: 7,
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
      {
        type: "session.waiting",
        data: { continuationToken: "eve:next" },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")
      .concat("\n")
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          sessionId: "ses_1",
          continuationToken: "eve:first",
        })
      )
      .mockResolvedValueOnce(new Response(stream))
    const runtime = new EveAgentRuntime({
      baseUrl: "http://eve.test",
      channelSecret: "channel-secret-that-is-at-least-thirty-two-characters",
      fetcher,
    })

    const events = await collect(
      runtime.start(runtimeInput(() => Promise.resolve()))
    )
    const chunks = events.filter((event) => event.type === "assistant.delta")

    expect(chunks.map((event) => event.payload.delta)).toEqual([
      "H",
      "el",
      "lo",
    ])
    expect(new Set(chunks.map((event) => event.sourceEventId)).size).toBe(3)
  })

  it("stops consuming the EVE stream after a terminal session failure", async () => {
    const stream = [
      {
        type: "session.failed",
        data: {
          code: "Docker CLI not found",
          message:
            "The Docker sandbox backend requires Docker, but the `docker` CLI was not found.",
        },
      },
      {
        type: "message.appended",
        data: {
          messageDelta: "This must not be consumed",
          messageSoFar: "This must not be consumed",
          stepIndex: 0,
          turnId: "turn-1",
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")
      .concat("\n")
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          sessionId: "ses_1",
          continuationToken: "eve:first",
        })
      )
      .mockResolvedValueOnce(new Response(stream))
    const runtime = new EveAgentRuntime({
      baseUrl: "http://eve.test",
      channelSecret: "channel-secret-that-is-at-least-thirty-two-characters",
      fetcher,
    })

    const events = await collect(
      runtime.start(runtimeInput(() => Promise.resolve()))
    )

    expect(events.map((event) => event.type)).toEqual(["run.failed"])
  })

  it("sends attachments as AI SDK file message parts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          sessionId: "ses_1",
          continuationToken: "eve:first",
        })
      )
      .mockResolvedValueOnce(new Response(""))
    const runtime = new EveAgentRuntime({
      baseUrl: "http://eve.test",
      channelSecret: "channel-secret-that-is-at-least-thirty-two-characters",
      fetcher,
    })
    const input = runtimeInput(() => Promise.resolve())
    input.attachments = [
      {
        id: "00000000-0000-4000-8000-000000000040",
        name: "notes.txt",
        contentType: "text/plain",
        sizeBytes: 4,
        contentBase64: Buffer.from("safe").toString("base64"),
      },
    ]

    await collect(runtime.start(input))

    const request = fetcher.mock.calls[0]?.[1]
    expect(JSON.parse(String(request?.body))).toMatchObject({
      message: [
        { type: "text", text: "List the teams" },
        {
          type: "file",
          data: "data:text/plain;base64,c2FmZQ==",
          mediaType: "text/plain",
          filename: "notes.txt",
        },
      ],
    })
  })

  it("continues an existing session when EVE omits the continuation token from the delivery response", async () => {
    const stream = `${JSON.stringify({
      type: "session.waiting",
      data: { continuationToken: "eve:next", sequence: 9 },
    })}\n`
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          sessionId: "ses_1",
        })
      )
      .mockResolvedValueOnce(new Response(stream))
    const checkpoints: Array<string> = []
    const runtime = new EveAgentRuntime({
      baseUrl: "http://eve.test",
      channelSecret: "channel-secret-that-is-at-least-thirty-two-characters",
      fetcher,
    })
    const input = runtimeInput((checkpoint) => {
      checkpoints.push(checkpoint)
      return Promise.resolve()
    })
    input.runtimeSessionId = Buffer.from(
      JSON.stringify({
        sessionId: "ses_1",
        continuationToken: "eve:previous",
        streamIndex: 8,
      }),
      "utf8"
    ).toString("base64url")

    await collect(runtime.start(input))

    expect(fetcher.mock.calls[1]?.[0]).toEqual(
      new URL("http://eve.test/eve/v1/session/ses_1/stream?startIndex=8")
    )
    expect(checkpoints).not.toHaveLength(0)
  })

  it("resumes a parked session with a structured approval response", async () => {
    const stream = `${JSON.stringify({
      type: "session.waiting",
      data: { continuationToken: "eve:after-approval", sequence: 8 },
    })}\n`
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          sessionId: "ses_1",
          continuationToken: "eve:resuming",
        })
      )
      .mockResolvedValueOnce(new Response(stream))
    const runtime = new EveAgentRuntime({
      baseUrl: "http://eve.test",
      channelSecret: "channel-secret-that-is-at-least-thirty-two-characters",
      fetcher,
    })
    const base = runtimeInput(() => Promise.resolve())
    const cursor = Buffer.from(
      JSON.stringify({
        sessionId: "ses_1",
        continuationToken: "eve:before-approval",
        streamIndex: 7,
      }),
      "utf8"
    ).toString("base64url")
    const input: ResumeRuntimeRunInput = {
      threadId: base.threadId,
      runId: base.runId,
      identity: base.identity,
      model: base.model,
      reasoningEffort: base.reasoningEffort,
      runtimeSessionId: cursor,
      inputResponses: [{ requestId: "eve-request-1", optionId: "approve" }],
      checkpointRuntimeSession: () => Promise.resolve(),
    }

    await collect(runtime.resume(input))

    expect(fetcher.mock.calls[0]?.[0]).toEqual(
      new URL("http://eve.test/eve/v1/session/ses_1")
    )
    const request = fetcher.mock.calls[0]?.[1]
    expect(JSON.parse(String(request?.body))).toEqual({
      continuationToken: "eve:before-approval",
      inputResponses: [{ requestId: "eve-request-1", optionId: "approve" }],
    })
    expect(fetcher.mock.calls[1]?.[0]).toEqual(
      new URL("http://eve.test/eve/v1/session/ses_1/stream?startIndex=7")
    )
  })

  it("rejects approval resumption when the cursor has no continuation token", async () => {
    const fetcher = vi.fn<typeof fetch>()
    const runtime = new EveAgentRuntime({
      baseUrl: "http://eve.test",
      channelSecret: "channel-secret-that-is-at-least-thirty-two-characters",
      fetcher,
    })
    const base = runtimeInput(() => Promise.resolve())
    const cursor = Buffer.from(
      JSON.stringify({
        sessionId: "ses_1",
        streamIndex: 7,
      }),
      "utf8"
    ).toString("base64url")
    const input: ResumeRuntimeRunInput = {
      threadId: base.threadId,
      runId: base.runId,
      identity: base.identity,
      model: base.model,
      reasoningEffort: base.reasoningEffort,
      runtimeSessionId: cursor,
      inputResponses: [{ requestId: "eve-request-1", optionId: "approve" }],
      checkpointRuntimeSession: () => Promise.resolve(),
    }

    await expect(collect(runtime.resume(input))).rejects.toThrow(
      "EVE approval resume requires a durable continuation token."
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("reconnects from a durable stream cursor without replaying session input", async () => {
    const stream = `${JSON.stringify({
      type: "message.completed",
      data: {
        message: "Recovered",
        finishReason: "stop",
        sequence: 9,
        stepIndex: 0,
        turnId: "turn-1",
      },
    })}\n`
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(stream))
    const runtime = new EveAgentRuntime({
      baseUrl: "http://eve.test",
      channelSecret: "channel-secret-that-is-at-least-thirty-two-characters",
      fetcher,
    })
    const base = runtimeInput(() => Promise.resolve())
    const cursor = Buffer.from(
      JSON.stringify({
        sessionId: "ses_1",
        continuationToken: "eve:durable",
        streamIndex: 8,
      }),
      "utf8"
    ).toString("base64url")
    const input: ReconnectRuntimeRunInput = {
      threadId: base.threadId,
      runId: base.runId,
      identity: base.identity,
      model: base.model,
      reasoningEffort: base.reasoningEffort,
      runtimeSessionId: cursor,
      checkpointRuntimeSession: () => Promise.resolve(),
    }

    const events = await collect(runtime.reconnect(input))

    expect(events).toEqual([
      expect.objectContaining({
        type: "assistant.message",
        payload: expect.objectContaining({ content: "Recovered" }),
      }),
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toEqual(
      new URL("http://eve.test/eve/v1/session/ses_1/stream?startIndex=8")
    )
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("method", "POST")
  })

  it("reconnects to an active session before EVE issues a continuation token", async () => {
    const stream = `${JSON.stringify({
      type: "message.completed",
      data: {
        message: "Recovered",
        finishReason: "stop",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      },
    })}\n`
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream))
    const runtime = new EveAgentRuntime({
      baseUrl: "http://eve.test",
      channelSecret: "channel-secret-that-is-at-least-thirty-two-characters",
      fetcher,
    })
    const base = runtimeInput(() => Promise.resolve())
    const cursor = Buffer.from(
      JSON.stringify({
        sessionId: "ses_1",
        streamIndex: 0,
      }),
      "utf8"
    ).toString("base64url")
    const input: ReconnectRuntimeRunInput = {
      threadId: base.threadId,
      runId: base.runId,
      identity: base.identity,
      model: base.model,
      reasoningEffort: base.reasoningEffort,
      runtimeSessionId: cursor,
      checkpointRuntimeSession: () => Promise.resolve(),
    }

    const events = await collect(runtime.reconnect(input))

    expect(events).toEqual([
      expect.objectContaining({
        type: "assistant.message",
        payload: expect.objectContaining({ content: "Recovered" }),
      }),
    ])
    expect(fetcher.mock.calls[0]?.[0]).toEqual(
      new URL("http://eve.test/eve/v1/session/ses_1/stream?startIndex=0")
    )
  })

  it("cancels with fresh channel authorization after an adapter restart", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }))
    const runtime = new EveAgentRuntime({
      baseUrl: "http://eve.test",
      channelSecret: "channel-secret-that-is-at-least-thirty-two-characters",
      fetcher,
    })
    const base = runtimeInput(() => Promise.resolve())
    const cursor = Buffer.from(
      JSON.stringify({
        sessionId: "ses_1",
        continuationToken: "eve:durable",
        streamIndex: 8,
      }),
      "utf8"
    ).toString("base64url")

    await runtime.cancel(base.runId, cursor, {
      identity: base.identity,
      model: base.model,
      reasoningEffort: base.reasoningEffort,
    })

    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://eve.test/eve/v1/session/ses_1/cancel"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Bearer /),
        }),
      })
    )
  })
})

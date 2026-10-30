// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Actor } from "@/application/actor"
import type { ModelCatalogEntry } from "@/application/agents/model-contract"
import { EmailVerificationRequiredError } from "@/lib/email-verification"
import { AgentCoordinator } from "@/application/agents/agent-coordinator.server"
import { createAgentHttpHandler } from "@/application/agents/agent-http-handler.server"
import { FakeAgentRuntime } from "@/adapters/agents/fake-runtime"
import { InMemoryAgentEventStore } from "@/adapters/agents/in-memory-event-store"
import { InMemoryAgentStore } from "@/adapters/agents/in-memory-agent-store"
import { InMemoryAgentApprovalStore } from "@/adapters/agents/in-memory-approval-store"
import { ApprovalService } from "@/application/agents/approval-service.server"
import { InMemoryThreadModelPreferenceStore } from "@/adapters/agents/in-memory-thread-model-preference-store"

const actor: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  workspaceRole: "member",
  authentication: { kind: "session", sessionId: "session-1" },
  scopes: null,
}

const model: ModelCatalogEntry = {
  selectionId: "00000000-0000-4000-8000-000000000001:gpt-5.6-luna",
  connectionId: "00000000-0000-4000-8000-000000000001",
  executionKind: "forge-native",
  provider: "openai",
  modelId: "gpt-5.6-luna",
  displayName: "GPT 5.6 Luna",
  providerLabel: "OpenAI",
  sourceLabel: "Personal API key",
  locality: "server-capable",
  billingMode: "pay-as-you-go",
  inputModalities: ["text"],
  supportsTools: true,
  supportsCode: true,
  supportedReasoningEfforts: ["low", "medium"],
  contextWindowTokens: 200_000,
  status: "available",
}

const previousLocalIngestSecret = process.env.FORGE_AGENT_LOCAL_INGEST_SECRET
const previousArtifactSecret = process.env.FORGE_AGENT_ARTIFACT_SECRET

beforeEach(() => {
  process.env.FORGE_AGENT_LOCAL_INGEST_SECRET =
    "local-ingest-test-secret-with-at-least-32-characters"
})

afterEach(() => {
  if (previousLocalIngestSecret) {
    process.env.FORGE_AGENT_LOCAL_INGEST_SECRET = previousLocalIngestSecret
  } else {
    delete process.env.FORGE_AGENT_LOCAL_INGEST_SECRET
  }
  if (previousArtifactSecret) {
    process.env.FORGE_AGENT_ARTIFACT_SECRET = previousArtifactSecret
  } else {
    delete process.env.FORGE_AGENT_ARTIFACT_SECRET
  }
})

function fixture() {
  const ids = [
    "00000000-0000-4000-8000-000000000010",
    "00000000-0000-4000-8000-000000000020",
  ]
  const store = new InMemoryAgentStore()
  const eventStore = new InMemoryAgentEventStore()
  const preferences = new InMemoryThreadModelPreferenceStore()
  const approvals = new ApprovalService({
    approvals: new InMemoryAgentApprovalStore(),
    agents: store,
    events: eventStore,
  })
  const attachment = {
    id: "00000000-0000-4000-8000-000000000099",
    name: "notes.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    checksum: "a".repeat(64),
    expiresAt: new Date("2026-07-25T00:00:00.000Z"),
    createdAt: new Date("2026-07-24T00:00:00.000Z"),
  }
  const uploadAttachment = vi.fn(async () => attachment)
  const coordinator = new AgentCoordinator({
    store,
    eventStore,
    runtimes: [new FakeAgentRuntime()],
    listModels: () => Promise.resolve([model]),
    id: () => ids.shift()!,
    approvals,
    preferences,
  })
  const handler = createAgentHttpHandler({
    getActor: () => Promise.resolve(actor),
    coordinator,
    listModels: () => Promise.resolve([model]),
    approvals,
    localCapabilities: {
      invoke: async (_actor, invocation) => ({
        ok: true,
        value: {
          capabilityId: invocation.capabilityId,
          items: [],
          nextCursor: null,
        },
      }),
    },
    attachments: { upload: uploadAttachment },
  })
  return { coordinator, handler, uploadAttachment }
}

describe("agent HTTP transport", () => {
  it("stops exposing events when live stream authorization is revoked", async () => {
    const { coordinator, handler: setup } = fixture()
    const response = await setup(
      new Request("http://forge.test/api/agent/threads", {
        method: "POST",
        headers: { origin: "http://forge.test" },
        body: JSON.stringify({ runtimeKind: "eve" }),
      })
    )
    const thread = (await response.json()) as { id: string }
    const authorizeStream = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("revoked"))
    const handler = createAgentHttpHandler({
      getActor: async () => actor,
      coordinator,
      listModels: async () => [model],
      authorizeStream,
    })
    const stream = await handler(
      new Request("http://forge.test/api/agent/runs", {
        method: "POST",
        headers: { origin: "http://forge.test" },
        body: JSON.stringify({
          threadId: thread.id,
          message: "fixture",
          selectionMode: "auto",
          attachmentIds: [],
        }),
      })
    )
    const text = await stream.text()
    expect(authorizeStream).toHaveBeenCalledTimes(2)
    expect(text).toContain("transport.error")
    expect(text).not.toContain("assistant.message")
  })
  it("denies unverified sessions before creating an agent thread", async () => {
    const { coordinator } = fixture()
    const createThread = vi.spyOn(coordinator, "createThread")
    const handler = createAgentHttpHandler({
      coordinator,
      getActor: () => Promise.reject(new EmailVerificationRequiredError()),
      listModels: () => Promise.resolve([model]),
    })
    const response = await handler(
      new Request("http://forge.test/api/agent/threads", {
        method: "POST",
        headers: { origin: "http://forge.test" },
        body: JSON.stringify({ title: "Blocked", runtimeKind: "eve" }),
      })
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: "EMAIL_NOT_VERIFIED" },
    })
    expect(createThread).not.toHaveBeenCalled()
  })

  it("retires base64 attachment requests before reading their bodies", async () => {
    const { handler, uploadAttachment } = fixture()
    const response = await handler(
      new Request("http://forge.test/api/agent/attachments", {
        method: "POST",
        headers: {
          origin: "http://forge.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "notes.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from("safe").toString("base64"),
        }),
      })
    )

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "DIRECT_UPLOAD_REQUIRED" },
    })
    expect(uploadAttachment).not.toHaveBeenCalled()
  })

  it("creates and lists threads through authenticated JSON endpoints", async () => {
    const { handler } = fixture()
    const created = await handler(
      new Request("http://forge.test/api/agent/threads", {
        method: "POST",
        headers: { origin: "http://forge.test" },
        body: JSON.stringify({ title: "Question", runtimeKind: "eve" }),
      })
    )
    const listed = await handler(
      new Request("http://forge.test/api/agent/threads")
    )

    expect(created.status).toBe(201)
    await expect(created.json()).resolves.toMatchObject({ title: "Question" })
    await expect(listed.json()).resolves.toMatchObject([{ title: "Question" }])
  })

  it("persists a model preference per owned thread", async () => {
    const { handler } = fixture()
    const created = await handler(
      new Request("http://forge.test/api/agent/threads", {
        method: "POST",
        headers: { origin: "http://forge.test" },
        body: JSON.stringify({ title: "Preference", runtimeKind: "eve" }),
      })
    )
    const thread = (await created.json()) as { id: string }
    const updated = await handler(
      new Request(
        `http://forge.test/api/agent/threads/${thread.id}/preferences`,
        {
          method: "PUT",
          headers: {
            origin: "http://forge.test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "manual",
            selectedConnectionId: "00000000-0000-4000-8000-000000000001",
            selectedModelId: "gpt-5.6-luna",
            selectedEffort: "low",
          }),
        }
      )
    )
    const read = await handler(
      new Request(
        `http://forge.test/api/agent/threads/${thread.id}/preferences`
      )
    )

    expect(updated.status).toBe(200)
    await expect(read.json()).resolves.toMatchObject({
      mode: "manual",
      selectedModelId: "gpt-5.6-luna",
      selectedEffort: "low",
    })
  })

  it("streams canonical events as SSE and supports replay", async () => {
    const { handler } = fixture()
    const threadResponse = await handler(
      new Request("http://forge.test/api/agent/threads", {
        method: "POST",
        headers: { origin: "http://forge.test" },
        body: JSON.stringify({ runtimeKind: "eve" }),
      })
    )
    const thread = (await threadResponse.json()) as { id: string }
    const runResponse = await handler(
      new Request("http://forge.test/api/agent/runs", {
        method: "POST",
        headers: { origin: "http://forge.test" },
        body: JSON.stringify({
          threadId: thread.id,
          message: "Find the Forge team",
          selectionMode: "auto",
          attachmentIds: [],
        }),
      })
    )
    const stream = await runResponse.text()
    const events = stream
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map(
        (line) => JSON.parse(line.slice(6)) as { runId: string; type: string }
      )
    const runId = events[0]?.runId

    expect(runResponse.headers.get("content-type")).toContain(
      "text/event-stream"
    )
    expect(events.map((event) => event.type)).toContain("assistant.message")

    const replay = await handler(
      new Request(`http://forge.test/api/agent/runs/${runId}/events?after=3`)
    )
    const replayed = (await replay.json()) as Array<{ sequence: number }>
    expect(replayed.every((event) => event.sequence > 3)).toBe(true)
  })

  it("returns 401 before dispatch when session resolution fails", async () => {
    const { coordinator } = fixture()
    const handler = createAgentHttpHandler({
      getActor: () => Promise.reject(new Error("no session")),
      coordinator,
      listModels: () => Promise.resolve([model]),
    })

    const response = await handler(
      new Request("http://forge.test/api/agent/threads")
    )

    expect(response.status).toBe(401)
  })

  it("rejects an invalid artifact download token without reading the blob", async () => {
    const { coordinator } = fixture()
    const read = vi.fn()
    const handler = createAgentHttpHandler({
      getActor: () => Promise.resolve(actor),
      coordinator,
      listModels: () => Promise.resolve([model]),
      artifacts: {
        createDownload: vi.fn(),
        read,
      },
    })
    process.env.FORGE_AGENT_ARTIFACT_SECRET =
      "artifact-test-secret-with-at-least-32-characters"
    const artifactId = "70000000-0000-4000-8000-000000000001"

    const response = await handler(
      new Request(
        `http://forge.test/api/agent/artifacts/${artifactId}/content?token=${"x".repeat(24)}`
      )
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    })
    expect(read).not.toHaveBeenCalled()
  })

  it("rejects cross-origin state changes before session dispatch", async () => {
    const { handler } = fixture()
    const response = await handler(
      new Request("http://forge.test/api/agent/threads", {
        method: "POST",
        headers: { origin: "https://attacker.test" },
        body: JSON.stringify({ runtimeKind: "eve" }),
      })
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_ORIGIN" },
    })
  })

  it("creates a local run and requires its scoped token for ingestion", async () => {
    const { handler } = fixture()
    const threadResponse = await handler(
      new Request("http://forge.test/api/agent/threads", {
        method: "POST",
        headers: { origin: "http://forge.test" },
        body: JSON.stringify({ runtimeKind: "codex" }),
      })
    )
    const thread = (await threadResponse.json()) as { id: string }
    const preparedResponse = await handler(
      new Request("http://forge.test/api/agent/local-runs", {
        method: "POST",
        headers: { origin: "http://forge.test" },
        body: JSON.stringify({
          runtimeId: "codex",
          threadId: thread.id,
          message: "Summarize this workspace",
          model: {
            selectionId: "local:codex:gpt-codex",
            connectionId: "00000000-0000-4000-8000-000000000099",
            executionKind: "external-agent",
            provider: "openai",
            modelId: "gpt-codex",
          },
          reasoningEffort: "high",
          attachmentIds: [],
        }),
      })
    )
    expect(preparedResponse.status).toBe(201)
    const prepared = (await preparedResponse.json()) as {
      run: { id: string }
      ingestToken: string
      initialEvents: Array<{ type: string }>
    }
    expect(prepared.initialEvents.map((event) => event.type)).toEqual([
      "run.created",
      "run.routing-resolved",
      "run.started",
    ])

    const eventInput = {
      runId: prepared.run.id,
      events: [
        {
          sourceEventId: "codex-turn-1:message-1",
          source: "codex",
          type: "assistant.message",
          occurredAt: "2026-07-24T00:00:00.000Z",
          payload: { messageId: "message-1", content: "Done" },
        },
      ],
    }
    const missingToken = await handler(
      new Request("http://forge.test/api/agent/local-ingest", {
        method: "POST",
        headers: {
          origin: "http://forge.test",
          "content-type": "application/json",
        },
        body: JSON.stringify(eventInput),
      })
    )
    expect(missingToken.status).toBe(401)

    const ingested = await handler(
      new Request("http://forge.test/api/agent/local-ingest", {
        method: "POST",
        headers: {
          origin: "http://forge.test",
          authorization: `Bearer ${prepared.ingestToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(eventInput),
      })
    )
    expect(ingested.status).toBe(200)
    await expect(ingested.json()).resolves.toMatchObject([
      { type: "assistant.message" },
    ])

    const toolCall = await handler(
      new Request("http://forge.test/api/agent/local-tool-calls", {
        method: "POST",
        headers: {
          origin: "http://forge.test",
          authorization: `Bearer ${prepared.ingestToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runId: prepared.run.id,
          namespace: "forge",
          tool: "teams_list",
          arguments: { limit: 10 },
        }),
      })
    )
    expect(toolCall.status).toBe(200)
    await expect(toolCall.json()).resolves.toMatchObject({
      success: true,
      output: { capabilityId: "teams.list", items: [] },
    })
  })

  it("persists and resolves a local runtime approval through the session", async () => {
    const { handler } = fixture()
    const threadResponse = await handler(
      new Request("http://forge.test/api/agent/threads", {
        method: "POST",
        headers: { origin: "http://forge.test" },
        body: JSON.stringify({ runtimeKind: "codex" }),
      })
    )
    const thread = (await threadResponse.json()) as { id: string }
    const preparedResponse = await handler(
      new Request("http://forge.test/api/agent/local-runs", {
        method: "POST",
        headers: { origin: "http://forge.test" },
        body: JSON.stringify({
          runtimeId: "codex",
          threadId: thread.id,
          message: "Update a file",
          model: {
            selectionId: "local:codex:gpt-codex",
            connectionId: "00000000-0000-4000-8000-000000000099",
            executionKind: "external-agent",
            provider: "openai",
            modelId: "gpt-codex",
          },
          reasoningEffort: "high",
          attachmentIds: [],
        }),
      })
    )
    const prepared = (await preparedResponse.json()) as {
      run: { id: string }
      ingestToken: string
    }
    const approvalId = "90000000-0000-4000-8000-000000000001"
    const requested = await handler(
      new Request("http://forge.test/api/agent/local-ingest", {
        method: "POST",
        headers: {
          origin: "http://forge.test",
          authorization: `Bearer ${prepared.ingestToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runId: prepared.run.id,
          events: [
            {
              sourceEventId: "codex-approval-1",
              source: "codex",
              type: "approval.requested",
              occurredAt: "2026-07-24T00:00:00.000Z",
              payload: {
                approvalId,
                capabilityId: "codex.file-change",
                capabilityVersion: "1",
                risk: "important-write",
                summary: "Apply the proposed file changes",
                details: { files: ["README.md"] },
                expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
              },
            },
          ],
        }),
      })
    )
    expect(requested.status).toBe(200)
    await expect(requested.json()).resolves.toMatchObject([
      {
        type: "approval.requested",
        payload: { approvalId, inputHash: expect.any(String) },
      },
    ])

    const resolved = await handler(
      new Request(`http://forge.test/api/agent/approvals/${approvalId}`, {
        method: "POST",
        headers: {
          origin: "http://forge.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "approved" }),
      })
    )
    expect(resolved.status).toBe(200)
    const resolvedEvent = resolved.text().then((body) =>
      JSON.parse(
        body
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6)
      )
    )
    await expect(resolvedEvent).resolves.toMatchObject({
      type: "approval.resolved",
      payload: { approvalId, decision: "approved" },
    })
  })
})

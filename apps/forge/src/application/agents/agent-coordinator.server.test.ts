import { describe, expect, it } from "vitest"

import type { Actor } from "@/application/actor"
import type { ModelCatalogEntry } from "@/application/agents/model-contract"
import type { AgentRuntime } from "@/application/agents/runtime-contract"
import type { AgentControlPolicy } from "@/application/agents/agent-control-policy"
import { AgentCoordinator } from "@/application/agents/agent-coordinator.server"
import { FakeAgentRuntime } from "@/adapters/agents/fake-runtime"
import { InMemoryAgentEventStore } from "@/adapters/agents/in-memory-event-store"
import { InMemoryAgentStore } from "@/adapters/agents/in-memory-agent-store"
import { InMemoryAgentApprovalStore } from "@/adapters/agents/in-memory-approval-store"
import { ApprovalService } from "@/application/agents/approval-service.server"

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
  supportedReasoningEfforts: ["none", "low", "medium"],
  contextWindowTokens: 200_000,
  status: "available",
}

const localModel = {
  selectionId: "local:codex:gpt-codex",
  connectionId: "00000000-0000-4000-8000-000000000099",
  executionKind: "external-agent" as const,
  provider: "openai",
  modelId: "gpt-codex",
}

const controlPolicy: AgentControlPolicy = {
  runWallClockMs: 900_000,
  maxInputTokens: 200_000,
  maxOutputTokens: 50_000,
  userMonthlyBudgetMicros: null,
  workspaceMonthlyBudgetMicros: null,
  allowedProviders: null,
  allowedCapabilities: null,
}

function coordinator() {
  const store = new InMemoryAgentStore()
  const eventStore = new InMemoryAgentEventStore()
  const runtime = new FakeAgentRuntime()
  const ids = [
    "00000000-0000-4000-8000-000000000010",
    "00000000-0000-4000-8000-000000000020",
  ]
  const service = new AgentCoordinator({
    store,
    eventStore,
    runtimes: [runtime],
    listModels: () => Promise.resolve([model]),
    id: () => ids.shift()!,
    now: () => new Date("2026-07-23T20:00:00.000Z"),
  })

  return { eventStore, runtime, service, store }
}

async function collect<T>(events: AsyncIterable<T>) {
  const collected: Array<T> = []
  for await (const event of events) collected.push(event)
  return collected
}

describe("agent coordinator", () => {
  it("starts more than the former per-user, workspace and provider caps without rejecting runs", async () => {
    const store = new InMemoryAgentStore()
    const runtime = new FakeAgentRuntime()
    let sequence = 0
    const service = new AgentCoordinator({
      store,
      eventStore: new InMemoryAgentEventStore(),
      runtimes: [runtime],
      listModels: () => Promise.resolve([model]),
      controlPolicy,
      id: () =>
        `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    })
    const sessions = await Promise.all(
      Array.from({ length: 30 }, async () => {
        const thread = await service.createThread(actor, { runtimeKind: "eve" })
        return service.startTurn(actor, {
          threadId: thread.id,
          message: "Parallel run",
          selectionMode: "auto",
          attachmentIds: [],
        })
      })
    )
    expect(store.runs.size).toBe(30)
    await Promise.all(sessions.map((session) => collect(session.events)))
    expect(runtime.starts).toHaveLength(30)
    expect(
      [...store.runs.values()].every((run) => run.state === "completed")
    ).toBe(true)
  })

  it("creates, routes, streams, and completes through the fake runtime", async () => {
    const { runtime, service, store } = coordinator()
    const thread = await service.createThread(actor, {
      title: "Forge question",
      runtimeKind: "eve",
    })
    const session = await service.startTurn(actor, {
      threadId: thread.id,
      message: "Find the Forge team",
      selectionMode: "auto",
      attachmentIds: [],
    })
    const events = await collect(session.events)

    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "run.routing-resolved",
      "run.started",
      "assistant.delta",
      "assistant.message",
      "run.completed",
    ])
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(runtime.starts[0]).toMatchObject({
      identity: { workspaceId: "workspace-1", userId: "user-1" },
      model: { modelId: "gpt-5.6-luna" },
    })
    expect(
      events.find((event) => event.type === "run.routing-resolved")?.payload
    ).toMatchObject({
      route: {
        runtimeKind: "eve",
        connectionLabel: "Personal API key",
        billingMode: "pay-as-you-go",
        modelId: "gpt-5.6-luna",
        reasoningEffort: "low",
      },
    })
    expect(store.runs.get(session.run.id)?.state).toBe("completed")
    expect(store.runs.get(session.run.id)?.requestedSelection.billingMode).toBe(
      "pay-as-you-go"
    )
  })

  it("reconnects once from a durable runtime checkpoint", async () => {
    const reconnects: Array<string | null> = []
    const runtime: AgentRuntime = {
      kind: "eve",
      start(input) {
        return (async function* () {
          await input.checkpointRuntimeSession("durable-cursor")
          yield {
            sourceEventId: `${input.runId}:before-interruption`,
            source: "eve" as const,
            type: "assistant.delta" as const,
            payload: { messageId: "message-1", delta: "Part " },
          }
          throw new Error("stream interrupted")
        })()
      },
      reconnect(input) {
        reconnects.push(input.runtimeSessionId)
        return (async function* () {
          yield {
            sourceEventId: `${input.runId}:after-interruption`,
            source: "eve" as const,
            type: "assistant.message" as const,
            payload: { messageId: "message-1", content: "Part recovered" },
          }
        })()
      },
      cancel() {
        return Promise.resolve()
      },
    }
    const store = new InMemoryAgentStore()
    const eventStore = new InMemoryAgentEventStore()
    const ids = [
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000020",
    ]
    const service = new AgentCoordinator({
      store,
      eventStore,
      runtimes: [runtime],
      listModels: () => Promise.resolve([model]),
      id: () => ids.shift()!,
    })
    const thread = await service.createThread(actor, { runtimeKind: "eve" })
    const started = await service.startTurn(actor, {
      threadId: thread.id,
      message: "Recover this run",
      selectionMode: "auto",
      attachmentIds: [],
    })

    const events = await collect(started.events)

    expect(reconnects).toEqual(["durable-cursor"])
    expect(events.map((event) => event.type)).toContain("progress.note")
    expect(
      events.find((event) => event.type === "progress.note")?.payload
    ).toMatchObject({ state: "reconnecting" })
    expect(events.at(-1)?.type).toBe("run.completed")
    expect(store.runs.get(started.run.id)?.state).toBe("completed")
  })

  it("refreshes a stale model catalog once before reporting unavailable", async () => {
    const store = new InMemoryAgentStore()
    const eventStore = new InMemoryAgentEventStore()
    const runtime = new FakeAgentRuntime()
    const ids = [
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000020",
    ]
    let refreshed = false
    let refreshCount = 0
    const service = new AgentCoordinator({
      store,
      eventStore,
      runtimes: [runtime],
      listModels: () => Promise.resolve(refreshed ? [model] : []),
      refreshModels: async (_actor, connectionId) => {
        expect(connectionId).toBe(model.connectionId)
        refreshCount += 1
        refreshed = true
      },
      id: () => ids.shift()!,
    })
    const thread = await service.createThread(actor, { runtimeKind: "eve" })

    const started = await service.startTurn(actor, {
      threadId: thread.id,
      message: "Use my selected model",
      selectionMode: "manual",
      model: {
        selectionId: model.selectionId,
        connectionId: model.connectionId,
        executionKind: model.executionKind,
        provider: model.provider,
        modelId: model.modelId,
      },
      reasoningEffort: "low",
      attachmentIds: [],
    })
    await collect(started.events)

    expect(refreshCount).toBe(1)
    expect(runtime.starts[0]?.model.modelId).toBe(model.modelId)
  })

  it("stops a run that exceeds its persisted token budget", async () => {
    const runtime = new FakeAgentRuntime((input) => [
      {
        sourceEventId: `${input.runId}:usage`,
        source: "eve",
        type: "run.usage",
        payload: {
          inputTokens: 10,
          outputTokens: 101,
          cachedInputTokens: 0,
          costMicros: 12,
        },
      },
    ])
    const store = new InMemoryAgentStore()
    const eventStore = new InMemoryAgentEventStore()
    const ids = [
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000020",
    ]
    const service = new AgentCoordinator({
      store,
      eventStore,
      runtimes: [runtime],
      listModels: () => Promise.resolve([model]),
      id: () => ids.shift()!,
      controlPolicy: { ...controlPolicy, maxOutputTokens: 100 },
    })
    const thread = await service.createThread(actor, { runtimeKind: "eve" })
    const started = await service.startTurn(actor, {
      threadId: thread.id,
      message: "Generate a very long answer",
      selectionMode: "auto",
      attachmentIds: [],
    })

    const events = await collect(started.events)

    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { errorCode: "OUTPUT_TOKEN_LIMIT" },
    })
    expect(runtime.cancelledRuns.has(started.run.id)).toBe(true)
    expect(store.runs.get(started.run.id)).toMatchObject({
      state: "failed",
      errorCode: "OUTPUT_TOKEN_LIMIT",
    })
  })

  it("cancels a runtime that exceeds its wall-clock limit", async () => {
    let release: (() => void) | undefined
    const runtime: AgentRuntime & { cancelled: boolean } = {
      kind: "eve",
      cancelled: false,
      start() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                await new Promise<void>((resolveWait) => {
                  release = resolveWait
                })
                return { done: true as const, value: undefined }
              },
            }
          },
        }
      },
      async cancel() {
        runtime.cancelled = true
        release?.()
      },
    }
    const store = new InMemoryAgentStore()
    const eventStore = new InMemoryAgentEventStore()
    const ids = [
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000020",
    ]
    const service = new AgentCoordinator({
      store,
      eventStore,
      runtimes: [runtime],
      listModels: () => Promise.resolve([model]),
      id: () => ids.shift()!,
      controlPolicy: { ...controlPolicy, runWallClockMs: 5 },
    })
    const thread = await service.createThread(actor, { runtimeKind: "eve" })
    const started = await service.startTurn(actor, {
      threadId: thread.id,
      message: "Wait forever",
      selectionMode: "auto",
      attachmentIds: [],
    })

    const events = await collect(started.events)

    expect(runtime.cancelled).toBe(true)
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { errorCode: "RUN_WALL_CLOCK_LIMIT" },
    })
  })

  it("deduplicates replayed runtime events by source event id", async () => {
    const replayingRuntime = new FakeAgentRuntime((input) => {
      const event = {
        sourceEventId: `${input.runId}:message`,
        source: "eve" as const,
        type: "assistant.message" as const,
        payload: { content: "Stable" },
      }
      return [event, event]
    })
    const store = new InMemoryAgentStore()
    const eventStore = new InMemoryAgentEventStore()
    const ids = [
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000020",
    ]
    const service = new AgentCoordinator({
      store,
      eventStore,
      runtimes: [replayingRuntime],
      listModels: () => Promise.resolve([model]),
      id: () => ids.shift()!,
    })
    const thread = await service.createThread(actor, { runtimeKind: "eve" })
    const session = await service.startTurn(actor, {
      threadId: thread.id,
      message: "Find the Forge team",
      selectionMode: "auto",
      attachmentIds: [],
    })

    await collect(session.events)

    const persisted = await eventStore.listRunEvents(session.run.id)
    expect(
      persisted.filter((event) => event.type === "assistant.message")
    ).toHaveLength(1)
  })

  it("aggregates persisted model usage for budgets and reporting", async () => {
    const usageRuntime = new FakeAgentRuntime((input) => [
      {
        sourceEventId: `${input.runId}:usage:1`,
        source: "eve" as const,
        type: "run.usage" as const,
        payload: {
          inputTokens: 100,
          outputTokens: 25,
          cachedInputTokens: 40,
          costMicros: 750,
        },
      },
      {
        sourceEventId: `${input.runId}:usage:2`,
        source: "eve" as const,
        type: "run.usage" as const,
        payload: {
          inputTokens: 50,
          outputTokens: 10,
          cachedInputTokens: 0,
          costMicros: 250,
        },
      },
    ])
    const store = new InMemoryAgentStore()
    const service = new AgentCoordinator({
      store,
      eventStore: new InMemoryAgentEventStore(),
      runtimes: [usageRuntime],
      listModels: () => Promise.resolve([model]),
      id: (() => {
        const ids = [
          "00000000-0000-4000-8000-000000000010",
          "00000000-0000-4000-8000-000000000020",
        ]
        return () => ids.shift()!
      })(),
    })
    const thread = await service.createThread(actor, { runtimeKind: "eve" })
    const session = await service.startTurn(actor, {
      threadId: thread.id,
      message: "Find the Forge team",
      selectionMode: "auto",
      attachmentIds: [],
    })

    await collect(session.events)

    expect(store.runs.get(session.run.id)).toMatchObject({
      inputTokens: 150,
      outputTokens: 35,
      cachedInputTokens: 40,
      costMicros: 1000,
    })
  })

  it("persists native runtime approval requests and leaves the run waiting", async () => {
    const approvalRuntime = new FakeAgentRuntime(() => [
      {
        sourceEventId: "eve-approval-1",
        source: "eve" as const,
        type: "approval.requested" as const,
        payload: {
          capabilityId: "teams.update",
          capabilityVersion: "1",
          risk: "reversible-write",
          summary: "Update the Forge team description",
          input: { slug: "forge", settings: { description: "Updated" } },
          details: {},
        },
      },
    ])
    const store = new InMemoryAgentStore()
    const eventStore = new InMemoryAgentEventStore()
    const approvalService = new ApprovalService({
      approvals: new InMemoryAgentApprovalStore(),
      agents: store,
      events: eventStore,
      now: () => new Date("2026-07-23T20:00:00.000Z"),
    })
    const ids = [
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000020",
    ]
    const service = new AgentCoordinator({
      store,
      eventStore,
      runtimes: [approvalRuntime],
      listModels: () => Promise.resolve([model]),
      id: () => ids.shift()!,
      now: () => new Date("2026-07-23T20:00:00.000Z"),
      approvals: approvalService,
    })
    const thread = await service.createThread(actor, { runtimeKind: "eve" })
    const session = await service.startTurn(actor, {
      threadId: thread.id,
      message: "Update the team",
      selectionMode: "auto",
      attachmentIds: [],
    })
    const events = await collect(session.events)

    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "run.routing-resolved",
      "run.started",
      "approval.requested",
    ])
    expect(store.runs.get(session.run.id)?.state).toBe("waiting-for-approval")
  })

  it("resumes the same native run with the exact EVE approval response", async () => {
    const approvalRuntime = new FakeAgentRuntime(
      () => [
        {
          sourceEventId: "eve-approval-1",
          source: "eve" as const,
          type: "approval.requested" as const,
          payload: {
            capabilityId: "teams.update",
            capabilityVersion: "1",
            risk: "reversible-write",
            summary: "Update the Forge team description",
            input: { slug: "forge", settings: { description: "Updated" } },
            details: { runtimeRequestId: "eve-request-1" },
          },
        },
      ],
      (input) => [
        {
          sourceEventId: `${input.runId}:resumed-message`,
          source: "eve" as const,
          type: "assistant.message" as const,
          payload: {
            messageId: "assistant-resumed",
            content: "The team was updated.",
          },
        },
      ]
    )
    const store = new InMemoryAgentStore()
    const eventStore = new InMemoryAgentEventStore()
    const approvalService = new ApprovalService({
      approvals: new InMemoryAgentApprovalStore(),
      agents: store,
      events: eventStore,
      now: () => new Date("2026-07-23T20:00:00.000Z"),
    })
    const ids = [
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000020",
    ]
    const service = new AgentCoordinator({
      store,
      eventStore,
      runtimes: [approvalRuntime],
      listModels: () => Promise.resolve([model]),
      id: () => ids.shift()!,
      now: () => new Date("2026-07-23T20:00:00.000Z"),
      approvals: approvalService,
    })
    const thread = await service.createThread(actor, { runtimeKind: "eve" })
    const started = await service.startTurn(actor, {
      threadId: thread.id,
      message: "Update the team",
      selectionMode: "auto",
      attachmentIds: [],
    })
    const initialEvents = await collect(started.events)
    const approvalId = initialEvents.find(
      (event) => event.type === "approval.requested"
    )?.payload.approvalId
    expect(typeof approvalId).toBe("string")
    await store.updateThread(actor.workspaceId, thread.id, {
      runtimeSessionId:
        "eyJzZXNzaW9uSWQiOiJzZXNzaW9uLTEiLCJjb250aW51YXRpb25Ub2tlbiI6ImNvbnRpbnVlLTEiLCJzdHJlYW1JbmRleCI6N30",
    })

    const resumed = await service.resolveApproval(
      actor,
      approvalId as string,
      "approved"
    )
    const resumedEvents = await collect(resumed.events)

    expect(resumedEvents.map((event) => event.type)).toEqual([
      "approval.resolved",
      "assistant.message",
      "run.completed",
    ])
    expect(approvalRuntime.resumes[0]).toMatchObject({
      runId: started.run.id,
      inputResponses: [{ requestId: "eve-request-1", optionId: "approve" }],
    })
    expect(store.runs.get(started.run.id)?.state).toBe("completed")
  })

  it("isolates threads by workspace and user and supports archive and reopen", async () => {
    const { service } = coordinator()
    const thread = await service.createThread(actor, { runtimeKind: "eve" })

    await expect(
      service.setThreadArchived(
        { ...actor, workspaceId: "workspace-2" },
        thread.id,
        true
      )
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" })
    await expect(
      service.listThreadEvents({ ...actor, userId: "user-2" }, thread.id)
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" })
    await expect(
      service.startTurn(
        { ...actor, userId: "user-2" },
        {
          threadId: thread.id,
          message: "Read another user's thread",
          selectionMode: "auto",
          attachmentIds: [],
        }
      )
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" })

    await expect(
      service.setThreadArchived(actor, thread.id, true)
    ).resolves.toMatchObject({ status: "archived" })
    await expect(
      service.setThreadArchived(actor, thread.id, false)
    ).resolves.toMatchObject({ status: "active" })
  })

  it("cancels through the selected runtime and persists the event", async () => {
    const { runtime, service, store } = coordinator()
    const thread = await service.createThread(actor, { runtimeKind: "eve" })
    const session = await service.startTurn(actor, {
      threadId: thread.id,
      message: "Find the Forge team",
      selectionMode: "auto",
      attachmentIds: [],
    })

    await service.cancelRun(actor, session.run.id)

    expect(runtime.cancelledRuns.has(session.run.id)).toBe(true)
    expect(store.runs.get(session.run.id)?.state).toBe("cancelled")
  })

  it("prepares, checkpoints, and idempotently ingests a local run", async () => {
    const { eventStore, service, store } = coordinator()
    const thread = await service.createThread(actor, { runtimeKind: "eve" })
    const prepared = await service.prepareLocalTurn(actor, {
      runtimeId: "codex",
      threadId: thread.id,
      message: "Summarize this workspace",
      model: localModel,
      reasoningEffort: "high",
      attachmentIds: [],
    })

    expect(
      store.runs.get(prepared.run.id)?.requestedSelection.billingMode
    ).toBe("subscription")
    expect(prepared.initialEvents.map((event) => event.type)).toEqual([
      "run.created",
      "run.routing-resolved",
      "run.started",
    ])
    expect(store.threads.get(thread.id)).toMatchObject({
      runtimeKind: "codex",
      runtimeSessionId: null,
    })

    await service.checkpointLocalRuntime(actor, prepared.run.id, {
      runtimeSessionId: "codex-thread-1",
      runtimeRunId: "codex-turn-1",
    })
    expect(store.threads.get(thread.id)?.runtimeSessionId).toBe(
      "codex-thread-1"
    )
    expect(store.runs.get(prepared.run.id)?.runtimeRunId).toBe("codex-turn-1")

    const runtimeEvents = [
      {
        sourceEventId: "codex-turn-1:message-1:delta-1",
        source: "codex" as const,
        type: "assistant.delta" as const,
        occurredAt: "2026-07-23T20:00:01.000Z",
        payload: { messageId: "message-1", delta: "Hello" },
      },
      {
        sourceEventId: "codex-turn-1:completed",
        source: "codex" as const,
        type: "run.completed" as const,
        occurredAt: "2026-07-23T20:00:02.000Z",
        payload: {},
      },
    ]
    await service.ingestLocalEvents(actor, prepared.run.id, runtimeEvents)
    await service.ingestLocalEvents(actor, prepared.run.id, runtimeEvents)

    expect(store.runs.get(prepared.run.id)?.state).toBe("completed")
    const persisted = await eventStore.listRunEvents(prepared.run.id)
    expect(
      persisted.filter((event) => event.type === "assistant.delta")
    ).toHaveLength(1)
    expect(
      persisted.filter((event) => event.type === "run.completed")
    ).toHaveLength(1)
  })
})

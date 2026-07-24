"use client"

import { z } from "zod"

import type { AgentClient } from "@/lib/agent-client/agent-client"
import type { AgentEvent } from "@/application/agents/event-contract"
import type { StartAgentTurnInput } from "@/application/agents/agent-contract"
import type { ForgeHost, HostEvent } from "@/host/forge-host"
import { agentEventSchema } from "@/application/agents/event-contract"
import {
  AgentHttpError,
  callGlobalFetch,
  HttpAgentClient,
  expectAgentJson,
} from "@/lib/agent-client/http-agent-client"

export const CODEX_LOCAL_CONNECTION_ID = "00000000-0000-4000-8000-000000000099"

const localRunResponseSchema = z
  .object({
    run: z.object({ id: z.string().uuid() }).passthrough(),
    initialEvents: z.array(agentEventSchema),
    runtimeSessionId: z.string().nullable(),
    attachments: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string().min(1).max(200),
          contentType: z.string().min(1).max(255),
          sizeBytes: z.number().int().positive(),
          contentBase64: z.string().min(1),
        })
        .passthrough()
    ),
    ingestToken: z.string().min(1),
  })
  .strict()

const localToolCallResponseSchema = z
  .object({
    success: z.boolean(),
    output: z.unknown(),
  })
  .strict()

class AsyncEventQueue<T> implements AsyncIterable<T> {
  #values: Array<T> = []
  #waiters: Array<{
    resolve: (value: IteratorResult<T>) => void
    reject: (error: Error) => void
  }> = []
  #closed = false
  #error: Error | null = null

  push(value: T) {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.#values.push(value)
  }

  close() {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: Error) {
    this.#error = error
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.#values.shift()
        if (value !== undefined) {
          return Promise.resolve({ value, done: false })
        }
        if (this.#error) return Promise.reject(this.#error)
        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve, reject) => {
          this.#waiters.push({ resolve, reject })
        })
      },
    }
  }
}

function isTerminal(event: HostEvent) {
  return (
    event.type === "local-agent-event" &&
    event.message.type === "runtime-event" &&
    ["run.completed", "run.cancelled", "run.failed"].includes(
      event.message.event.type
    )
  )
}

export class DesktopAgentClient implements AgentClient {
  readonly #activeLocalRuns = new Set<string>()

  constructor(
    private readonly host: ForgeHost,
    private readonly http = new HttpAgentClient(),
    private readonly baseUrl = "/api/agent",
    private readonly fetcher: typeof fetch = callGlobalFetch
  ) {}

  createThread: AgentClient["createThread"] = (input) =>
    this.http.createThread(input)

  uploadAttachment: AgentClient["uploadAttachment"] = (input) =>
    this.http.uploadAttachment(input)

  listThreads: AgentClient["listThreads"] = () => this.http.listThreads()

  mutateThread: AgentClient["mutateThread"] = (threadId, input) =>
    this.http.mutateThread(threadId, input)

  replayThread: AgentClient["replayThread"] = (threadId) =>
    this.http.replayThread(threadId)

  replayRun: AgentClient["replayRun"] = (runId, afterSequence) =>
    this.http.replayRun(runId, afterSequence)

  listModels: AgentClient["listModels"] = () => this.http.listModels()

  getThreadModelPreference: AgentClient["getThreadModelPreference"] = (
    threadId
  ) => this.http.getThreadModelPreference(threadId)

  setThreadModelPreference: AgentClient["setThreadModelPreference"] = (
    threadId,
    input
  ) => this.http.setThreadModelPreference(threadId, input)

  getFeatureFlags: AgentClient["getFeatureFlags"] = () =>
    this.http.getFeatureFlags()

  async *resolveApproval(approvalId: string, decision: "approved" | "denied") {
    let resolvedRunId: string | null = null
    for await (const event of this.http.resolveApproval(approvalId, decision)) {
      resolvedRunId ??= event.runId
      yield event
    }
    if (resolvedRunId && this.#activeLocalRuns.has(resolvedRunId)) {
      await this.host.resolveLocalRuntimeApproval({
        runId: resolvedRunId,
        approvalId,
        decision,
      })
    }
  }

  async *streamTurn(input: StartAgentTurnInput): AsyncIterable<AgentEvent> {
    if (
      input.selectionMode !== "manual" ||
      input.model?.executionKind !== "external-agent" ||
      !input.model.selectionId.startsWith("local:codex:")
    ) {
      yield* this.http.streamTurn(input)
      return
    }

    const preparedResponse = await this.fetcher(`${this.baseUrl}/local-runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeId: "codex",
        threadId: input.threadId,
        message: input.message,
        model: input.model,
        reasoningEffort: input.reasoningEffort ?? "medium",
        attachmentIds: input.attachmentIds,
      }),
    })
    const prepared = localRunResponseSchema.parse(
      await expectAgentJson<unknown>(preparedResponse)
    )
    for (const event of prepared.initialEvents) yield event

    const runId = prepared.run.id
    const queue = new AsyncEventQueue<HostEvent>()
    const unsubscribe = this.host.subscribe((event) => {
      if (event.type !== "local-agent-event" || event.message.runId !== runId) {
        return
      }
      queue.push(event)
      if (isTerminal(event)) queue.close()
    })
    this.#activeLocalRuns.add(runId)

    try {
      const checkpoint = await this.host.startLocalRuntimeRun({
        runtimeId: "codex",
        runId,
        runtimeSessionId: prepared.runtimeSessionId,
        modelId: input.model.modelId,
        reasoningEffort: input.reasoningEffort ?? "medium",
        message: input.message,
        attachments: prepared.attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
          contentBase64: attachment.contentBase64,
        })),
      })
      await expectAgentJson(
        await this.fetcher(
          `${this.baseUrl}/local-runs/${encodeURIComponent(runId)}`,
          {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${prepared.ingestToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(checkpoint),
          }
        )
      )

      for await (const hostEvent of queue) {
        if (hostEvent.type !== "local-agent-event") continue
        if (hostEvent.message.type === "tool-call-request") {
          const toolResult = localToolCallResponseSchema.parse(
            await expectAgentJson<unknown>(
              await this.fetcher(`${this.baseUrl}/local-tool-calls`, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${prepared.ingestToken}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  runId,
                  namespace: hostEvent.message.namespace,
                  tool: hostEvent.message.tool,
                  arguments: hostEvent.message.arguments,
                }),
              })
            )
          )
          await this.host.resolveLocalRuntimeToolCall({
            runId,
            requestId: hostEvent.message.requestId,
            ...toolResult,
          })
          continue
        }
        const persisted = await expectAgentJson<Array<unknown>>(
          await this.fetcher(`${this.baseUrl}/local-ingest`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${prepared.ingestToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              runId,
              events: [hostEvent.message.event],
            }),
          })
        )
        for (const event of persisted) yield agentEventSchema.parse(event)
      }
    } catch (error) {
      await this.host.cancelLocalRuntimeRun(runId).catch(() => {})
      queue.fail(
        error instanceof Error
          ? error
          : new AgentHttpError(
              500,
              "LOCAL_RUNTIME_FAILED",
              "The local agent runtime failed."
            )
      )
      throw error
    } finally {
      unsubscribe()
      this.#activeLocalRuns.delete(runId)
    }
  }

  async cancelRun(runId: string) {
    if (this.#activeLocalRuns.has(runId)) {
      await this.host.cancelLocalRuntimeRun(runId)
    }
    return this.http.cancelRun(runId)
  }
}

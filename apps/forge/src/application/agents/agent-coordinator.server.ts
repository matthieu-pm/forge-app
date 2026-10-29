import "@tanstack/react-start/server-only"

import { randomUUID } from "node:crypto"

import type { Actor } from "@/application/actor"
import type {
  AgentRunRecord,
  AgentStore,
  AgentThreadRecord,
} from "@/application/agents/agent-store"
import type {
  CreateAgentThreadInput,
  StartAgentTurnInput,
} from "@/application/agents/agent-contract"
import type { AgentEvent } from "@/application/agents/event-contract"
import type { AgentEventStore } from "@/application/agents/event-store"
import type {
  ModelCatalogEntry,
  ResolvedModel,
} from "@/application/agents/model-contract"
import type {
  LocalRuntimeEventInput,
  StartLocalAgentTurnInput,
} from "@/application/agents/local-runtime-contract"
import type {
  AgentRuntime,
  ResumeRuntimeRunInput,
  StartRuntimeRunInput,
} from "@/application/agents/runtime-contract"
import type { ApprovalService } from "@/application/agents/approval-service.server"
import type {
  ApprovalDecision,
  ApprovalResolution,
} from "@/application/agents/approval-contract"
import type {
  ThreadModelPreferenceInput,
  ThreadModelPreferenceStore,
} from "@/application/agents/thread-model-preference"
import type { AgentControlPolicy } from "@/application/agents/agent-control-policy"
import type { AgentAttachmentService } from "@/application/agents/attachment-service.server"
import type { ResolvedAgentAttachment } from "@/application/agents/attachment-contract"
import type { RoutingInput } from "@/application/agents/model-router"
import {
  requireAgentRead,
  requireAgentRun,
} from "@/application/agents/agent-authorization"
import {
  ModelRoutingError,
  resolveModel,
} from "@/application/agents/model-router"
import {
  localRuntimeApprovalPayloadSchema,
  runtimeApprovalPayloadSchema,
} from "@/application/agents/local-runtime-contract"
import { assertAgentRunAllowed } from "@/application/agents/agent-control-policy"
import {
  correlateIterable,
  emitTelemetry,
} from "@/application/observability/telemetry.server"

export class AgentCoordinatorError extends Error {
  constructor(
    readonly code:
      | "THREAD_NOT_FOUND"
      | "THREAD_ARCHIVED"
      | "RUN_NOT_FOUND"
      | "RUNTIME_UNAVAILABLE",
    message: string
  ) {
    super(message)
    this.name = "AgentCoordinatorError"
  }
}

export type AgentRunSession = {
  run: AgentRunRecord
  events: AsyncIterable<AgentEvent>
}

type RunUsage = Pick<
  AgentRunRecord,
  "inputTokens" | "outputTokens" | "cachedInputTokens" | "costMicros"
>

class AgentRunLimitError extends Error {
  constructor(
    readonly code:
      "RUN_WALL_CLOCK_LIMIT" | "INPUT_TOKEN_LIMIT" | "OUTPUT_TOKEN_LIMIT",
    message: string
  ) {
    super(message)
    this.name = "AgentRunLimitError"
  }
}

function runFailure(error: unknown) {
  return error instanceof AgentRunLimitError
    ? { errorCode: error.code, message: error.message }
    : {
        errorCode: "RUNTIME_EXECUTION_FAILED",
        message: "Forge could not complete this run.",
      }
}

function enforceUsageLimits(
  usage: RunUsage,
  policy: AgentControlPolicy | undefined
) {
  if (!policy) return
  if (usage.inputTokens > policy.maxInputTokens) {
    throw new AgentRunLimitError(
      "INPUT_TOKEN_LIMIT",
      "The run reached its input-token limit."
    )
  }
  if (usage.outputTokens > policy.maxOutputTokens) {
    throw new AgentRunLimitError(
      "OUTPUT_TOKEN_LIMIT",
      "The run reached its output-token limit."
    )
  }
}

async function* withWallClockLimit<T>(
  iterable: AsyncIterable<T>,
  limitMs: number,
  onTimeout: () => Promise<void>
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  const deadline = Date.now() + limitMs
  let timedOut = false
  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timedOut = true
        await onTimeout()
        throw new AgentRunLimitError(
          "RUN_WALL_CLOCK_LIMIT",
          "The run reached its wall-clock time limit."
        )
      }
      const timeoutMarker = Symbol("timeout")
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        iterator.next(),
        new Promise<typeof timeoutMarker>((resolve) => {
          timer = setTimeout(() => resolve(timeoutMarker), remaining)
        }),
      ])
      if (timer) clearTimeout(timer)
      if (next === timeoutMarker) {
        timedOut = true
        await onTimeout()
        throw new AgentRunLimitError(
          "RUN_WALL_CLOCK_LIMIT",
          "The run reached its wall-clock time limit."
        )
      }
      if (next.done) return
      yield next.value
    }
  } finally {
    if (timedOut) await iterator.return?.()
  }
}

async function* withSingleReconnect<T>(
  initial: AsyncIterable<T>,
  reconnect: (error: unknown) => Promise<AsyncIterable<T>>
): AsyncIterable<T> {
  try {
    yield* initial
  } catch (error) {
    yield* await reconnect(error)
  }
}

async function* prependValue<T>(
  value: T,
  iterable: AsyncIterable<T>
): AsyncIterable<T> {
  yield value
  yield* iterable
}

function usageIncrement(event: {
  type: string
  payload: Record<string, unknown>
}) {
  if (event.type !== "run.usage") return null
  const read = (key: keyof RunUsage) => {
    const value = event.payload[key]
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : 0
  }
  return {
    inputTokens: read("inputTokens"),
    outputTokens: read("outputTokens"),
    cachedInputTokens: read("cachedInputTokens"),
    costMicros: read("costMicros"),
  }
}

function addUsage(current: RunUsage, increment: RunUsage): RunUsage {
  return {
    inputTokens: current.inputTokens + increment.inputTokens,
    outputTokens: current.outputTokens + increment.outputTokens,
    cachedInputTokens: current.cachedInputTokens + increment.cachedInputTokens,
    costMicros: current.costMicros + increment.costMicros,
  }
}

type CoordinatorDependencies = {
  store: AgentStore
  eventStore: AgentEventStore
  runtimes: ReadonlyArray<AgentRuntime>
  listModels: (actor: Actor) => Promise<ReadonlyArray<ModelCatalogEntry>>
  refreshModels?: (actor: Actor, connectionId?: string) => Promise<void>
  routeModel?: (input: RoutingInput) => ReturnType<typeof resolveModel>
  id?: () => string
  now?: () => Date
  resolveRuntimeKind?: (
    model: ModelCatalogEntry | StartLocalAgentTurnInput["model"]
  ) => AgentThreadRecord["runtimeKind"]
  approvals?: Pick<ApprovalService, "request" | "resolve">
  preferences?: ThreadModelPreferenceStore
  controlPolicy?: AgentControlPolicy
  attachments?: Pick<AgentAttachmentService, "resolve">
  authorizeRun?: (actor: Actor) => Promise<void>
}

export class AgentCoordinator {
  private readonly runtimes: Map<AgentRuntime["kind"], AgentRuntime>
  private readonly id: () => string
  private readonly now: () => Date
  private readonly routeModel: typeof resolveModel
  private readonly resolveRuntimeKind: NonNullable<
    CoordinatorDependencies["resolveRuntimeKind"]
  >

  constructor(private readonly dependencies: CoordinatorDependencies) {
    this.runtimes = new Map(
      dependencies.runtimes.map((runtime) => [runtime.kind, runtime])
    )
    this.id = dependencies.id ?? randomUUID
    this.now = dependencies.now ?? (() => new Date())
    this.routeModel = dependencies.routeModel ?? resolveModel
    this.resolveRuntimeKind =
      dependencies.resolveRuntimeKind ??
      ((model) => {
        if (model.executionKind === "forge-native") return "eve"
        if (model.selectionId.startsWith("local:codex:")) return "codex"
        if (model.selectionId.startsWith("local:claude:")) return "claude"
        throw new AgentCoordinatorError(
          "RUNTIME_UNAVAILABLE",
          "The selected external agent runtime is unavailable."
        )
      })
  }

  async createThread(
    actor: Actor,
    input: CreateAgentThreadInput
  ): Promise<AgentThreadRecord> {
    requireAgentRun(actor)
    await this.dependencies.authorizeRun?.(actor)
    const createdAt = this.now()

    return this.dependencies.store.createThread({
      id: this.id(),
      workspaceId: actor.workspaceId,
      createdByUserId: actor.userId,
      title: input.title ?? "New chat",
      status: "active",
      runtimeKind: input.runtimeKind,
      runtimeSessionId: null,
      createdAt,
    })
  }

  async listThreads(actor: Actor) {
    requireAgentRead(actor)
    return this.dependencies.store.listThreads(actor.workspaceId, actor.userId)
  }

  async getThreadModelPreference(actor: Actor, threadId: string) {
    requireAgentRead(actor)
    const thread = await this.requireOwnedThread(actor, threadId)
    return (
      (await this.dependencies.preferences?.get(thread.id)) ?? {
        threadId: thread.id,
        mode: "auto" as const,
        selectedConnectionId: null,
        selectedModelId: null,
        selectedEffort: null,
        updatedAt: thread.updatedAt,
      }
    )
  }

  async setThreadModelPreference(
    actor: Actor,
    threadId: string,
    input: ThreadModelPreferenceInput
  ) {
    requireAgentRun(actor)
    const thread = await this.requireOwnedThread(actor, threadId)
    if (!this.dependencies.preferences) {
      return {
        threadId: thread.id,
        ...input,
        updatedAt: this.now(),
      }
    }
    return this.dependencies.preferences.upsert({
      threadId: thread.id,
      ...input,
      updatedAt: this.now(),
    })
  }

  private async requireOwnedThread(actor: Actor, threadId: string) {
    const thread = await this.dependencies.store.getThread(
      actor.workspaceId,
      threadId
    )
    if (!thread || thread.createdByUserId !== actor.userId) {
      throw new AgentCoordinatorError(
        "THREAD_NOT_FOUND",
        "The agent thread was not found."
      )
    }
    return thread
  }

  private runtimeCancellationContext(actor: Actor, run: AgentRunRecord) {
    if (!run.resolvedConnectionId || !run.resolvedModelId) return undefined
    return {
      identity: {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        workspaceRole: actor.workspaceRole,
      },
      model: {
        selectionId:
          typeof run.requestedSelection.selectionId === "string"
            ? run.requestedSelection.selectionId
            : run.resolvedModelId,
        connectionId: run.resolvedConnectionId,
        executionKind: run.executionKind,
        provider:
          typeof run.requestedSelection.provider === "string"
            ? run.requestedSelection.provider
            : "openai",
        modelId: run.resolvedModelId,
      },
      reasoningEffort: run.reasoningEffort ?? ("medium" as const),
    }
  }

  async setThreadArchived(actor: Actor, threadId: string, archived: boolean) {
    requireAgentRun(actor)
    await this.requireOwnedThread(actor, threadId)
    const thread = await this.dependencies.store.updateThread(
      actor.workspaceId,
      threadId,
      {
        status: archived ? "archived" : "active",
        lastActivityAt: this.now(),
      }
    )
    if (!thread) {
      throw new AgentCoordinatorError(
        "THREAD_NOT_FOUND",
        "The agent thread was not found."
      )
    }
    return thread
  }

  async renameThread(actor: Actor, threadId: string, title: string) {
    requireAgentRun(actor)
    await this.requireOwnedThread(actor, threadId)
    const thread = await this.dependencies.store.updateThread(
      actor.workspaceId,
      threadId,
      { title, lastActivityAt: this.now() }
    )
    if (!thread) {
      throw new AgentCoordinatorError(
        "THREAD_NOT_FOUND",
        "The agent thread was not found."
      )
    }
    return thread
  }

  async listRunEvents(actor: Actor, runId: string, afterSequence = 0) {
    requireAgentRead(actor)
    const run = await this.dependencies.store.getRun(actor.workspaceId, runId)
    if (!run || run.initiatedByUserId !== actor.userId) {
      throw new AgentCoordinatorError(
        "RUN_NOT_FOUND",
        "The agent run was not found."
      )
    }
    return this.dependencies.eventStore.listRunEvents(runId, afterSequence)
  }

  async listThreadEvents(actor: Actor, threadId: string) {
    requireAgentRead(actor)
    await this.requireOwnedThread(actor, threadId)
    return this.dependencies.eventStore.listThreadEvents(threadId)
  }

  async startTurn(
    actor: Actor,
    input: StartAgentTurnInput
  ): Promise<AgentRunSession> {
    requireAgentRun(actor)
    await this.dependencies.authorizeRun?.(actor)
    const thread = await this.requireOwnedThread(actor, input.threadId)
    if (thread.status === "archived") {
      throw new AgentCoordinatorError(
        "THREAD_ARCHIVED",
        "Reopen the thread before sending another message."
      )
    }
    if (this.dependencies.controlPolicy) {
      await assertAgentRunAllowed(
        this.dependencies.store,
        actor,
        this.dependencies.controlPolicy,
        this.now()
      )
    }
    const attachments = await this.resolveAttachments(
      actor,
      input.attachmentIds
    )

    let availableModels = await this.dependencies.listModels(actor)
    let resolved: ResolvedModel
    try {
      resolved = await this.routeModel({
        mode: input.selectionMode,
        message: input.message,
        availableModels,
        manualModel: input.model,
        reasoningEffort: input.reasoningEffort,
        preferredOpenAIConnectionId: input.preferredOpenAIConnectionId,
      })
    } catch (error) {
      if (
        !(error instanceof ModelRoutingError) ||
        !["MODEL_UNAVAILABLE", "AUTO_UNAVAILABLE"].includes(error.code) ||
        !this.dependencies.refreshModels
      ) {
        throw error
      }
      await this.dependencies.refreshModels(
        actor,
        input.selectionMode === "manual" ? input.model?.connectionId : undefined
      )
      availableModels = await this.dependencies.listModels(actor)
      resolved = await this.routeModel({
        mode: input.selectionMode,
        message: input.message,
        availableModels,
        manualModel: input.model,
        reasoningEffort: input.reasoningEffort,
        preferredOpenAIConnectionId: input.preferredOpenAIConnectionId,
      })
    }
    await this.setThreadModelPreference(actor, thread.id, {
      mode: input.selectionMode,
      selectedConnectionId:
        input.selectionMode === "manual"
          ? (input.model?.connectionId ?? null)
          : (input.preferredOpenAIConnectionId ?? null),
      selectedModelId:
        input.selectionMode === "manual"
          ? (input.model?.modelId ?? null)
          : null,
      selectedEffort: input.reasoningEffort ?? null,
    })
    const runtimeKind = this.resolveRuntimeKind(resolved.model)
    let runtimeThread = thread
    if (thread.runtimeKind !== runtimeKind) {
      const updated = await this.dependencies.store.updateThread(
        actor.workspaceId,
        thread.id,
        {
          runtimeKind,
          runtimeSessionId: null,
          lastActivityAt: this.now(),
        }
      )
      if (!updated) {
        throw new AgentCoordinatorError(
          "THREAD_NOT_FOUND",
          "The agent thread was not found."
        )
      }
      runtimeThread = updated
    }
    const runtime = this.runtimes.get(runtimeKind)
    if (!runtime) {
      throw new AgentCoordinatorError(
        "RUNTIME_UNAVAILABLE",
        `The ${thread.runtimeKind} runtime is unavailable.`
      )
    }

    const now = this.now()
    const runId = this.id()
    const run = await this.dependencies.store.createRun({
      id: runId,
      threadId: thread.id,
      initiatedByUserId: actor.userId,
      state: "created",
      executionKind: resolved.model.executionKind,
      requestedSelection: {
        mode: input.selectionMode,
        selectionId: resolved.requestedSelection,
        provider: resolved.model.provider,
        billingMode: resolved.route.billingMode,
      },
      resolvedConnectionId: resolved.model.connectionId,
      resolvedModelId: resolved.model.modelId,
      reasoningEffort: resolved.reasoningEffort,
      routingPolicyVersion: resolved.routingPolicyVersion,
      routingReason: resolved.routingReason,
      runtimeRunId: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costMicros: 0,
      startedAt: null,
      completedAt: null,
      errorCode: null,
    })
    const created = await this.dependencies.eventStore.append({
      threadId: thread.id,
      runId,
      sourceEventId: `${runId}:created`,
      occurredAt: now.toISOString(),
      source: "forge",
      type: "run.created",
      schemaVersion: 1,
      payload: {
        message: input.message,
        attachmentIds: input.attachmentIds,
        attachments: attachments.map(
          ({ contentBase64: _contentBase64, ...attachment }) => attachment
        ),
      },
    })
    const routed = await this.dependencies.eventStore.append({
      threadId: thread.id,
      runId,
      sourceEventId: `${runId}:routing-resolved`,
      occurredAt: now.toISOString(),
      source: "forge",
      type: "run.routing-resolved",
      schemaVersion: 1,
      payload: resolved,
    })

    const events = this.streamRun({
      actor,
      thread: runtimeThread,
      run,
      input,
      runtime,
      initialEvents: [created, routed],
      attachments,
    })

    emitTelemetry("run.linked", "agent.run", { runId: run.id })
    return { run, events: correlateIterable(events, { runId: run.id }) }
  }

  async prepareLocalTurn(actor: Actor, input: StartLocalAgentTurnInput) {
    requireAgentRun(actor)
    await this.dependencies.authorizeRun?.(actor)
    const existingThread = await this.requireOwnedThread(actor, input.threadId)
    if (existingThread.status === "archived") {
      throw new AgentCoordinatorError(
        "THREAD_ARCHIVED",
        "Reopen the thread before sending another message."
      )
    }
    if (this.dependencies.controlPolicy) {
      await assertAgentRunAllowed(
        this.dependencies.store,
        actor,
        this.dependencies.controlPolicy,
        this.now()
      )
    }
    const attachments = await this.resolveAttachments(
      actor,
      input.attachmentIds
    )

    const runtimeKind = this.resolveRuntimeKind(input.model)
    if (runtimeKind !== input.runtimeId) {
      throw new AgentCoordinatorError(
        "RUNTIME_UNAVAILABLE",
        "The selected model does not belong to this local runtime."
      )
    }
    await this.setThreadModelPreference(actor, existingThread.id, {
      mode: "manual",
      selectedConnectionId: input.model.connectionId,
      selectedModelId: input.model.modelId,
      selectedEffort: input.reasoningEffort,
    })
    let thread = existingThread
    if (thread.runtimeKind !== runtimeKind) {
      const updated = await this.dependencies.store.updateThread(
        actor.workspaceId,
        thread.id,
        {
          runtimeKind,
          runtimeSessionId: null,
          lastActivityAt: this.now(),
        }
      )
      if (!updated) {
        throw new AgentCoordinatorError(
          "THREAD_NOT_FOUND",
          "The agent thread was not found."
        )
      }
      thread = updated
    }

    const now = this.now()
    const runId = this.id()
    const run = await this.dependencies.store.createRun({
      id: runId,
      threadId: thread.id,
      initiatedByUserId: actor.userId,
      state: "running",
      executionKind: "external-agent",
      requestedSelection: {
        mode: "manual",
        selectionId: input.model.selectionId,
        provider: input.model.provider,
        runtimeId: input.runtimeId,
        billingMode: "subscription",
      },
      resolvedConnectionId: input.model.connectionId,
      resolvedModelId: input.model.modelId,
      reasoningEffort: input.reasoningEffort,
      routingPolicyVersion: null,
      routingReason: "The user selected a local subscription model.",
      runtimeRunId: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costMicros: 0,
      startedAt: now,
      completedAt: null,
      errorCode: null,
    })
    const created = await this.dependencies.eventStore.append({
      threadId: thread.id,
      runId,
      sourceEventId: `${runId}:created`,
      occurredAt: now.toISOString(),
      source: "forge",
      type: "run.created",
      schemaVersion: 1,
      payload: {
        message: input.message,
        attachmentIds: input.attachmentIds,
        attachments: attachments.map(
          ({ contentBase64: _contentBase64, ...attachment }) => attachment
        ),
      },
    })
    const routed = await this.dependencies.eventStore.append({
      threadId: thread.id,
      runId,
      sourceEventId: `${runId}:routing-resolved`,
      occurredAt: now.toISOString(),
      source: "forge",
      type: "run.routing-resolved",
      schemaVersion: 1,
      payload: {
        requestedSelection: input.model.selectionId,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        routingPolicyVersion: null,
        routingReason: "The user selected a local subscription model.",
        route: {
          runtimeKind: input.runtimeId,
          executionKind: input.model.executionKind,
          connectionId: input.model.connectionId,
          connectionLabel: `${input.runtimeId === "codex" ? "Codex" : "Claude"} subscription`,
          locality: "local-only",
          billingMode: "subscription",
          provider: input.model.provider,
          providerLabel:
            input.model.provider === "openai" ? "OpenAI" : input.model.provider,
          modelId: input.model.modelId,
          modelDisplayName: input.model.modelId,
          reasoningEffort: input.reasoningEffort,
        },
      },
    })
    const started = await this.dependencies.eventStore.append({
      threadId: thread.id,
      runId,
      sourceEventId: `${runId}:started`,
      occurredAt: now.toISOString(),
      source: "forge",
      type: "run.started",
      schemaVersion: 1,
      payload: {},
    })
    return {
      run,
      thread,
      initialEvents: [created, routed, started],
      runtimeSessionId: thread.runtimeSessionId,
      attachments,
    }
  }

  async checkpointLocalRuntime(
    actor: Actor,
    runId: string,
    input: { runtimeSessionId: string; runtimeRunId: string }
  ) {
    requireAgentRun(actor)
    const run = await this.dependencies.store.getRun(actor.workspaceId, runId)
    if (
      !run ||
      run.initiatedByUserId !== actor.userId ||
      run.executionKind !== "external-agent"
    ) {
      throw new AgentCoordinatorError(
        "RUN_NOT_FOUND",
        "The local agent run was not found."
      )
    }
    const thread = await this.requireOwnedThread(actor, run.threadId)
    await Promise.all([
      this.dependencies.store.updateRun(runId, {
        runtimeRunId: input.runtimeRunId,
      }),
      this.dependencies.store.updateThread(actor.workspaceId, thread.id, {
        runtimeSessionId: input.runtimeSessionId,
        lastActivityAt: this.now(),
      }),
    ])
  }

  async ingestLocalEvents(
    actor: Actor,
    runId: string,
    events: ReadonlyArray<LocalRuntimeEventInput>
  ) {
    requireAgentRun(actor)
    const run = await this.dependencies.store.getRun(actor.workspaceId, runId)
    if (
      !run ||
      run.initiatedByUserId !== actor.userId ||
      run.executionKind !== "external-agent"
    ) {
      throw new AgentCoordinatorError(
        "RUN_NOT_FOUND",
        "The local agent run was not found."
      )
    }
    const thread = await this.requireOwnedThread(actor, run.threadId)

    const persisted: Array<AgentEvent> = []
    let state: AgentRunRecord["state"] | null = null
    let completedAt: Date | null = null
    let errorCode: string | null | undefined
    let usage: RunUsage = run
    let usageChanged = false
    for (const event of events) {
      if (event.type === "approval.requested" && this.dependencies.approvals) {
        const request = localRuntimeApprovalPayloadSchema.parse(event.payload)
        const resolution = await this.requestRuntimeApproval(
          actor,
          runId,
          request
        )
        persisted.push(resolution.event)
        state = "waiting-for-approval"
        continue
      }
      if (event.type === "approval.resolved" && this.dependencies.approvals) {
        state = "running"
        continue
      }
      persisted.push(
        await this.dependencies.eventStore.append({
          threadId: thread.id,
          runId,
          sourceEventId: event.sourceEventId,
          occurredAt: event.occurredAt,
          source: event.source,
          type: event.type,
          schemaVersion: 1,
          payload: event.payload,
        })
      )
      const increment = usageIncrement(event)
      if (increment) {
        usage = addUsage(usage, increment)
        usageChanged = true
      }
      if (event.type === "approval.requested") {
        state = "waiting-for-approval"
      } else if (event.type === "approval.resolved") {
        state = "running"
      } else if (event.type === "run.completed") {
        state = "completed"
        completedAt = new Date(event.occurredAt)
        errorCode = null
      } else if (event.type === "run.cancelled") {
        state = "cancelled"
        completedAt = new Date(event.occurredAt)
        errorCode = null
      } else if (event.type === "run.failed") {
        state = "failed"
        completedAt = new Date(event.occurredAt)
        errorCode =
          typeof event.payload.code === "string"
            ? event.payload.code.slice(0, 255)
            : "LOCAL_RUNTIME_FAILED"
      }
    }
    if (state || usageChanged) {
      await this.dependencies.store.updateRun(runId, {
        ...(state ? { state } : {}),
        ...(usageChanged ? usage : {}),
        ...(completedAt ? { completedAt } : {}),
        ...(errorCode !== undefined ? { errorCode } : {}),
      })
    }
    await this.dependencies.store.updateThread(actor.workspaceId, thread.id, {
      lastActivityAt: this.now(),
    })
    return persisted
  }

  async resolveApproval(
    actor: Actor,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<AgentRunSession> {
    requireAgentRun(actor)
    if (!this.dependencies.approvals) {
      throw new AgentCoordinatorError(
        "RUNTIME_UNAVAILABLE",
        "The approval service is unavailable."
      )
    }

    const resolution = await this.dependencies.approvals.resolve(
      actor,
      approvalId,
      decision
    )
    const run = await this.dependencies.store.getRun(
      actor.workspaceId,
      resolution.approval.runId
    )
    if (!run || run.initiatedByUserId !== actor.userId) {
      throw new AgentCoordinatorError(
        "RUN_NOT_FOUND",
        "The approval run was not found."
      )
    }

    return {
      run,
      events: correlateIterable(
        this.streamApprovalResolution(actor, run, resolution, decision),
        { runId: run.id }
      ),
    }
  }

  async cancelRun(actor: Actor, runId: string) {
    requireAgentRun(actor)
    const run = await this.dependencies.store.getRun(actor.workspaceId, runId)
    if (!run || run.initiatedByUserId !== actor.userId) {
      throw new AgentCoordinatorError(
        "RUN_NOT_FOUND",
        "The agent run was not found."
      )
    }
    const thread = await this.requireOwnedThread(actor, run.threadId)

    await this.runtimes
      .get(thread.runtimeKind)
      ?.cancel(
        runId,
        thread.runtimeSessionId,
        this.runtimeCancellationContext(actor, run)
      )
    const completedAt = this.now()
    await this.dependencies.store.updateRun(runId, {
      state: "cancelled",
      completedAt,
    })
    return this.dependencies.eventStore.append({
      threadId: thread.id,
      runId,
      sourceEventId: `${runId}:cancelled`,
      occurredAt: completedAt.toISOString(),
      source: "forge",
      type: "run.cancelled",
      schemaVersion: 1,
      payload: {},
    })
  }

  private async *streamApprovalResolution(
    actor: Actor,
    run: AgentRunRecord,
    resolution: ApprovalResolution,
    decision: ApprovalDecision
  ): AsyncIterable<AgentEvent> {
    yield resolution.event

    const thread = await this.requireOwnedThread(actor, run.threadId)

    // Provider-owned local runtimes are resumed over Electron IPC. The desktop
    // client consumes the canonical resolution event above, then answers the
    // matching provider request without sending provider credentials to Forge.
    if (thread.runtimeKind !== "eve") return

    const runtime = this.runtimes.get(thread.runtimeKind)
    if (!runtime?.resume || !thread.runtimeSessionId) {
      throw new AgentCoordinatorError(
        "RUNTIME_UNAVAILABLE",
        "The parked EVE session cannot be resumed."
      )
    }
    const details = resolution.approval.redactedInputSummary.details
    const runtimeRequestId =
      details &&
      typeof details === "object" &&
      typeof Reflect.get(details, "runtimeRequestId") === "string"
        ? (Reflect.get(details, "runtimeRequestId") as string)
        : null
    if (!runtimeRequestId) {
      throw new AgentCoordinatorError(
        "RUNTIME_UNAVAILABLE",
        "The approval is missing its EVE input request binding."
      )
    }
    if (!run.resolvedConnectionId || !run.resolvedModelId) {
      throw new AgentCoordinatorError(
        "RUNTIME_UNAVAILABLE",
        "The approval run no longer has a resolved model."
      )
    }

    let terminalState: "cancelled" | "failed" | null = null
    let waiting = false
    let usage: RunUsage = run
    let runtimeSessionId = thread.runtimeSessionId
    const checkpointRuntimeSession = async (nextRuntimeSessionId: string) => {
      runtimeSessionId = nextRuntimeSessionId
      await this.dependencies.store.updateThread(actor.workspaceId, thread.id, {
        runtimeSessionId: nextRuntimeSessionId,
        lastActivityAt: this.now(),
      })
    }
    try {
      const resumeInput: ResumeRuntimeRunInput = {
        threadId: thread.id,
        runId: run.id,
        identity: {
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          workspaceRole: actor.workspaceRole,
        },
        model: {
          selectionId:
            typeof run.requestedSelection.selectionId === "string"
              ? run.requestedSelection.selectionId
              : run.resolvedModelId,
          connectionId: run.resolvedConnectionId,
          executionKind: run.executionKind,
          provider:
            typeof run.requestedSelection.provider === "string"
              ? run.requestedSelection.provider
              : "openai",
          modelId: run.resolvedModelId,
        },
        reasoningEffort: run.reasoningEffort ?? ("medium" as const),
        runtimeSessionId,
        inputResponses: [
          {
            requestId: runtimeRequestId,
            optionId: decision === "approved" ? "approve" : "deny",
          },
        ],
        checkpointRuntimeSession,
      }
      const runtimeEvents = withWallClockLimit(
        withSingleReconnect(runtime.resume(resumeInput), async (error) => {
          if (!runtime.reconnect || !runtimeSessionId) throw error
          await this.dependencies.store.updateRun(run.id, {
            state: "reconnecting",
          })
          const reconnectInput = {
            threadId: resumeInput.threadId,
            runId: resumeInput.runId,
            identity: resumeInput.identity,
            model: resumeInput.model,
            reasoningEffort: resumeInput.reasoningEffort,
            runtimeSessionId,
            checkpointRuntimeSession,
          }
          return prependValue(
            {
              sourceEventId: `${run.id}:runtime-reconnecting`,
              source: "forge" as const,
              type: "progress.note" as const,
              payload: {
                message:
                  "The agent runtime connection was interrupted. Forge resumed from its durable checkpoint.",
                state: "reconnecting",
              },
            },
            runtime.reconnect(reconnectInput)
          )
        }),
        this.dependencies.controlPolicy?.runWallClockMs ?? 15 * 60_000,
        () =>
          runtime.cancel(
            run.id,
            runtimeSessionId,
            this.runtimeCancellationContext(actor, run)
          )
      )

      for await (const runtimeEvent of runtimeEvents) {
        const increment = usageIncrement(runtimeEvent)
        if (increment) {
          emitTelemetry("run.usage", "agent.run", {
            runId: run.id,
            ...increment,
          })
          usage = addUsage(usage, increment)
          enforceUsageLimits(usage, this.dependencies.controlPolicy)
          await this.dependencies.store.updateRun(run.id, usage)
        }
        if (runtimeEvent.type === "run.failed") {
          terminalState = "failed"
          emitTelemetry("run.failed", "agent.run", {
            runId: run.id,
            errorCode: "RUNTIME_EXECUTION_FAILED",
          })
        }
        if (runtimeEvent.type === "run.cancelled") terminalState = "cancelled"
        if (
          runtimeEvent.type === "approval.requested" &&
          this.dependencies.approvals
        ) {
          const request = runtimeApprovalPayloadSchema.parse(
            runtimeEvent.payload
          )
          const approval = await this.requestRuntimeApproval(
            actor,
            run.id,
            request
          )
          waiting = true
          yield approval.event
          continue
        }
        if (runtimeEvent.type === "run.waiting") {
          waiting = true
          await this.dependencies.store.updateRun(run.id, {
            state: "waiting-for-approval",
          })
        }
        yield await this.dependencies.eventStore.append({
          threadId: thread.id,
          runId: run.id,
          sourceEventId: runtimeEvent.sourceEventId,
          occurredAt: runtimeEvent.occurredAt ?? this.now().toISOString(),
          source: runtimeEvent.source,
          type: runtimeEvent.type,
          schemaVersion: 1,
          payload: runtimeEvent.payload,
        })
      }

      const completedAt = this.now()
      if (terminalState) {
        await this.dependencies.store.updateRun(run.id, {
          state: terminalState,
          completedAt,
          errorCode:
            terminalState === "failed" ? "RUNTIME_EXECUTION_FAILED" : null,
        })
        return
      }
      if (waiting) return
      await this.dependencies.store.updateRun(run.id, {
        state: "completed",
        completedAt,
        errorCode: null,
      })
      await this.dependencies.store.updateThread(actor.workspaceId, thread.id, {
        lastActivityAt: completedAt,
      })
      yield await this.dependencies.eventStore.append({
        threadId: thread.id,
        runId: run.id,
        sourceEventId: `${run.id}:completed`,
        occurredAt: completedAt.toISOString(),
        source: "forge",
        type: "run.completed",
        schemaVersion: 1,
        payload: {},
      })
    } catch (error) {
      const completedAt = this.now()
      const failure = runFailure(error)
      emitTelemetry("run.failed", "agent.run", {
        runId: run.id,
        errorCode: failure.errorCode,
      })
      if (error instanceof AgentRunLimitError) {
        await runtime
          .cancel(
            run.id,
            runtimeSessionId,
            this.runtimeCancellationContext(actor, run)
          )
          .catch(() => {})
      }
      await this.dependencies.store.updateRun(run.id, {
        state: "failed",
        completedAt,
        errorCode: failure.errorCode,
      })
      yield await this.dependencies.eventStore.append({
        threadId: thread.id,
        runId: run.id,
        sourceEventId: `${run.id}:resume-failed`,
        occurredAt: completedAt.toISOString(),
        source: "forge",
        type: "run.failed",
        schemaVersion: 1,
        payload: failure,
      })
    } finally {
      emitTelemetry("run.finished", "agent.run", {
        runId: run.id,
        durationMs: Math.max(
          0,
          this.now().getTime() - (run.startedAt ?? run.createdAt).getTime()
        ),
      })
    }
  }

  private async *streamRun({
    actor,
    thread,
    run,
    input,
    runtime,
    initialEvents,
    attachments,
  }: {
    actor: Actor
    thread: AgentThreadRecord
    run: AgentRunRecord
    input: StartAgentTurnInput
    runtime: AgentRuntime
    initialEvents: ReadonlyArray<AgentEvent>
    attachments: ReadonlyArray<ResolvedAgentAttachment>
  }): AsyncIterable<AgentEvent> {
    for (const event of initialEvents) yield event

    const startedAt = this.now()
    emitTelemetry("operation.started", "agent.run", {
      runId: run.id,
      queueAgeMs: Math.max(0, startedAt.getTime() - run.createdAt.getTime()),
    })
    await this.dependencies.store.updateRun(run.id, {
      state: "running",
      startedAt,
    })
    yield await this.dependencies.eventStore.append({
      threadId: thread.id,
      runId: run.id,
      sourceEventId: `${run.id}:started`,
      occurredAt: startedAt.toISOString(),
      source: "forge",
      type: "run.started",
      schemaVersion: 1,
      payload: {},
    })

    let runtimeSessionId = thread.runtimeSessionId
    const checkpointRuntimeSession = async (nextRuntimeSessionId: string) => {
      runtimeSessionId = nextRuntimeSessionId
      await this.dependencies.store.updateThread(actor.workspaceId, thread.id, {
        runtimeSessionId: nextRuntimeSessionId,
        lastActivityAt: this.now(),
      })
    }
    try {
      let terminalState: "cancelled" | "failed" | null = null
      let waiting = false
      let usage: RunUsage = run
      const startInput: StartRuntimeRunInput = {
        threadId: thread.id,
        runId: run.id,
        identity: {
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          workspaceRole: actor.workspaceRole,
        },
        message: input.message,
        model: {
          selectionId:
            typeof run.requestedSelection.selectionId === "string"
              ? run.requestedSelection.selectionId
              : "auto",
          connectionId: run.resolvedConnectionId!,
          executionKind: run.executionKind,
          provider:
            typeof run.requestedSelection.provider === "string"
              ? run.requestedSelection.provider
              : "openai",
          modelId: run.resolvedModelId!,
        },
        reasoningEffort: run.reasoningEffort ?? "medium",
        attachments,
        runtimeSessionId,
        checkpointRuntimeSession,
      }
      const runtimeEvents = withSingleReconnect(
        runtime.start(startInput),
        async (error) => {
          if (!runtime.reconnect || !runtimeSessionId) throw error
          await this.dependencies.store.updateRun(run.id, {
            state: "reconnecting",
          })
          return prependValue(
            {
              sourceEventId: `${run.id}:runtime-reconnecting`,
              source: "forge" as const,
              type: "progress.note" as const,
              payload: {
                message:
                  "The agent runtime connection was interrupted. Forge resumed from its durable checkpoint.",
                state: "reconnecting",
              },
            },
            runtime.reconnect({
              threadId: thread.id,
              runId: run.id,
              identity: startInput.identity,
              model: startInput.model,
              reasoningEffort: startInput.reasoningEffort,
              runtimeSessionId,
              checkpointRuntimeSession,
            })
          )
        }
      )
      for await (const runtimeEvent of withWallClockLimit(
        runtimeEvents,
        this.dependencies.controlPolicy?.runWallClockMs ?? 15 * 60_000,
        () =>
          runtime.cancel(
            run.id,
            runtimeSessionId,
            this.runtimeCancellationContext(actor, run)
          )
      )) {
        const increment = usageIncrement(runtimeEvent)
        if (increment) {
          emitTelemetry("run.usage", "agent.run", {
            runId: run.id,
            ...increment,
          })
          usage = addUsage(usage, increment)
          enforceUsageLimits(usage, this.dependencies.controlPolicy)
          await this.dependencies.store.updateRun(run.id, usage)
        }
        if (runtimeEvent.type === "run.failed") {
          terminalState = "failed"
          emitTelemetry("run.failed", "agent.run", {
            runId: run.id,
            errorCode: "RUNTIME_EXECUTION_FAILED",
          })
        }
        if (runtimeEvent.type === "run.cancelled") terminalState = "cancelled"
        if (
          runtimeEvent.type === "approval.requested" &&
          this.dependencies.approvals
        ) {
          const request = runtimeApprovalPayloadSchema.parse(
            runtimeEvent.payload
          )
          const approval = await this.requestRuntimeApproval(
            actor,
            run.id,
            request
          )
          waiting = true
          yield approval.event
          continue
        }
        if (runtimeEvent.type === "run.waiting") {
          waiting = true
          await this.dependencies.store.updateRun(run.id, {
            state: "waiting-for-approval",
          })
        }
        yield await this.dependencies.eventStore.append({
          threadId: thread.id,
          runId: run.id,
          sourceEventId: runtimeEvent.sourceEventId,
          occurredAt: runtimeEvent.occurredAt ?? this.now().toISOString(),
          source: runtimeEvent.source,
          type: runtimeEvent.type,
          schemaVersion: 1,
          payload: runtimeEvent.payload,
        })
      }

      const completedAt = this.now()
      if (terminalState) {
        await this.dependencies.store.updateRun(run.id, {
          state: terminalState,
          completedAt,
          errorCode:
            terminalState === "failed" ? "RUNTIME_EXECUTION_FAILED" : null,
        })
        return
      }
      if (waiting) return
      await this.dependencies.store.updateRun(run.id, {
        state: "completed",
        completedAt,
      })
      await this.dependencies.store.updateThread(actor.workspaceId, thread.id, {
        lastActivityAt: completedAt,
      })
      yield await this.dependencies.eventStore.append({
        threadId: thread.id,
        runId: run.id,
        sourceEventId: `${run.id}:completed`,
        occurredAt: completedAt.toISOString(),
        source: "forge",
        type: "run.completed",
        schemaVersion: 1,
        payload: {},
      })
    } catch (error) {
      const completedAt = this.now()
      const failure = runFailure(error)
      emitTelemetry("run.failed", "agent.run", {
        runId: run.id,
        errorCode: failure.errorCode,
      })
      if (error instanceof AgentRunLimitError) {
        await runtime
          .cancel(
            run.id,
            runtimeSessionId,
            this.runtimeCancellationContext(actor, run)
          )
          .catch(() => {})
      }
      await this.dependencies.store.updateRun(run.id, {
        state: "failed",
        completedAt,
        errorCode: failure.errorCode,
      })
      yield await this.dependencies.eventStore.append({
        threadId: thread.id,
        runId: run.id,
        sourceEventId: `${run.id}:failed`,
        occurredAt: completedAt.toISOString(),
        source: "forge",
        type: "run.failed",
        schemaVersion: 1,
        payload: failure,
      })
    } finally {
      emitTelemetry("run.finished", "agent.run", {
        runId: run.id,
        durationMs: Math.max(
          0,
          this.now().getTime() - (run.startedAt ?? run.createdAt).getTime()
        ),
      })
    }
  }

  private requestRuntimeApproval(
    actor: Actor,
    runId: string,
    request: {
      approvalId?: string
      capabilityId: string
      capabilityVersion: string
      risk: "read" | "reversible-write" | "important-write" | "destructive"
      summary: string
      input?: Record<string, unknown>
      details: Record<string, unknown>
      expiresAt?: string
    }
  ) {
    if (!this.dependencies.approvals) {
      throw new AgentCoordinatorError(
        "RUNTIME_UNAVAILABLE",
        "The approval service is unavailable."
      )
    }
    return this.dependencies.approvals.request(actor, {
      approvalId: request.approvalId,
      runId,
      capabilityId: request.capabilityId,
      capabilityVersion: request.capabilityVersion,
      risk: request.risk,
      input: request.input ?? {
        summary: request.summary,
        details: request.details,
      },
      redactedInputSummary: {
        summary: request.summary,
        details: request.details,
      },
      ...(request.expiresAt ? { expiresAt: new Date(request.expiresAt) } : {}),
    })
  }

  private resolveAttachments(
    actor: Actor,
    attachmentIds: ReadonlyArray<string>
  ) {
    if (attachmentIds.length === 0) {
      return Promise.resolve<Array<ResolvedAgentAttachment>>([])
    }
    if (!this.dependencies.attachments) {
      throw new AgentCoordinatorError(
        "RUNTIME_UNAVAILABLE",
        "Attachments are unavailable for this deployment."
      )
    }
    return this.dependencies.attachments.resolve(actor, attachmentIds)
  }
}

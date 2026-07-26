import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { app } from "electron"
import { z } from "zod"

import { CodexAppServer } from "./adapters/codex-app-server"
import {
  CodexEventNormalizer,
  parseCodexServerRequest,
} from "./adapters/codex-event-normalizer"
import { discoverCodexCli } from "./cli-discovery"
import type {
  LocalAgentBrokerEvent,
  StartLocalRuntimeRunInput,
} from "../../../src/host/forge-host"
import type { RpcId, RpcMessage } from "./process-supervisor"
import type { DiscoveredCli } from "./cli-discovery"

export const localRuntimeSnapshotSchema = z
  .object({
    id: z.literal("codex"),
    label: z.literal("Codex"),
    status: z.enum([
      "ready",
      "login-required",
      "repair-required",
      "unavailable",
      "policy-blocked",
    ]),
    statusReason: z.string().nullable(),
    accountLabel: z.string().nullable(),
    billingMode: z.literal("subscription"),
    locality: z.literal("local-only"),
    models: z.array(
      z.object({
        selectionId: z.string(),
        modelId: z.string(),
        displayName: z.string(),
        supportedReasoningEfforts: z.array(z.string()),
        contextWindowTokens: z.number().nullable(),
      })
    ),
  })
  .strict()

export type LocalRuntimeSnapshot = z.infer<typeof localRuntimeSnapshotSchema>

type ActiveCodexRun = {
  runId: string
  runtimeThreadId: string
  runtimeTurnId: string | null
  normalizer: CodexEventNormalizer
  emit: (event: LocalAgentBrokerEvent) => void
}

type PendingCodexApproval = {
  runId: string
  requestId: RpcId
  expiresAt: number
}

type PendingCodexToolCall = {
  runId: string
  requestId: RpcId
  callId: string
  tool: string
  expiresAt: number
}

type CodexRuntime = Pick<
  CodexAppServer,
  | "snapshot"
  | "startChatGptLogin"
  | "startThread"
  | "resumeThread"
  | "startTurn"
  | "interruptTurn"
  | "subscribe"
  | "subscribeRequests"
  | "respond"
  | "reject"
  | "stop"
>

type ModelBrokerOptions = {
  discoverCodex?: () => Promise<DiscoveredCli | null>
  userDataPath?: () => string
  createCodex?: (executablePath: string, cwd: string) => CodexRuntime
  id?: () => string
  now?: () => number
}

export class ModelBroker {
  #codex: CodexRuntime | null = null
  #unsubscribeCodexNotifications: (() => void) | null = null
  #unsubscribeCodexRequests: (() => void) | null = null
  #runs = new Map<string, ActiveCodexRun>()
  #runByThread = new Map<string, string>()
  #runByTurn = new Map<string, string>()
  #pendingApprovals = new Map<string, PendingCodexApproval>()
  #pendingToolCalls = new Map<string, PendingCodexToolCall>()
  readonly #discoverCodex: () => Promise<DiscoveredCli | null>
  readonly #userDataPath: () => string
  readonly #createCodex: (executablePath: string, cwd: string) => CodexRuntime
  readonly #id: () => string
  readonly #now: () => number

  constructor(options: ModelBrokerOptions = {}) {
    this.#discoverCodex = options.discoverCodex ?? discoverCodexCli
    this.#userDataPath = options.userDataPath ?? (() => app.getPath("userData"))
    this.#createCodex =
      options.createCodex ??
      ((executablePath, cwd) => new CodexAppServer(executablePath, cwd))
    this.#id = options.id ?? randomUUID
    this.#now = options.now ?? Date.now
  }

  #ensureCodexSubscriptions(codex: CodexRuntime) {
    if (!this.#unsubscribeCodexNotifications) {
      this.#unsubscribeCodexNotifications = codex.subscribe((message) =>
        this.#handleCodexNotification(message)
      )
    }
    if (!this.#unsubscribeCodexRequests) {
      this.#unsubscribeCodexRequests = codex.subscribeRequests((message) =>
        this.#handleCodexRequest(message)
      )
    }
  }

  #runForMessage(message: RpcMessage) {
    const params =
      typeof message.params === "object" && message.params
        ? (message.params as Record<string, unknown>)
        : {}
    const turnId =
      typeof params.turnId === "string"
        ? params.turnId
        : typeof params.turn === "object" &&
            params.turn &&
            typeof Reflect.get(params.turn, "id") === "string"
          ? (Reflect.get(params.turn, "id") as string)
          : null
    const threadId =
      typeof params.threadId === "string" ? params.threadId : null
    const runId =
      (turnId ? this.#runByTurn.get(turnId) : undefined) ??
      (threadId ? this.#runByThread.get(threadId) : undefined)
    return runId ? (this.#runs.get(runId) ?? null) : null
  }

  #handleCodexNotification(message: RpcMessage) {
    const run = this.#runForMessage(message)
    if (!run) return
    const events = run.normalizer.normalize(message)
    for (const event of events) {
      run.emit({
        type: "runtime-event",
        runId: run.runId,
        event: {
          ...event,
          source: "codex",
          occurredAt: new Date(this.#now()).toISOString(),
        },
      })
      if (
        event.type === "run.completed" ||
        event.type === "run.cancelled" ||
        event.type === "run.failed"
      ) {
        this.#finishRun(run.runId)
      }
    }
  }

  #handleCodexRequest(message: RpcMessage & { id: RpcId }) {
    const run = this.#runForMessage(message)
    const request = parseCodexServerRequest(message)
    if (!run || !request) {
      this.#codex?.reject(
        message.id,
        -32_601,
        "Forge cannot handle this local runtime request."
      )
      return
    }

    if (request.method === "item/tool/call") {
      const requestId = this.#id()
      this.#pendingToolCalls.set(requestId, {
        runId: run.runId,
        requestId: request.requestId,
        callId: request.callId,
        tool: request.tool,
        expiresAt: this.#now() + 60_000,
      })
      run.emit({
        type: "runtime-event",
        runId: run.runId,
        event: {
          sourceEventId: `${request.threadId}:${request.turnId}:tool:${request.callId}:started`,
          source: "codex",
          type: "tool.started",
          occurredAt: new Date(this.#now()).toISOString(),
          payload: {
            callId: request.callId,
            toolName: request.tool,
            namespace: request.namespace,
            input: request.arguments,
          },
        },
      })
      run.emit({
        type: "tool-call-request",
        runId: run.runId,
        requestId,
        namespace: request.namespace,
        tool: request.tool,
        arguments: request.arguments,
      })
      return
    }

    const approvalId = this.#id()
    this.#pendingApprovals.set(approvalId, {
      runId: run.runId,
      requestId: request.requestId,
      expiresAt: this.#now() + 5 * 60_000,
    })
    run.emit({
      type: "runtime-event",
      runId: run.runId,
      event: {
        sourceEventId: `${request.threadId}:${request.turnId}:approval:${request.itemId}`,
        source: "codex",
        type: "approval.requested",
        occurredAt: new Date(this.#now()).toISOString(),
        payload: {
          approvalId,
          risk:
            request.method === "item/fileChange/requestApproval"
              ? "important-write"
              : "reversible-write",
          capabilityId:
            request.method === "item/fileChange/requestApproval"
              ? "codex.file-change"
              : "codex.command",
          summary: request.summary,
          details: request.details,
          expiresAt: new Date(this.#now() + 5 * 60_000).toISOString(),
        },
      },
    })
  }

  #finishRun(runId: string) {
    const run = this.#runs.get(runId)
    if (!run) return
    this.#runs.delete(runId)
    this.#runByThread.delete(run.runtimeThreadId)
    if (run.runtimeTurnId) this.#runByTurn.delete(run.runtimeTurnId)
    for (const [approvalId, pending] of this.#pendingApprovals) {
      if (pending.runId === runId) this.#pendingApprovals.delete(approvalId)
    }
    for (const [requestId, pending] of this.#pendingToolCalls) {
      if (pending.runId !== runId) continue
      this.#codex?.respond(pending.requestId, {
        contentItems: [
          {
            type: "inputText",
            text: "The Forge run ended before the tool call completed.",
          },
        ],
        success: false,
      })
      this.#pendingToolCalls.delete(requestId)
    }
  }

  #resetCodex() {
    this.#unsubscribeCodexNotifications?.()
    this.#unsubscribeCodexRequests?.()
    this.#unsubscribeCodexNotifications = null
    this.#unsubscribeCodexRequests = null
    this.#codex?.stop()
    this.#codex = null
  }

  async inspectCodex(): Promise<LocalRuntimeSnapshot> {
    const discovered = await this.#discoverCodex()
    if (!discovered) {
      return {
        id: "codex",
        label: "Codex",
        status: "unavailable",
        statusReason: "Codex CLI was not found in a trusted location.",
        accountLabel: null,
        billingMode: "subscription",
        locality: "local-only",
        models: [],
      }
    }
    try {
      this.#codex ??= this.#createCodex(
        discovered.executablePath,
        this.#userDataPath()
      )
      this.#ensureCodexSubscriptions(this.#codex)
      const snapshot = await this.#codex.snapshot()
      if (!snapshot.account) {
        return {
          id: "codex",
          label: "Codex",
          status: "login-required",
          statusReason: "Sign in through the official Codex login flow.",
          accountLabel: null,
          billingMode: "subscription",
          locality: "local-only",
          models: [],
        }
      }
      return {
        id: "codex",
        label: "Codex",
        status: "ready",
        statusReason: null,
        accountLabel:
          snapshot.account.email ?? snapshot.account.planType ?? "ChatGPT",
        billingMode: "subscription",
        locality: "local-only",
        models: snapshot.models.map((model) => ({
          selectionId: `local:codex:${model.id}`,
          modelId: model.id,
          displayName: model.displayName,
          supportedReasoningEfforts: model.supportedReasoningEfforts,
          contextWindowTokens: model.contextWindowTokens,
        })),
      }
    } catch {
      this.#resetCodex()
      return {
        id: "codex",
        label: "Codex",
        status: "repair-required",
        statusReason:
          "Codex could not start. Reinstall or update the Codex CLI, then try again.",
        accountLabel: null,
        billingMode: "subscription",
        locality: "local-only",
        models: [],
      }
    }
  }

  async startCodexLogin() {
    const discovered = await this.#discoverCodex()
    if (!discovered) throw new Error("Codex CLI is not installed.")
    this.#codex ??= this.#createCodex(
      discovered.executablePath,
      this.#userDataPath()
    )
    this.#ensureCodexSubscriptions(this.#codex)
    return this.#codex.startChatGptLogin()
  }

  async startCodexRun(
    input: StartLocalRuntimeRunInput,
    emit: (event: LocalAgentBrokerEvent) => void
  ) {
    const discovered = await this.#discoverCodex()
    if (!discovered) throw new Error("Codex CLI is not installed.")
    this.#codex ??= this.#createCodex(
      discovered.executablePath,
      this.#userDataPath()
    )
    this.#ensureCodexSubscriptions(this.#codex)

    const cwd = join(this.#userDataPath(), "agent-runs", input.runId)
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    const attachmentPaths = await Promise.all(
      input.attachments.map(async (attachment, index) => {
        const fileName = `attachment-${String(index + 1).padStart(2, "0")}-${attachment.name}`
        const filePath = join(cwd, fileName)
        const content = Buffer.from(attachment.contentBase64, "base64")
        if (content.byteLength !== attachment.sizeBytes) {
          throw new Error("A local runtime attachment failed validation.")
        }
        await writeFile(filePath, content, { flag: "wx", mode: 0o400 })
        return {
          path: filePath,
          name: attachment.name,
          contentType: attachment.contentType,
        }
      })
    )
    const message =
      attachmentPaths.length === 0
        ? input.message
        : `${input.message}\n\nThe user attached these read-only files. Read them only when relevant:\n${attachmentPaths
            .map(
              (attachment) =>
                `- ${attachment.name} (${attachment.contentType}): ${attachment.path}`
            )
            .join("\n")}`
    const runtimeThreadId = input.runtimeSessionId
      ? await this.#codex.resumeThread({
          threadId: input.runtimeSessionId,
          modelId: input.modelId,
        })
      : await this.#codex.startThread({ modelId: input.modelId, cwd })
    const run: ActiveCodexRun = {
      runId: input.runId,
      runtimeThreadId,
      runtimeTurnId: null,
      normalizer: new CodexEventNormalizer(),
      emit,
    }
    this.#runs.set(input.runId, run)
    this.#runByThread.set(runtimeThreadId, input.runId)

    try {
      const runtimeTurnId = await this.#codex.startTurn({
        threadId: runtimeThreadId,
        message,
        modelId: input.modelId,
        effort: input.reasoningEffort,
        cwd,
        clientUserMessageId: input.runId,
      })
      run.runtimeTurnId = runtimeTurnId
      this.#runByTurn.set(runtimeTurnId, input.runId)
      return { runtimeSessionId: runtimeThreadId, runtimeRunId: runtimeTurnId }
    } catch (error) {
      this.#finishRun(input.runId)
      throw error
    }
  }

  async cancelCodexRun(runId: string) {
    const run = this.#runs.get(runId)
    if (!run?.runtimeTurnId || !this.#codex) return
    await this.#codex.interruptTurn(run.runtimeThreadId, run.runtimeTurnId)
  }

  resolveCodexApproval(input: {
    runId: string
    approvalId: string
    decision: "approved" | "denied"
  }) {
    const pending = this.#pendingApprovals.get(input.approvalId)
    if (
      !pending ||
      pending.runId !== input.runId ||
      pending.expiresAt <= this.#now()
    ) {
      this.#pendingApprovals.delete(input.approvalId)
      throw new Error("The local runtime approval is invalid or expired.")
    }
    this.#pendingApprovals.delete(input.approvalId)
    this.#codex?.respond(pending.requestId, {
      decision: input.decision === "approved" ? "accept" : "decline",
    })
    const run = this.#runs.get(input.runId)
    run?.emit({
      type: "runtime-event",
      runId: input.runId,
      event: {
        sourceEventId: `${input.runId}:approval:${input.approvalId}:resolved`,
        source: "codex",
        type: "approval.resolved",
        occurredAt: new Date(this.#now()).toISOString(),
        payload: {
          approvalId: input.approvalId,
          decision: input.decision,
        },
      },
    })
  }

  resolveCodexToolCall(input: {
    runId: string
    requestId: string
    success: boolean
    output: unknown
  }) {
    const pending = this.#pendingToolCalls.get(input.requestId)
    if (
      !pending ||
      pending.runId !== input.runId ||
      pending.expiresAt <= this.#now()
    ) {
      this.#pendingToolCalls.delete(input.requestId)
      throw new Error("The local runtime tool call is invalid or expired.")
    }
    this.#pendingToolCalls.delete(input.requestId)
    const text =
      typeof input.output === "string"
        ? input.output
        : JSON.stringify(input.output)
    this.#codex?.respond(pending.requestId, {
      contentItems: [
        {
          type: "inputText",
          text,
        },
      ],
      success: input.success,
    })
    const run = this.#runs.get(input.runId)
    run?.emit({
      type: "runtime-event",
      runId: input.runId,
      event: {
        sourceEventId: `${input.runId}:tool:${pending.callId}:resolved`,
        source: "codex",
        type: input.success ? "tool.completed" : "tool.failed",
        occurredAt: new Date(this.#now()).toISOString(),
        payload: {
          callId: pending.callId,
          toolName: pending.tool,
          status: input.success ? "completed" : "failed",
          output: input.output,
        },
      },
    })
  }

  stop() {
    this.#resetCodex()
    this.#runs.clear()
    this.#runByThread.clear()
    this.#runByTurn.clear()
    this.#pendingApprovals.clear()
    this.#pendingToolCalls.clear()
  }
}

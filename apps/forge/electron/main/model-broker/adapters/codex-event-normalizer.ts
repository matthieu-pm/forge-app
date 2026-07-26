import { z } from "zod"

import type { AgentEventType } from "../../../../src/application/agents/event-contract"
import type { RpcId, RpcMessage } from "../process-supervisor"

const envelopeSchema = z
  .object({
    method: z.string(),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough()

const itemSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    status: z.string().optional(),
  })
  .passthrough()

export type NormalizedCodexEvent = {
  sourceEventId: string
  type: AgentEventType
  payload: Record<string, unknown>
}

export type CodexApprovalRequest = {
  requestId: RpcId
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
  threadId: string
  turnId: string
  itemId: string
  summary: string
  details: Record<string, unknown>
}

export type CodexDynamicToolRequest = {
  requestId: RpcId
  method: "item/tool/call"
  threadId: string
  turnId: string
  callId: string
  namespace: string | null
  tool: string
  arguments: Record<string, unknown>
}

function boundedString(value: unknown, maximum = 20_000) {
  return typeof value === "string" ? value.slice(0, maximum) : null
}

function identifiers(params: Record<string, unknown>) {
  const item =
    typeof params.item === "object" && params.item
      ? (params.item as Record<string, unknown>)
      : null
  return {
    threadId: boundedString(params.threadId, 255),
    turnId: boundedString(params.turnId, 255),
    itemId:
      boundedString(params.itemId, 255) ??
      boundedString(item?.id, 255) ??
      "unknown-item",
  }
}

function messageText(item: Record<string, unknown>) {
  const direct =
    boundedString(item.text) ??
    boundedString(item.message) ??
    boundedString(item.content)
  if (direct) return direct
  if (!Array.isArray(item.content)) return null
  return item.content
    .map((part) => {
      if (typeof part === "string") return part
      if (typeof part !== "object" || !part) return ""
      return boundedString(Reflect.get(part, "text")) ?? ""
    })
    .join("")
    .slice(0, 100_000)
}

function itemLifecycleType(
  itemType: string,
  phase: "started" | "completed",
  failed: boolean
): AgentEventType | null {
  if (itemType === "agentMessage") {
    return phase === "completed" ? "assistant.message" : null
  }
  if (itemType === "commandExecution") {
    if (failed) return "tool.failed"
    return phase === "started" ? "code.started" : "code.completed"
  }
  if (itemType === "fileChange") {
    if (failed) return "tool.failed"
    return phase === "started" ? "file.patch.proposed" : "file.patch.applied"
  }
  if (itemType === "webSearch") {
    if (failed) return "tool.failed"
    return phase === "started" ? "file.search.started" : "file.search.completed"
  }
  if (
    itemType === "mcpToolCall" ||
    itemType === "dynamicToolCall" ||
    itemType === "collabAgentToolCall"
  ) {
    if (failed) return "tool.failed"
    return phase === "started" ? "tool.started" : "tool.completed"
  }
  if (itemType === "imageView" && phase === "completed") return "file.read"
  return null
}

export class CodexEventNormalizer {
  #sequence = 0

  normalize(value: unknown): Array<NormalizedCodexEvent> {
    const parsed = envelopeSchema.safeParse(value)
    if (!parsed.success) return []
    const { method, params } = parsed.data
    const { threadId, turnId, itemId } = identifiers(params)
    const sourceId = () => {
      this.#sequence += 1
      return `${threadId ?? "thread"}:${turnId ?? "turn"}:${method}:${itemId}:${this.#sequence}`
    }

    if (method === "item/agentMessage/delta") {
      const delta = boundedString(params.delta, 100_000)
      return delta
        ? [
            {
              sourceEventId: sourceId(),
              type: "assistant.delta",
              payload: { messageId: itemId, delta },
            },
          ]
        : []
    }

    if (method === "item/commandExecution/outputDelta") {
      const delta = boundedString(params.delta, 100_000)
      return delta
        ? [
            {
              sourceEventId: sourceId(),
              type: "code.output",
              payload: {
                callId: itemId,
                output: delta,
                stream: boundedString(params.stream, 20) ?? "stdout",
              },
            },
          ]
        : []
    }

    if (method === "item/reasoning/summaryTextDelta") {
      const delta = boundedString(params.delta, 20_000)
      return delta
        ? [
            {
              sourceEventId: sourceId(),
              type: "progress.note",
              payload: { messageId: itemId, delta },
            },
          ]
        : []
    }

    if (method === "item/reasoning/textDelta") {
      return []
    }

    if (method === "turn/plan/updated") {
      const plan = Array.isArray(params.plan) ? params.plan.slice(0, 100) : []
      return [
        {
          sourceEventId: sourceId(),
          type: "progress.note",
          payload: {
            message:
              boundedString(params.explanation, 20_000) ?? "Plan updated",
            plan,
          },
        },
      ]
    }

    if (method === "warning" || method === "configWarning") {
      const message =
        boundedString(params.message, 20_000) ??
        boundedString(params.summary, 20_000)
      return message
        ? [
            {
              sourceEventId: sourceId(),
              type: "progress.note",
              payload: { message },
            },
          ]
        : []
    }

    if (method === "error") {
      const error =
        typeof params.error === "object" && params.error
          ? (params.error as Record<string, unknown>)
          : params
      return [
        {
          sourceEventId: sourceId(),
          type: "run.failed",
          payload: {
            code: boundedString(error.codexErrorInfo, 255) ?? "CODEX_ERROR",
            message:
              boundedString(error.message, 2_000) ??
              "The Codex runtime failed.",
          },
        },
      ]
    }

    if (method === "turn/completed") {
      const turn =
        typeof params.turn === "object" && params.turn
          ? (params.turn as Record<string, unknown>)
          : {}
      const status = boundedString(turn.status, 50)
      if (status === "interrupted") {
        return [
          {
            sourceEventId: sourceId(),
            type: "run.cancelled",
            payload: {},
          },
        ]
      }
      if (status === "failed") {
        const error =
          typeof turn.error === "object" && turn.error
            ? (turn.error as Record<string, unknown>)
            : {}
        return [
          {
            sourceEventId: sourceId(),
            type: "run.failed",
            payload: {
              code: "CODEX_TURN_FAILED",
              message:
                boundedString(error.message, 2_000) ?? "The Codex turn failed.",
            },
          },
        ]
      }
      return [
        {
          sourceEventId: sourceId(),
          type: "run.completed",
          payload: {},
        },
      ]
    }

    if (method === "item/started" || method === "item/completed") {
      const itemResult = itemSchema.safeParse(params.item)
      if (!itemResult.success) return []
      const item = itemResult.data
      const phase = method === "item/started" ? "started" : "completed"
      const failed =
        item.status === "failed" ||
        item.status === "declined" ||
        item.status === "error"
      const type = itemLifecycleType(item.type, phase, failed)
      if (!type) return []
      const payload: Record<string, unknown> = {
        callId: item.id,
        kind: item.type,
        status: item.status,
      }
      if (type === "assistant.message") {
        payload.messageId = item.id
        payload.content = messageText(item) ?? ""
      } else {
        payload.item = item
        const command =
          boundedString(item.command) ??
          (Array.isArray(item.command)
            ? item.command
                .filter((part): part is string => typeof part === "string")
                .join(" ")
                .slice(0, 20_000)
            : null)
        const query =
          boundedString(item.query, 2_000) ?? boundedString(item.pattern, 2_000)
        const path =
          boundedString(item.path, 2_000) ?? boundedString(item.filePath, 2_000)
        const toolName =
          boundedString(item.toolName, 255) ??
          boundedString(item.tool, 255) ??
          boundedString(item.name, 255)
        const title =
          boundedString(item.title, 2_000) ?? boundedString(item.summary, 2_000)
        if (command) payload.command = command
        if (query) payload.query = query
        if (path) payload.path = path
        if (toolName) payload.toolName = toolName
        if (title) payload.title = title
      }
      return [{ sourceEventId: sourceId(), type, payload }]
    }

    return []
  }
}

export function parseCodexServerRequest(
  message: RpcMessage & { id: RpcId }
): CodexApprovalRequest | CodexDynamicToolRequest | null {
  if (typeof message.method !== "string") return null
  const params =
    typeof message.params === "object" && message.params
      ? (message.params as Record<string, unknown>)
      : {}
  const threadId = boundedString(params.threadId, 255)
  const turnId = boundedString(params.turnId, 255)
  if (!threadId || !turnId) return null

  if (message.method === "item/tool/call") {
    const callId = boundedString(params.callId, 255)
    const tool = boundedString(params.tool, 255)
    if (!callId || !tool) return null
    return {
      requestId: message.id,
      method: "item/tool/call",
      threadId,
      turnId,
      callId,
      namespace: boundedString(params.namespace, 255),
      tool,
      arguments:
        typeof params.arguments === "object" && params.arguments
          ? (params.arguments as Record<string, unknown>)
          : {},
    }
  }

  if (
    message.method !== "item/commandExecution/requestApproval" &&
    message.method !== "item/fileChange/requestApproval"
  ) {
    return null
  }
  const itemId = boundedString(params.itemId, 255)
  if (!itemId) return null
  const command =
    boundedString(params.command, 20_000) ??
    (Array.isArray(params.command)
      ? params.command
          .filter((part): part is string => typeof part === "string")
          .join(" ")
          .slice(0, 20_000)
      : null)
  const reason = boundedString(params.reason, 2_000)

  return {
    requestId: message.id,
    method: message.method,
    threadId,
    turnId,
    itemId,
    summary:
      reason ??
      command ??
      (message.method === "item/fileChange/requestApproval"
        ? "Apply the proposed file changes"
        : "Run the proposed command"),
    details: {
      command,
      reason,
      cwd: boundedString(params.cwd, 2_000),
      availableDecisions: Array.isArray(params.availableDecisions)
        ? params.availableDecisions.slice(0, 20)
        : undefined,
    },
  }
}

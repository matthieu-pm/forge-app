import { z } from "zod"

import type { RuntimeEvent } from "@/application/agents/runtime-contract"

const actionRequestSchema = z
  .object({
    callId: z.string(),
    kind: z.string(),
    toolName: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

const actionResultSchema = z
  .object({
    callId: z.string(),
    kind: z.string(),
    toolName: z.string().optional(),
    output: z.unknown().optional(),
  })
  .passthrough()

const inputRequestSchema = z
  .object({
    requestId: z.string().min(1),
    prompt: z.string().min(1),
    display: z.enum(["confirmation", "select", "text"]).optional(),
    action: z
      .object({
        callId: z.string().min(1),
        kind: z.literal("tool-call"),
        toolName: z.string().min(1),
        input: z.record(z.string(), z.unknown()),
      })
      .strict(),
    options: z
      .array(
        z
          .object({
            id: z.string(),
            label: z.string(),
          })
          .passthrough()
      )
      .optional(),
    allowFreeform: z.boolean().optional(),
  })
  .passthrough()

const eventSchema = z
  .object({
    type: z.string(),
    data: z.record(z.string(), z.unknown()).default({}),
    _meta: z.object({ at: z.string().optional() }).optional(),
  })
  .passthrough()

function actionEventType(
  toolName: string | undefined,
  phase: "started" | "completed" | "failed"
): RuntimeEvent["type"] {
  if (phase === "failed") return "tool.failed"
  if (toolName === "bash" || toolName === "execute_program") {
    return phase === "started" ? "code.started" : "code.completed"
  }
  if (toolName === "glob" || toolName === "grep") {
    return phase === "started" ? "file.search.started" : "file.search.completed"
  }
  if (toolName === "read_file" && phase !== "started") return "file.read"
  if (toolName === "write_file") {
    return phase === "started" ? "file.patch.proposed" : "file.patch.applied"
  }
  return phase === "started" ? "tool.started" : "tool.completed"
}

function sourceId(
  sessionId: string,
  type: string,
  data: Record<string, unknown>,
  suffix?: string,
  streamIndex?: number
) {
  // EVE repeats data.sequence across token deltas; the NDJSON index is unique.
  const sequence =
    typeof streamIndex === "number"
      ? `stream-${streamIndex}`
      : typeof data.sequence === "number"
        ? String(data.sequence)
        : "unsequenced"
  return `${sessionId}:${type}:${sequence}${suffix ? `:${suffix}` : ""}`
}

function approvalCapability(toolName: string) {
  if (toolName === "update_team") {
    return {
      capabilityId: "teams.update",
      capabilityVersion: "1",
      risk: "reversible-write" as const,
    }
  }
  if (toolName === "execute_program") {
    return {
      capabilityId: "program.execute",
      capabilityVersion: "1",
      risk: "reversible-write" as const,
    }
  }
  return {
    capabilityId: `eve.tool.${toolName}`,
    capabilityVersion: "1",
    risk: "important-write" as const,
  }
}

function programCallEvents(
  result: z.infer<typeof actionResultSchema>,
  event: z.infer<typeof eventSchema>,
  sessionId: string,
  occurredAt: string | undefined,
  streamIndex: number | undefined
): Array<RuntimeEvent> {
  if (result.toolName !== "execute_program") return []
  const rawOutput =
    result.output &&
    typeof result.output === "object" &&
    Reflect.get(result.output, "type") === "json"
      ? Reflect.get(result.output, "value")
      : result.output
  if (!rawOutput || typeof rawOutput !== "object") return []
  const calls = Reflect.get(rawOutput, "calls")
  if (!Array.isArray(calls)) return []
  return calls.flatMap((call, index) => {
    if (!call || typeof call !== "object") return []
    const capabilityId = Reflect.get(call, "capabilityId")
    if (typeof capabilityId !== "string") return []
    return [
      {
        sourceEventId: sourceId(
          sessionId,
          event.type,
          event.data,
          `${result.callId}:program:${index}`,
          streamIndex
        ),
        source: "eve",
        type: "tool.completed",
        occurredAt,
        payload: {
          callId: `${result.callId}:program:${index}`,
          toolName: capabilityId,
          input: Reflect.get(call, "input"),
          output: Reflect.get(call, "result"),
          programCallId: result.callId,
        },
      } satisfies RuntimeEvent,
    ]
  })
}

function unwrapToolOutput(output: unknown) {
  return output &&
    typeof output === "object" &&
    Reflect.get(output, "type") === "json"
    ? Reflect.get(output, "value")
    : output
}

function artifactEvent(
  result: z.infer<typeof actionResultSchema>,
  occurredAt: string | undefined
): Array<RuntimeEvent> {
  if (result.toolName !== "create_artifact") return []
  const output = unwrapToolOutput(result.output)
  if (!output || typeof output !== "object") return []
  const id = Reflect.get(output, "id")
  if (typeof id !== "string") return []
  return [
    {
      sourceEventId: `artifact:${id}`,
      source: "eve",
      type: "artifact.created",
      occurredAt,
      payload: output as Record<string, unknown>,
    },
  ]
}

export function normalizeEveRuntimeEvent(
  value: unknown,
  sessionId: string,
  streamIndex?: number
): Array<RuntimeEvent> {
  const event = eventSchema.parse(value)
  const occurredAt = event._meta?.at

  if (event.type === "message.appended") {
    return [
      {
        sourceEventId: sourceId(
          sessionId,
          event.type,
          event.data,
          undefined,
          streamIndex
        ),
        source: "eve",
        type: "assistant.delta",
        occurredAt,
        payload: {
          messageId: `${String(event.data.turnId)}:${String(event.data.stepIndex)}`,
          delta: event.data.messageDelta,
        },
      },
    ]
  }

  if (event.type === "message.completed") {
    return [
      {
        sourceEventId: sourceId(
          sessionId,
          event.type,
          event.data,
          undefined,
          streamIndex
        ),
        source: "eve",
        type: "assistant.message",
        occurredAt,
        payload: {
          messageId: `${String(event.data.turnId)}:${String(event.data.stepIndex)}`,
          content: event.data.message,
          finishReason: event.data.finishReason,
        },
      },
    ]
  }

  if (event.type === "step.completed") {
    const usage = z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        cacheReadTokens: z.number().int().nonnegative().optional(),
        cacheWriteTokens: z.number().int().nonnegative().optional(),
        costUsd: z.number().nonnegative().optional(),
      })
      .passthrough()
      .optional()
      .parse(event.data.usage)
    if (!usage) return []
    return [
      {
        sourceEventId: sourceId(
          sessionId,
          event.type,
          event.data,
          undefined,
          streamIndex
        ),
        source: "eve",
        type: "run.usage",
        occurredAt,
        payload: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cachedInputTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
          costMicros: Math.round((usage.costUsd ?? 0) * 1_000_000),
        },
      },
    ]
  }

  if (event.type === "actions.requested") {
    const actions = z.array(actionRequestSchema).parse(event.data.actions)
    return actions.map((action) => ({
      sourceEventId: sourceId(
        sessionId,
        event.type,
        event.data,
        action.callId,
        streamIndex
      ),
      source: "eve",
      type: actionEventType(action.toolName, "started"),
      occurredAt,
      payload: {
        callId: action.callId,
        kind: action.kind,
        toolName: action.toolName,
        input: action.input,
      },
    }))
  }

  if (event.type === "action.result") {
    const result = actionResultSchema.parse(event.data.result)
    const status =
      event.data.status === "failed" || event.data.status === "rejected"
        ? "failed"
        : "completed"
    return [
      ...programCallEvents(result, event, sessionId, occurredAt, streamIndex),
      ...artifactEvent(result, occurredAt),
      {
        sourceEventId: sourceId(
          sessionId,
          event.type,
          event.data,
          result.callId,
          streamIndex
        ),
        source: "eve",
        type: actionEventType(result.toolName, status),
        occurredAt,
        payload: {
          callId: result.callId,
          kind: result.kind,
          toolName: result.toolName,
          status: event.data.status,
          output: result.output,
          error: event.data.error,
        },
      },
    ]
  }

  if (event.type === "authorization.required") {
    const risk = [
      "reversible-write",
      "important-write",
      "destructive",
    ].includes(String(event.data.risk))
      ? String(event.data.risk)
      : "important-write"
    return [
      {
        sourceEventId: sourceId(
          sessionId,
          event.type,
          event.data,
          undefined,
          streamIndex
        ),
        source: "eve",
        type: "approval.requested",
        occurredAt,
        payload: {
          capabilityId:
            typeof event.data.capabilityId === "string"
              ? event.data.capabilityId
              : "eve.authorization",
          capabilityVersion:
            typeof event.data.capabilityVersion === "string"
              ? event.data.capabilityVersion
              : "1",
          risk,
          summary:
            typeof event.data.summary === "string"
              ? event.data.summary
              : typeof event.data.message === "string"
                ? event.data.message
                : "Allow the requested Forge action",
          input:
            typeof event.data.input === "object" && event.data.input
              ? event.data.input
              : {},
          details: event.data,
          ...(typeof event.data.expiresAt === "string"
            ? { expiresAt: event.data.expiresAt }
            : {}),
        },
      },
    ]
  }

  if (event.type === "input.requested") {
    const requests = z.array(inputRequestSchema).parse(event.data.requests)
    return requests.map((request) => {
      if (request.display === "confirmation") {
        return {
          sourceEventId: sourceId(
            sessionId,
            event.type,
            event.data,
            request.requestId,
            streamIndex
          ),
          source: "eve",
          type: "approval.requested",
          occurredAt,
          payload: {
            ...approvalCapability(request.action.toolName),
            summary: request.prompt,
            input: request.action.input,
            details: {
              runtimeRequestId: request.requestId,
              callId: request.action.callId,
              toolName: request.action.toolName,
              options: request.options,
              ...(request.action.toolName === "execute_program" &&
              Array.isArray(request.action.input.capabilityManifest)
                ? {
                    programManifest:
                      request.action.input.capabilityManifest,
                  }
                : {}),
            },
          },
        } satisfies RuntimeEvent
      }

      return {
        sourceEventId: sourceId(
          sessionId,
          event.type,
          event.data,
          request.requestId,
          streamIndex
        ),
        source: "eve",
        type: "run.waiting",
        occurredAt,
        payload: {
          reason: "input-required",
          request,
        },
      } satisfies RuntimeEvent
    })
  }

  if (event.type === "turn.cancelled") {
    return [
      {
        sourceEventId: sourceId(
          sessionId,
          event.type,
          event.data,
          undefined,
          streamIndex
        ),
        source: "eve",
        type: "run.cancelled",
        occurredAt,
        payload: {},
      },
    ]
  }

  if (event.type === "turn.failed" || event.type === "session.failed") {
    return [
      {
        sourceEventId: sourceId(
          sessionId,
          event.type,
          event.data,
          undefined,
          streamIndex
        ),
        source: "eve",
        type: "run.failed",
        occurredAt,
        payload: {
          code: event.data.code,
          message: event.data.message,
        },
      },
    ]
  }

  return []
}

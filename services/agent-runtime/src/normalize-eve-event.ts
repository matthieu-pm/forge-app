import { z } from "zod"

const eveEventSchema = z
  .object({
    id: z.string().optional(),
    type: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

export type NormalizedRuntimeEvent = {
  sourceEventId: string
  source: "eve"
  type:
    | "progress.note"
    | "assistant.delta"
    | "assistant.message"
    | "tool.started"
    | "tool.completed"
    | "tool.failed"
    | "code.started"
    | "code.completed"
    | "approval.requested"
    | "approval.resolved"
    | "run.waiting"
    | "run.failed"
  payload: Record<string, unknown>
}

const EVENT_TYPES: Record<string, NormalizedRuntimeEvent["type"] | undefined> =
  {
    "reasoning.appended": "progress.note",
    "message.appended": "assistant.delta",
    "message.completed": "assistant.message",
    "actions.requested": "tool.started",
    "action.result": "tool.completed",
    "authorization.required": "approval.requested",
    "authorization.completed": "approval.resolved",
    "input.requested": "run.waiting",
    "turn.failed": "run.failed",
  }

function actionName(data: Record<string, unknown>) {
  for (const key of ["toolName", "actionName", "name"]) {
    const value = data[key]
    if (typeof value === "string") return value
  }
  const action = data.action
  if (action && typeof action === "object") {
    for (const key of ["toolName", "name"]) {
      const value = Reflect.get(action, key)
      if (typeof value === "string") return value
    }
  }
  return null
}

export function normalizeEveEvent(
  value: unknown,
  fallbackId: string
): NormalizedRuntimeEvent | null {
  const event = eveEventSchema.parse(value)
  const baseType = EVENT_TYPES[event.type]
  const name = actionName(event.data ?? {})
  const codeAction = name === "execute_program" || name === "run_code"
  const type =
    codeAction && event.type === "actions.requested"
      ? "code.started"
      : codeAction && event.type === "action.result"
        ? "code.completed"
        : baseType
  if (!type) return null

  return {
    sourceEventId: event.id ?? fallbackId,
    source: "eve",
    type,
    payload: event.data ?? {},
  }
}

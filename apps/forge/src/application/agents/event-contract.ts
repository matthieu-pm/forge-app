import { z } from "zod"

export const AGENT_EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.routing-resolved",
  "run.usage",
  "progress.note",
  "assistant.delta",
  "assistant.message",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "code.started",
  "code.output",
  "code.completed",
  "file.search.started",
  "file.search.completed",
  "file.read",
  "file.patch.proposed",
  "file.patch.applied",
  "approval.requested",
  "approval.resolved",
  "artifact.created",
  "run.waiting",
  "run.cancelled",
  "run.failed",
  "run.completed",
] as const

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number]

export const AGENT_EVENT_SOURCES = ["eve", "codex", "claude", "forge"] as const

export type AgentEventSource = (typeof AGENT_EVENT_SOURCES)[number]

export const agentEventSchema = z
  .object({
    id: z.string().uuid(),
    sourceEventId: z.string().trim().min(1).max(255),
    threadId: z.string().uuid(),
    runId: z.string().uuid(),
    sequence: z.number().int().positive(),
    occurredAt: z.iso.datetime(),
    source: z.enum(AGENT_EVENT_SOURCES),
    type: z.enum(AGENT_EVENT_TYPES),
    schemaVersion: z.number().int().positive().default(1),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()

export type AgentEvent = z.infer<typeof agentEventSchema>

export const appendAgentEventInputSchema = agentEventSchema.omit({
  id: true,
  sequence: true,
})

export type AppendAgentEventInput = z.infer<typeof appendAgentEventInputSchema>

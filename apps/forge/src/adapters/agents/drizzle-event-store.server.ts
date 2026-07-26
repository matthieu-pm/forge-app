import "@tanstack/react-start/server-only"

import { and, asc, eq, gt, max } from "drizzle-orm"

import type {
  AgentEvent,
  AppendAgentEventInput,
} from "@/application/agents/event-contract"
import type { AgentEventStore } from "@/application/agents/event-store"
import { agentEventSchema } from "@/application/agents/event-contract"
import { assertSafeAgentEventPayload } from "@/application/agents/event-safety"
import { agentEvents, db } from "@/db"

function toEvent(event: typeof agentEvents.$inferSelect): AgentEvent {
  return agentEventSchema.parse({
    id: event.id,
    sourceEventId: event.sourceEventId,
    threadId: event.threadId,
    runId: event.runId,
    sequence: event.sequence,
    occurredAt: event.occurredAt.toISOString(),
    source: event.source,
    type: event.type,
    schemaVersion: event.schemaVersion,
    payload: event.payloadJson,
  })
}

async function findExisting(runId: string, sourceEventId: string) {
  const rows = await db
    .select()
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.runId, runId),
        eq(agentEvents.sourceEventId, sourceEventId)
      )
    )
    .limit(1)
  return rows.at(0)
}

export class DrizzleAgentEventStore implements AgentEventStore {
  async append(input: AppendAgentEventInput) {
    assertSafeAgentEventPayload(input.payload)
    const existing = await findExisting(input.runId, input.sourceEventId)
    if (existing) return toEvent(existing)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const aggregate = await db
        .select({ sequence: max(agentEvents.sequence) })
        .from(agentEvents)
        .where(eq(agentEvents.runId, input.runId))
      const sequence = (aggregate.at(0)?.sequence ?? 0) + 1
      const inserted = await db
        .insert(agentEvents)
        .values({
          threadId: input.threadId,
          runId: input.runId,
          sourceEventId: input.sourceEventId,
          sequence,
          occurredAt: new Date(input.occurredAt),
          source: input.source,
          type: input.type,
          schemaVersion: input.schemaVersion,
          payloadJson: input.payload,
        })
        .onConflictDoNothing()
        .returning()
      const event = inserted.at(0)
      if (event) return toEvent(event)

      const replayed = await findExisting(input.runId, input.sourceEventId)
      if (replayed) return toEvent(replayed)
    }

    throw new Error("The agent event could not be appended after retries.")
  }

  async listRunEvents(runId: string, afterSequence = 0) {
    const rows = await db
      .select()
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.runId, runId),
          gt(agentEvents.sequence, Math.max(0, afterSequence))
        )
      )
      .orderBy(asc(agentEvents.sequence))
    return rows.map(toEvent)
  }

  async listThreadEvents(threadId: string, afterSequence = 0) {
    const rows = await db
      .select()
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.threadId, threadId),
          gt(agentEvents.sequence, Math.max(0, afterSequence))
        )
      )
      .orderBy(asc(agentEvents.occurredAt), asc(agentEvents.sequence))
    return rows.map(toEvent)
  }
}

import { randomUUID } from "node:crypto"

import type {
  AgentEvent,
  AppendAgentEventInput,
} from "@/application/agents/event-contract"
import type { AgentEventStore } from "@/application/agents/event-store"
import { agentEventSchema } from "@/application/agents/event-contract"
import { assertSafeAgentEventPayload } from "@/application/agents/event-safety"

export class InMemoryAgentEventStore implements AgentEventStore {
  readonly events: Array<AgentEvent> = []

  async append(input: AppendAgentEventInput) {
    assertSafeAgentEventPayload(input.payload)
    const existing = this.events.find(
      (event) =>
        event.runId === input.runId &&
        event.sourceEventId === input.sourceEventId
    )
    if (existing) return existing

    const sequence =
      Math.max(
        0,
        ...this.events
          .filter((event) => event.runId === input.runId)
          .map((event) => event.sequence)
      ) + 1
    const event = agentEventSchema.parse({
      ...input,
      id: randomUUID(),
      sequence,
    })
    this.events.push(event)
    return event
  }

  async listRunEvents(runId: string, afterSequence = 0) {
    return this.events
      .filter(
        (event) =>
          event.runId === runId && event.sequence > Math.max(0, afterSequence)
      )
      .sort((left, right) => left.sequence - right.sequence)
  }

  async listThreadEvents(threadId: string, afterSequence = 0) {
    return this.events
      .filter(
        (event) =>
          event.threadId === threadId &&
          event.sequence > Math.max(0, afterSequence)
      )
      .sort((left, right) => {
        const time = Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
        return time === 0 ? left.sequence - right.sequence : time
      })
  }
}

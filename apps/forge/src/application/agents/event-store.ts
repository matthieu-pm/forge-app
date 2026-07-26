import type {
  AgentEvent,
  AppendAgentEventInput,
} from "@/application/agents/event-contract"

export interface AgentEventStore {
  append: (input: AppendAgentEventInput) => Promise<AgentEvent>
  listRunEvents: (
    runId: string,
    afterSequence?: number
  ) => Promise<Array<AgentEvent>>
  listThreadEvents: (
    threadId: string,
    afterSequence?: number
  ) => Promise<Array<AgentEvent>>
}

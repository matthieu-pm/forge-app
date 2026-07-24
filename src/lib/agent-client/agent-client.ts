import type { AgentThreadRecord } from "@/application/agents/agent-store"
import type {
  CreateAgentThreadInput,
  StartAgentTurnInput,
} from "@/application/agents/agent-contract"
import type { AgentEvent } from "@/application/agents/event-contract"
import type { ModelCatalogEntry } from "@/application/agents/model-contract"
import type { ApprovalDecision } from "@/application/agents/approval-contract"
import type {
  ThreadModelPreferenceInput,
  ThreadModelPreferenceRecord,
} from "@/application/agents/thread-model-preference"
import type { AgentFeatureFlags } from "@/application/agents/agent-feature-flags"
import type {
  AgentAttachmentRecord,
  CreateAgentAttachmentInput,
} from "@/application/agents/attachment-contract"

export interface AgentClient {
  uploadAttachment: (
    input: CreateAgentAttachmentInput
  ) => Promise<AgentAttachmentRecord>
  createThread: (input: CreateAgentThreadInput) => Promise<AgentThreadRecord>
  listThreads: () => Promise<Array<AgentThreadRecord>>
  mutateThread: (
    threadId: string,
    input:
      | { action: "archive" }
      | { action: "reopen" }
      | { action: "rename"; title: string }
  ) => Promise<AgentThreadRecord>
  streamTurn: (input: StartAgentTurnInput) => AsyncIterable<AgentEvent>
  replayThread: (threadId: string) => Promise<Array<AgentEvent>>
  replayRun: (
    runId: string,
    afterSequence?: number
  ) => Promise<Array<AgentEvent>>
  cancelRun: (runId: string) => Promise<AgentEvent>
  resolveApproval: (
    approvalId: string,
    decision: ApprovalDecision
  ) => AsyncIterable<AgentEvent>
  listModels: () => Promise<Array<ModelCatalogEntry>>
  getThreadModelPreference: (
    threadId: string
  ) => Promise<ThreadModelPreferenceRecord>
  setThreadModelPreference: (
    threadId: string,
    input: ThreadModelPreferenceInput
  ) => Promise<ThreadModelPreferenceRecord>
  getFeatureFlags: () => Promise<AgentFeatureFlags>
}

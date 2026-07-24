import type { AgentEventSource, AgentEventType } from "./event-contract"
import type { ModelReasoningEffort, ModelReference } from "./model-contract"

export type RuntimeAttachment = {
  id: string
  name: string
  contentType: string
  sizeBytes: number
  contentBase64: string
}

export type RuntimeIdentity = {
  workspaceId: string
  userId: string
  workspaceRole: string
}

export type RuntimeEvent = {
  sourceEventId: string
  source: AgentEventSource
  type: AgentEventType
  payload: Record<string, unknown>
  occurredAt?: string
}

export type StartRuntimeRunInput = {
  threadId: string
  runId: string
  identity: RuntimeIdentity
  message: string
  model: ModelReference
  reasoningEffort: ModelReasoningEffort
  attachments: ReadonlyArray<RuntimeAttachment>
  runtimeSessionId: string | null
  checkpointRuntimeSession: (runtimeSessionId: string) => Promise<void>
}

export type ResumeRuntimeRunInput = Omit<
  StartRuntimeRunInput,
  "message" | "attachments"
> & {
  inputResponses: ReadonlyArray<{
    requestId: string
    optionId: "approve" | "deny"
  }>
}

export type ReconnectRuntimeRunInput = Omit<
  ResumeRuntimeRunInput,
  "inputResponses"
>

export type CancelRuntimeRunContext = {
  identity: RuntimeIdentity
  model: ModelReference
  reasoningEffort: ModelReasoningEffort
}

export interface AgentRuntime {
  readonly kind: "eve" | "codex" | "claude"
  start: (input: StartRuntimeRunInput) => AsyncIterable<RuntimeEvent>
  resume?: (input: ResumeRuntimeRunInput) => AsyncIterable<RuntimeEvent>
  reconnect?: (input: ReconnectRuntimeRunInput) => AsyncIterable<RuntimeEvent>
  cancel: (
    runId: string,
    runtimeSessionId?: string | null,
    context?: CancelRuntimeRunContext
  ) => Promise<void>
}

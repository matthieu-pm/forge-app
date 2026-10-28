import type { ModelReasoningEffort } from "@/application/agents/model-contract"

export type AgentThreadRecord = {
  id: string
  workspaceId: string
  createdByUserId: string
  title: string
  status: "active" | "archived"
  runtimeKind: "eve" | "codex" | "claude"
  runtimeSessionId: string | null
  createdAt: Date
  updatedAt: Date
  lastActivityAt: Date
  lastRunState?: AgentRunRecord["state"] | null
}

export type AgentRunRecord = {
  id: string
  threadId: string
  initiatedByUserId: string
  state:
    | "created"
    | "connecting"
    | "running"
    | "waiting-for-approval"
    | "reconnecting"
    | "cancelled"
    | "failed"
    | "completed"
  executionKind: "forge-native" | "external-agent"
  requestedSelection: Record<string, unknown>
  resolvedConnectionId: string | null
  resolvedModelId: string | null
  reasoningEffort: ModelReasoningEffort | null
  routingPolicyVersion: string | null
  routingReason: string | null
  runtimeRunId: string | null
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  costMicros: number
  startedAt: Date | null
  completedAt: Date | null
  errorCode: string | null
  createdAt: Date
  updatedAt: Date
}

export type CreateThreadRecord = Omit<
  AgentThreadRecord,
  "createdAt" | "updatedAt" | "lastActivityAt" | "lastRunState"
> & {
  createdAt: Date
}

export type CreateRunRecord = Omit<AgentRunRecord, "createdAt" | "updatedAt">

export interface AgentStore {
  createThread: (input: CreateThreadRecord) => Promise<AgentThreadRecord>
  getThread: (
    workspaceId: string,
    threadId: string
  ) => Promise<AgentThreadRecord | null>
  listThreads: (
    workspaceId: string,
    userId: string
  ) => Promise<Array<AgentThreadRecord>>
  updateThread: (
    workspaceId: string,
    threadId: string,
    patch: Partial<
      Pick<
        AgentThreadRecord,
        | "title"
        | "status"
        | "runtimeKind"
        | "runtimeSessionId"
        | "lastActivityAt"
      >
    >
  ) => Promise<AgentThreadRecord | null>
  createRun: (input: CreateRunRecord) => Promise<AgentRunRecord>
  getRun: (workspaceId: string, runId: string) => Promise<AgentRunRecord | null>
  updateRun: (
    runId: string,
    patch: Partial<
      Pick<
        AgentRunRecord,
        | "state"
        | "runtimeRunId"
        | "startedAt"
        | "completedAt"
        | "errorCode"
        | "inputTokens"
        | "outputTokens"
        | "cachedInputTokens"
        | "costMicros"
      >
    >
  ) => Promise<AgentRunRecord | null>
  summarizeUsage: (
    workspaceId: string,
    userId: string | null,
    since: Date,
    until?: Date
  ) => Promise<{ costMicros: number; activeRuns: number }>
}

import type {
  AgentRunRecord,
  AgentStore,
  AgentThreadRecord,
  CreateRunRecord,
  CreateThreadRecord,
} from "@/application/agents/agent-store"

export class InMemoryAgentStore implements AgentStore {
  readonly threads = new Map<string, AgentThreadRecord>()
  readonly runs = new Map<string, AgentRunRecord>()

  async createThread(input: CreateThreadRecord) {
    const thread: AgentThreadRecord = {
      ...input,
      updatedAt: input.createdAt,
      lastActivityAt: input.createdAt,
      lastRunState: null,
    }
    this.threads.set(thread.id, thread)
    return thread
  }

  async getThread(workspaceId: string, threadId: string) {
    const thread = this.threads.get(threadId)
    return thread?.workspaceId === workspaceId ? thread : null
  }

  async listThreads(workspaceId: string, userId: string) {
    return [...this.threads.values()]
      .filter(
        (thread) =>
          thread.workspaceId === workspaceId &&
          thread.createdByUserId === userId
      )
      .map((thread) => {
        const latest = [...this.runs.values()]
          .filter((run) => run.threadId === thread.id)
          .sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime()
          )
          .at(0)
        return { ...thread, lastRunState: latest?.state ?? null }
      })
      .sort(
        (left, right) =>
          right.lastActivityAt.getTime() - left.lastActivityAt.getTime()
      )
  }

  async updateThread(
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
  ) {
    const thread = await this.getThread(workspaceId, threadId)
    if (!thread) return null

    const updated = { ...thread, ...patch, updatedAt: new Date() }
    this.threads.set(threadId, updated)
    return updated
  }

  async createRun(input: CreateRunRecord) {
    const run: AgentRunRecord = {
      ...input,
      createdAt: input.startedAt ?? new Date(),
      updatedAt: input.startedAt ?? new Date(),
    }
    this.runs.set(run.id, run)
    return run
  }

  async getRun(workspaceId: string, runId: string) {
    const run = this.runs.get(runId)
    if (!run) return null
    const thread = await this.getThread(workspaceId, run.threadId)
    return thread ? run : null
  }

  async updateRun(
    runId: string,
    patch: Partial<
      Pick<
        AgentRunRecord,
        "state" | "runtimeRunId" | "startedAt" | "completedAt" | "errorCode"
      >
    >
  ) {
    const run = this.runs.get(runId)
    if (!run) return null

    const updated = { ...run, ...patch, updatedAt: new Date() }
    this.runs.set(runId, updated)
    return updated
  }

  async summarizeUsage(
    workspaceId: string,
    userId: string | null,
    since: Date
  ) {
    const runs = [...this.runs.values()].filter((run) => {
      const thread = this.threads.get(run.threadId)
      return (
        thread?.workspaceId === workspaceId &&
        (!userId || run.initiatedByUserId === userId) &&
        run.createdAt >= since
      )
    })
    return {
      costMicros: runs.reduce((total, run) => total + run.costMicros, 0),
      activeRuns: runs.filter((run) =>
        [
          "created",
          "connecting",
          "running",
          "waiting-for-approval",
          "reconnecting",
        ].includes(run.state)
      ).length,
    }
  }

  async countActiveProviderRuns(workspaceId: string, provider: string) {
    return [...this.runs.values()].filter((run) => {
      const thread = this.threads.get(run.threadId)
      return (
        thread?.workspaceId === workspaceId &&
        run.requestedSelection.provider === provider &&
        [
          "created",
          "connecting",
          "running",
          "waiting-for-approval",
          "reconnecting",
        ].includes(run.state)
      )
    }).length
  }
}

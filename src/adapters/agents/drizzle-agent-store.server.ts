import "@tanstack/react-start/server-only"

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm"

import type {
  AgentRunRecord,
  AgentStore,
  AgentThreadRecord,
  CreateRunRecord,
  CreateThreadRecord,
} from "@/application/agents/agent-store"
import type { ModelReasoningEffort } from "@/application/agents/model-contract"
import { agentRuns, agentThreads, db } from "@/db"

function toThreadRecord(
  thread: typeof agentThreads.$inferSelect,
  lastRunState: AgentRunRecord["state"] | null = null
): AgentThreadRecord {
  return {
    ...thread,
    status: thread.status as AgentThreadRecord["status"],
    runtimeKind: thread.runtimeKind as AgentThreadRecord["runtimeKind"],
    lastRunState,
  }
}

function toRunRecord(run: typeof agentRuns.$inferSelect): AgentRunRecord {
  return {
    ...run,
    state: run.state as AgentRunRecord["state"],
    executionKind: run.executionKind as AgentRunRecord["executionKind"],
    reasoningEffort: run.reasoningEffort as ModelReasoningEffort | null,
  }
}

export class DrizzleAgentStore implements AgentStore {
  private async lastRunStates(threadIds: ReadonlyArray<string>) {
    if (threadIds.length === 0)
      return new Map<string, AgentRunRecord["state"]>()
    const runs = await db
      .select({
        threadId: agentRuns.threadId,
        state: agentRuns.state,
      })
      .from(agentRuns)
      .where(inArray(agentRuns.threadId, [...threadIds]))
      .orderBy(desc(agentRuns.createdAt))
    const states = new Map<string, AgentRunRecord["state"]>()
    for (const run of runs) {
      if (!states.has(run.threadId)) {
        states.set(run.threadId, run.state as AgentRunRecord["state"])
      }
    }
    return states
  }

  async createThread(input: CreateThreadRecord) {
    const rows = await db
      .insert(agentThreads)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        createdByUserId: input.createdByUserId,
        title: input.title,
        status: input.status,
        runtimeKind: input.runtimeKind,
        runtimeSessionId: input.runtimeSessionId,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        lastActivityAt: input.createdAt,
      })
      .returning()
    const thread = rows.at(0)
    if (!thread) throw new Error("The agent thread could not be created.")
    return toThreadRecord(thread)
  }

  async getThread(workspaceId: string, threadId: string) {
    const rows = await db
      .select()
      .from(agentThreads)
      .where(
        and(
          eq(agentThreads.workspaceId, workspaceId),
          eq(agentThreads.id, threadId)
        )
      )
      .limit(1)
    const thread = rows.at(0)
    if (!thread) return null
    const states = await this.lastRunStates([thread.id])
    return toThreadRecord(thread, states.get(thread.id) ?? null)
  }

  async listThreads(workspaceId: string, userId: string) {
    const rows = await db
      .select()
      .from(agentThreads)
      .where(
        and(
          eq(agentThreads.workspaceId, workspaceId),
          eq(agentThreads.createdByUserId, userId)
        )
      )
      .orderBy(desc(agentThreads.lastActivityAt))
    const states = await this.lastRunStates(rows.map((thread) => thread.id))
    return rows.map((thread) =>
      toThreadRecord(thread, states.get(thread.id) ?? null)
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
    const rows = await db
      .update(agentThreads)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(agentThreads.workspaceId, workspaceId),
          eq(agentThreads.id, threadId)
        )
      )
      .returning()
    const thread = rows.at(0)
    if (!thread) return null
    const states = await this.lastRunStates([thread.id])
    return toThreadRecord(thread, states.get(thread.id) ?? null)
  }

  async createRun(input: CreateRunRecord) {
    const rows = await db.insert(agentRuns).values(input).returning()
    const run = rows.at(0)
    if (!run) throw new Error("The agent run could not be created.")
    return toRunRecord(run)
  }

  async getRun(workspaceId: string, runId: string) {
    const rows = await db
      .select({ run: agentRuns })
      .from(agentRuns)
      .innerJoin(agentThreads, eq(agentRuns.threadId, agentThreads.id))
      .where(
        and(eq(agentThreads.workspaceId, workspaceId), eq(agentRuns.id, runId))
      )
      .limit(1)
    const run = rows.at(0)?.run
    return run ? toRunRecord(run) : null
  }

  async updateRun(
    runId: string,
    patch: Partial<
      Pick<
        AgentRunRecord,
        | "state"
        | "runtimeRunId"
        | "inputTokens"
        | "outputTokens"
        | "cachedInputTokens"
        | "costMicros"
        | "startedAt"
        | "completedAt"
        | "errorCode"
      >
    >
  ) {
    const rows = await db
      .update(agentRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agentRuns.id, runId))
      .returning()
    const run = rows.at(0)
    return run ? toRunRecord(run) : null
  }

  async summarizeUsage(
    workspaceId: string,
    userId: string | null,
    since: Date
  ) {
    const rows = await db
      .select({
        costMicros: sql<number>`coalesce(sum(${agentRuns.costMicros}), 0)::bigint`,
        activeRuns: sql<number>`count(*) filter (where ${agentRuns.state} in ('created', 'connecting', 'running', 'waiting-for-approval', 'reconnecting'))::int`,
      })
      .from(agentRuns)
      .innerJoin(agentThreads, eq(agentRuns.threadId, agentThreads.id))
      .where(
        and(
          eq(agentThreads.workspaceId, workspaceId),
          userId ? eq(agentRuns.initiatedByUserId, userId) : undefined,
          gte(agentRuns.createdAt, since)
        )
      )
    return {
      costMicros: Number(rows.at(0)?.costMicros ?? 0),
      activeRuns: Number(rows.at(0)?.activeRuns ?? 0),
    }
  }

  async countActiveProviderRuns(workspaceId: string, provider: string) {
    const rows = await db
      .select({
        activeRuns: sql<number>`count(*)::int`,
      })
      .from(agentRuns)
      .innerJoin(agentThreads, eq(agentRuns.threadId, agentThreads.id))
      .where(
        and(
          eq(agentThreads.workspaceId, workspaceId),
          sql`${agentRuns.requestedSelection}->>'provider' = ${provider}`,
          sql`${agentRuns.state} in ('created', 'connecting', 'running', 'waiting-for-approval', 'reconnecting')`
        )
      )
    return Number(rows.at(0)?.activeRuns ?? 0)
  }
}

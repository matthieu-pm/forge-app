import { describe, expect, it } from "vitest"
import { InMemoryAgentStore } from "./in-memory-agent-store"
import type { AgentRunRecord } from "@/application/agents/agent-store"

function run(
  id: string,
  at: string,
  cost: number,
  state: AgentRunRecord["state"] = "completed"
): AgentRunRecord {
  const date = new Date(at)
  return {
    id,
    threadId: "t",
    initiatedByUserId: "alice",
    state,
    executionKind: "forge-native",
    requestedSelection: {},
    resolvedConnectionId: null,
    resolvedModelId: null,
    reasoningEffort: null,
    routingPolicyVersion: null,
    routingReason: null,
    runtimeRunId: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costMicros: cost,
    startedAt: date,
    completedAt: null,
    errorCode: null,
    createdAt: date,
    updatedAt: date,
  }
}
async function fixture() {
  const store = new InMemoryAgentStore()
  await store.createThread({
    id: "t",
    workspaceId: "w",
    createdByUserId: "alice",
    title: "T",
    status: "active",
    runtimeKind: "eve",
    runtimeSessionId: null,
    createdAt: new Date("2026-01-01"),
  })
  for (const item of [
    run("old-active", "2026-01-14T23:59:59.999Z", 50, "running"),
    run("start", "2026-01-15T00:00:00Z", 100),
    run("inside", "2026-02-14T23:59:59.999Z", 200),
    run("end", "2026-02-15T00:00:00Z", 400),
  ])
    store.runs.set(item.id, item)
  return store
}
describe("period usage summaries", () => {
  it("sums only [start,end) while counting active runs across all periods", async () => {
    const store = await fixture()
    await expect(
      store.summarizeUsage(
        "w",
        null,
        new Date("2026-01-15"),
        new Date("2026-02-15")
      )
    ).resolves.toEqual({ costMicros: 300, activeRuns: 1 })
    await expect(
      store.summarizeUsage(
        "w",
        null,
        new Date("2026-02-15"),
        new Date("2026-03-15")
      )
    ).resolves.toEqual({ costMicros: 400, activeRuns: 1 })
  })
  it("filters both costs and concurrency by workspace and actor", async () => {
    const store = await fixture()
    await expect(
      store.summarizeUsage("w", "bob", new Date("2026-01-15"))
    ).resolves.toEqual({ costMicros: 0, activeRuns: 0 })
    await expect(
      store.summarizeUsage("other", null, new Date("2026-01-15"))
    ).resolves.toEqual({ costMicros: 0, activeRuns: 0 })
  })
  it("rejects invalid and reversed windows", async () => {
    const store = await fixture()
    await expect(
      store.summarizeUsage("w", null, new Date("bad"))
    ).rejects.toThrow()
    await expect(
      store.summarizeUsage(
        "w",
        null,
        new Date("2026-03-01"),
        new Date("2026-02-01")
      )
    ).rejects.toThrow()
  })
})

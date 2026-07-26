import { describe, expect, it } from "vitest"

import type { Actor } from "@/application/actor"
import {
  assertAgentProviderRunAllowed,
  assertAgentRunAllowed,
  resolveAgentControlPolicy,
} from "@/application/agents/agent-control-policy"

const actor: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  workspaceRole: "member",
  authentication: { kind: "session", sessionId: "session-1" },
  scopes: null,
}

describe("agent control policy", () => {
  it("allows several parallel runs per user by default", () => {
    const policy = resolveAgentControlPolicy({})

    expect(policy.userConcurrentRuns).toBe(10)
    expect(policy.userConcurrentRuns).toBeGreaterThan(1)
  })

  it("parses budgets, concurrency, and admin allowlists", () => {
    const policy = resolveAgentControlPolicy({
      FORGE_AGENT_USER_MONTHLY_BUDGET_MICROS: "5000000",
      FORGE_AGENT_USER_CONCURRENT_RUNS: "2",
      FORGE_AGENT_PROVIDER_CONCURRENT_RUNS: "4",
      FORGE_AGENT_RUN_WALL_CLOCK_MS: "120000",
      FORGE_AGENT_MAX_OUTPUT_TOKENS: "10000",
      FORGE_AGENT_ALLOWED_PROVIDERS: "openai, anthropic",
      FORGE_AGENT_ALLOWED_CAPABILITIES: "teams.list, workspace.describe",
    })

    expect(policy.userMonthlyBudgetMicros).toBe(5_000_000)
    expect(policy.userConcurrentRuns).toBe(2)
    expect(policy.providerConcurrentRuns).toBe(4)
    expect(policy.runWallClockMs).toBe(120_000)
    expect(policy.maxOutputTokens).toBe(10_000)
    expect(policy.allowedProviders).toEqual(new Set(["openai", "anthropic"]))
    expect(policy.allowedCapabilities).toEqual(
      new Set(["teams.list", "workspace.describe"])
    )
  })

  it("blocks a run when its user budget is exhausted", async () => {
    await expect(
      assertAgentRunAllowed(
        {
          summarizeUsage: (_workspaceId, userId) =>
            Promise.resolve({
              costMicros: userId ? 1_000 : 1_500,
              activeRuns: 0,
            }),
        },
        actor,
        {
          runWallClockMs: 900_000,
          maxInputTokens: 200_000,
          maxOutputTokens: 50_000,
          userMonthlyBudgetMicros: 1_000,
          workspaceMonthlyBudgetMicros: null,
          userConcurrentRuns: 3,
          workspaceConcurrentRuns: 20,
          providerConcurrentRuns: 10,
          allowedProviders: null,
          allowedCapabilities: null,
        },
        new Date("2026-07-24T00:00:00.000Z")
      )
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" })
  })

  it("blocks a run when concurrency is exhausted", async () => {
    await expect(
      assertAgentRunAllowed(
        {
          summarizeUsage: (_workspaceId, userId) =>
            Promise.resolve({
              costMicros: 0,
              activeRuns: userId ? 3 : 3,
            }),
        },
        actor,
        {
          runWallClockMs: 900_000,
          maxInputTokens: 200_000,
          maxOutputTokens: 50_000,
          userMonthlyBudgetMicros: null,
          workspaceMonthlyBudgetMicros: null,
          userConcurrentRuns: 3,
          workspaceConcurrentRuns: 20,
          providerConcurrentRuns: 10,
          allowedProviders: null,
          allowedCapabilities: null,
        },
        new Date("2026-07-24T00:00:00.000Z")
      )
    ).rejects.toMatchObject({ code: "CONCURRENCY_LIMIT" })
  })

  it("blocks a provider when its workspace concurrency is exhausted", async () => {
    await expect(
      assertAgentProviderRunAllowed(
        {
          countActiveProviderRuns: () => Promise.resolve(2),
        },
        actor,
        {
          runWallClockMs: 900_000,
          maxInputTokens: 200_000,
          maxOutputTokens: 50_000,
          userMonthlyBudgetMicros: null,
          workspaceMonthlyBudgetMicros: null,
          userConcurrentRuns: 3,
          workspaceConcurrentRuns: 20,
          providerConcurrentRuns: 2,
          allowedProviders: null,
          allowedCapabilities: null,
        },
        "openai"
      )
    ).rejects.toMatchObject({ code: "CONCURRENCY_LIMIT" })
  })
})

import { describe, expect, it } from "vitest"
import type { Actor } from "@/application/actor"
import {
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
  it("admits runs without user or workspace concurrency limits, including stale deployment settings", async () => {
    const policy = resolveAgentControlPolicy({
      FORGE_AGENT_USER_CONCURRENT_RUNS: "1",
      FORGE_AGENT_WORKSPACE_CONCURRENT_RUNS: "1",
      FORGE_AGENT_PROVIDER_CONCURRENT_RUNS: "1",
    })
    await expect(
      assertAgentRunAllowed(
        {
          summarizeUsage: () =>
            Promise.resolve({ costMicros: 0, activeRuns: 1_000_000 }),
        },
        actor,
        policy,
        new Date()
      )
    ).resolves.toBeUndefined()
  })
  it("parses budgets, execution bounds and admin allowlists", () => {
    const policy = resolveAgentControlPolicy({
      FORGE_AGENT_USER_MONTHLY_BUDGET_MICROS: "5000000",
      FORGE_AGENT_RUN_WALL_CLOCK_MS: "120000",
      FORGE_AGENT_MAX_OUTPUT_TOKENS: "10000",
      FORGE_AGENT_ALLOWED_PROVIDERS: "openai, anthropic",
      FORGE_AGENT_ALLOWED_CAPABILITIES: "teams.list, workspace.describe",
    })
    expect(policy.userMonthlyBudgetMicros).toBe(5_000_000)
    expect(policy.runWallClockMs).toBe(120_000)
    expect(policy.maxOutputTokens).toBe(10_000)
    expect(policy.allowedProviders).toEqual(new Set(["openai", "anthropic"]))
    expect(policy.allowedCapabilities).toEqual(
      new Set(["teams.list", "workspace.describe"])
    )
  })
  it("uses accepted bounds and prevents environment overrides from raising them", () => {
    expect(resolveAgentControlPolicy({})).toMatchObject({
      runWallClockMs: 900_000,
      maxInputTokens: 200_000,
      maxOutputTokens: 50_000,
    })
    for (const value of ["999999999", "0", "-1", "Infinity", "invalid"]) {
      expect(
        resolveAgentControlPolicy({
          FORGE_AGENT_RUN_WALL_CLOCK_MS: value,
          FORGE_AGENT_MAX_INPUT_TOKENS: value,
          FORGE_AGENT_MAX_OUTPUT_TOKENS: value,
        })
      ).toMatchObject({
        runWallClockMs: 900_000,
        maxInputTokens: 200_000,
        maxOutputTokens: 50_000,
      })
    }
  })
  it.each(["user", "workspace"])(
    "continues to reject exhausted %s spending budgets",
    async (scope) => {
      const policy = resolveAgentControlPolicy({
        [scope === "user"
          ? "FORGE_AGENT_USER_MONTHLY_BUDGET_MICROS"
          : "FORGE_AGENT_WORKSPACE_MONTHLY_BUDGET_MICROS"]: "1000",
      })
      await expect(
        assertAgentRunAllowed(
          {
            summarizeUsage: () =>
              Promise.resolve({ costMicros: 1000, activeRuns: 1_000_000 }),
          },
          actor,
          policy,
          new Date()
        )
      ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" })
    }
  )
})

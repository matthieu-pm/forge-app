import { agentExecutionPolicy } from "./agent-execution-policy"
import type { Actor } from "@/application/actor"
import type { AgentStore } from "@/application/agents/agent-store"

export type AgentControlPolicy = {
  runWallClockMs: number
  maxInputTokens: number
  maxOutputTokens: number
  userMonthlyBudgetMicros: number | null
  workspaceMonthlyBudgetMicros: number | null
  allowedProviders: ReadonlySet<string> | null
  allowedCapabilities: ReadonlySet<string> | null
}

function positiveInteger(value: string | undefined) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function allowlist(value: string | undefined) {
  if (!value?.trim()) return null
  const entries = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  return entries.length > 0 ? new Set(entries) : null
}

export function resolveAgentControlPolicy(
  environment: Record<string, string | undefined> = process.env
): AgentControlPolicy {
  return {
    runWallClockMs: Math.min(
      positiveInteger(environment.FORGE_AGENT_RUN_WALL_CLOCK_MS) ??
        agentExecutionPolicy.runWallClockMs,
      agentExecutionPolicy.runWallClockMs
    ),
    maxInputTokens: Math.min(
      positiveInteger(environment.FORGE_AGENT_MAX_INPUT_TOKENS) ??
        agentExecutionPolicy.maxInputTokens,
      agentExecutionPolicy.maxInputTokens
    ),
    maxOutputTokens: Math.min(
      positiveInteger(environment.FORGE_AGENT_MAX_OUTPUT_TOKENS) ??
        agentExecutionPolicy.maxOutputTokens,
      agentExecutionPolicy.maxOutputTokens
    ),
    userMonthlyBudgetMicros: positiveInteger(
      environment.FORGE_AGENT_USER_MONTHLY_BUDGET_MICROS
    ),
    workspaceMonthlyBudgetMicros: positiveInteger(
      environment.FORGE_AGENT_WORKSPACE_MONTHLY_BUDGET_MICROS
    ),
    allowedProviders: allowlist(environment.FORGE_AGENT_ALLOWED_PROVIDERS),
    allowedCapabilities: allowlist(
      environment.FORGE_AGENT_ALLOWED_CAPABILITIES
    ),
  }
}

export class AgentControlPolicyError extends Error {
  constructor(
    readonly code: "BUDGET_EXCEEDED",
    message: string
  ) {
    super(message)
    this.name = "AgentControlPolicyError"
  }
}

function monthStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

export async function assertAgentRunAllowed(
  store: Pick<AgentStore, "summarizeUsage">,
  actor: Actor,
  policy: AgentControlPolicy,
  now: Date
) {
  const since = monthStart(now)
  const [user, workspace] = await Promise.all([
    store.summarizeUsage(actor.workspaceId, actor.userId, since),
    store.summarizeUsage(actor.workspaceId, null, since),
  ])
  if (
    policy.userMonthlyBudgetMicros !== null &&
    user.costMicros >= policy.userMonthlyBudgetMicros
  ) {
    throw new AgentControlPolicyError(
      "BUDGET_EXCEEDED",
      "Your monthly Forge Agent budget has been reached."
    )
  }
  if (
    policy.workspaceMonthlyBudgetMicros !== null &&
    workspace.costMicros >= policy.workspaceMonthlyBudgetMicros
  ) {
    throw new AgentControlPolicyError(
      "BUDGET_EXCEEDED",
      "This workspace's monthly Forge Agent budget has been reached."
    )
  }
}

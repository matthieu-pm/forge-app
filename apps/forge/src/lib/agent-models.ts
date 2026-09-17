export const AGENT_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number]
export type AgentReasoningEffortSelection = AgentReasoningEffort | "auto"

export const DEFAULT_AGENT_REASONING_EFFORT: AgentReasoningEffort = "medium"
export const DEFAULT_AGENT_REASONING_EFFORT_SELECTION: AgentReasoningEffortSelection =
  "auto"

export type AgentModelDefinition = {
  id: string
  connectionId?: string
  executionKind?: "forge-native" | "external-agent"
  modelId?: string
  label: string
  provider: string
  providerLabel: string
  sourceLabel: string
  locality?: "local-only" | "server-capable"
  billingMode?:
    "forge-managed" | "subscription" | "token-plan" | "pay-as-you-go"
  priority: number
  reasoningEfforts: ReadonlyArray<AgentReasoningEffort>
  disabledReason?: string
}

export type AgentModelSelectionId = string | "auto"

export const AUTO_AGENT_MODEL_SELECTION = {
  id: "auto",
  label: "Auto",
  description: "Automatically chooses the best OpenAI model for the task.",
} as const

export function formatAgentModelLabel(displayName: string, modelId: string) {
  const normalizedDisplayName = displayName.trim()
  if (
    normalizedDisplayName &&
    normalizedDisplayName.toLocaleLowerCase() !==
      modelId.trim().toLocaleLowerCase()
  ) {
    return normalizedDisplayName
  }

  return modelId
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((part) => {
      if (part.toLocaleLowerCase() === "gpt") return "GPT"
      if (/^\d+(?:\.\d+)*$/.test(part)) return part
      return `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`
    })
    .join(" ")
}

export const AGENT_MODELS: Array<AgentModelDefinition> = [
  {
    id: "gpt-6-astra",
    modelId: "gpt-6-astra",
    label: "GPT 6 Astra",
    provider: "openai",
    providerLabel: "OpenAI",
    sourceLabel: "Forge",
    locality: "server-capable",
    billingMode: "forge-managed",
    priority: 400,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "gpt-5.6-sol",
    modelId: "gpt-5.6-sol",
    label: "GPT 5.6 Sol",
    provider: "openai",
    providerLabel: "OpenAI",
    sourceLabel: "Forge",
    locality: "server-capable",
    billingMode: "forge-managed",
    priority: 300,
    reasoningEfforts: AGENT_REASONING_EFFORTS,
  },
  {
    id: "gpt-5.6-terra",
    modelId: "gpt-5.6-terra",
    label: "GPT 5.6 Terra",
    provider: "openai",
    providerLabel: "OpenAI",
    sourceLabel: "Forge",
    locality: "server-capable",
    billingMode: "forge-managed",
    priority: 200,
    reasoningEfforts: AGENT_REASONING_EFFORTS,
  },
  {
    id: "gpt-5.6-luna",
    modelId: "gpt-5.6-luna",
    label: "GPT 5.6 Luna",
    provider: "openai",
    providerLabel: "OpenAI",
    sourceLabel: "Forge",
    locality: "server-capable",
    billingMode: "forge-managed",
    priority: 100,
    reasoningEfforts: AGENT_REASONING_EFFORTS,
  },
]

export function getAgentModels(
  models: ReadonlyArray<AgentModelDefinition> = AGENT_MODELS
) {
  return [...models].sort((left, right) => right.priority - left.priority)
}

export function getAgentReasoningEfforts(
  modelId: AgentModelSelectionId,
  models: ReadonlyArray<AgentModelDefinition> = AGENT_MODELS
): ReadonlyArray<AgentReasoningEffort> {
  if (modelId === AUTO_AGENT_MODEL_SELECTION.id) {
    const configuredEfforts = models
      .filter((model) => !model.disabledReason)
      .flatMap((model) => model.reasoningEfforts)

    return AGENT_REASONING_EFFORTS.filter((effort) =>
      configuredEfforts.includes(effort)
    )
  }

  const model = models.find((candidate) => candidate.id === modelId)
  return model && !model.disabledReason ? model.reasoningEfforts : []
}

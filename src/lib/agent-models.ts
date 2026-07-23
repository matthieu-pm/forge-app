export const AGENT_REASONING_EFFORTS = [
  "light",
  "medium",
  "high",
  "extra_high",
  "max",
] as const

export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number]
export type AgentReasoningEffortSelection = AgentReasoningEffort | "auto"

export const DEFAULT_AGENT_REASONING_EFFORT: AgentReasoningEffort = "medium"
export const DEFAULT_AGENT_REASONING_EFFORT_SELECTION: AgentReasoningEffortSelection =
  "auto"

export type AgentModelDefinition = {
  id: string
  label: string
  provider: string
  providerLabel: string
  sourceLabel: string
  priority: number
  reasoningEfforts: ReadonlyArray<AgentReasoningEffort>
}

export type AgentModelSelectionId = string | "auto"

export const AUTO_AGENT_MODEL_SELECTION = {
  id: "auto",
  label: "Auto",
  description: "Automatically chooses the best OpenAI model for the task.",
} as const

export const AGENT_MODELS: Array<AgentModelDefinition> = [
  {
    id: "gpt-5.6-sol",
    label: "GPT 5.6 Sol",
    provider: "openai",
    providerLabel: "OpenAI",
    sourceLabel: "Forge",
    priority: 300,
    reasoningEfforts: AGENT_REASONING_EFFORTS,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT 5.6 Terra",
    provider: "openai",
    providerLabel: "OpenAI",
    sourceLabel: "Forge",
    priority: 200,
    reasoningEfforts: AGENT_REASONING_EFFORTS,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT 5.6 Luna",
    provider: "openai",
    providerLabel: "OpenAI",
    sourceLabel: "Forge",
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
    const configuredEfforts = models.flatMap((model) => model.reasoningEfforts)

    return AGENT_REASONING_EFFORTS.filter((effort) =>
      configuredEfforts.includes(effort)
    )
  }

  return models.find((model) => model.id === modelId)?.reasoningEfforts ?? []
}

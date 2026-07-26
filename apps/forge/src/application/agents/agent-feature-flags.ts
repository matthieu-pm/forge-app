export const AGENT_FEATURE_NAMES = [
  "agent_ui",
  "agent_eve_runtime",
  "agent_code_mode",
  "agent_programmatic_tools",
  "agent_write_tools",
  "agent_skills",
  "agent_model_connections",
  "agent_auto_openai",
  "agent_codex_local",
  "agent_claude_local_beta",
  "agent_provider_openai",
  "agent_provider_anthropic",
  "agent_provider_google",
  "agent_provider_minimax",
  "agent_provider_mistral",
  "agent_provider_xai",
  "agent_provider_deepseek",
  "agent_provider_kimi",
  "agent_provider_custom_openai",
  "agent_provider_custom_anthropic",
] as const

export type AgentFeatureName = (typeof AGENT_FEATURE_NAMES)[number]
export type AgentFeatureFlags = Record<AgentFeatureName, boolean>

const ENV_NAMES: Record<AgentFeatureName, string> = {
  agent_ui: "FORGE_FEATURE_AGENT_UI",
  agent_eve_runtime: "FORGE_FEATURE_AGENT_EVE_RUNTIME",
  agent_code_mode: "FORGE_FEATURE_AGENT_CODE_MODE",
  agent_programmatic_tools: "FORGE_FEATURE_AGENT_PROGRAMMATIC_TOOLS",
  agent_write_tools: "FORGE_FEATURE_AGENT_WRITE_TOOLS",
  agent_skills: "FORGE_FEATURE_AGENT_SKILLS",
  agent_model_connections: "FORGE_FEATURE_AGENT_MODEL_CONNECTIONS",
  agent_auto_openai: "FORGE_FEATURE_AGENT_AUTO_OPENAI",
  agent_codex_local: "FORGE_FEATURE_AGENT_CODEX_LOCAL",
  agent_claude_local_beta: "FORGE_FEATURE_AGENT_CLAUDE_LOCAL_BETA",
  agent_provider_openai: "FORGE_FEATURE_AGENT_PROVIDER_OPENAI",
  agent_provider_anthropic: "FORGE_FEATURE_AGENT_PROVIDER_ANTHROPIC",
  agent_provider_google: "FORGE_FEATURE_AGENT_PROVIDER_GOOGLE",
  agent_provider_minimax: "FORGE_FEATURE_AGENT_PROVIDER_MINIMAX",
  agent_provider_mistral: "FORGE_FEATURE_AGENT_PROVIDER_MISTRAL",
  agent_provider_xai: "FORGE_FEATURE_AGENT_PROVIDER_XAI",
  agent_provider_deepseek: "FORGE_FEATURE_AGENT_PROVIDER_DEEPSEEK",
  agent_provider_kimi: "FORGE_FEATURE_AGENT_PROVIDER_KIMI",
  agent_provider_custom_openai:
    "FORGE_FEATURE_AGENT_PROVIDER_CUSTOM_OPENAI",
  agent_provider_custom_anthropic:
    "FORGE_FEATURE_AGENT_PROVIDER_CUSTOM_ANTHROPIC",
}

export const DEFAULT_AGENT_FEATURE_FLAGS: AgentFeatureFlags = {
  agent_ui: true,
  agent_eve_runtime: true,
  agent_code_mode: true,
  agent_programmatic_tools: true,
  agent_write_tools: true,
  agent_skills: false,
  agent_model_connections: true,
  agent_auto_openai: true,
  agent_codex_local: true,
  agent_claude_local_beta: false,
  agent_provider_openai: true,
  agent_provider_anthropic: true,
  agent_provider_google: true,
  agent_provider_minimax: true,
  agent_provider_mistral: true,
  agent_provider_xai: true,
  agent_provider_deepseek: true,
  agent_provider_kimi: true,
  agent_provider_custom_openai: true,
  agent_provider_custom_anthropic: true,
}

const PROVIDER_FEATURES = {
  openai: "agent_provider_openai",
  anthropic: "agent_provider_anthropic",
  google: "agent_provider_google",
  minimax: "agent_provider_minimax",
  mistral: "agent_provider_mistral",
  xai: "agent_provider_xai",
  deepseek: "agent_provider_deepseek",
  kimi: "agent_provider_kimi",
  "custom-openai": "agent_provider_custom_openai",
  "custom-anthropic": "agent_provider_custom_anthropic",
} as const satisfies Record<string, AgentFeatureName>

export function isAgentProviderEnabled(
  flags: AgentFeatureFlags,
  provider: string
) {
  if (!Object.hasOwn(PROVIDER_FEATURES, provider)) return false
  const feature = PROVIDER_FEATURES[provider as keyof typeof PROVIDER_FEATURES]
  return flags[feature]
}

function flagValue(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") return fallback
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase())
}

export function resolveAgentFeatureFlags(
  environment: Record<string, string | undefined> = process.env
): AgentFeatureFlags {
  return Object.fromEntries(
    AGENT_FEATURE_NAMES.map((name) => [
      name,
      flagValue(
        environment[ENV_NAMES[name]],
        DEFAULT_AGENT_FEATURE_FLAGS[name]
      ),
    ])
  ) as AgentFeatureFlags
}

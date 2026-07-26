import { describe, expect, it } from "vitest"

import { resolveAgentFeatureFlags } from "@/application/agents/agent-feature-flags"

describe("agent feature flags", () => {
  it("keeps shipped surfaces enabled and unreleased local runtimes disabled", () => {
    const flags = resolveAgentFeatureFlags({})
    expect(flags.agent_ui).toBe(true)
    expect(flags.agent_programmatic_tools).toBe(true)
    expect(flags.agent_skills).toBe(false)
    expect(flags.agent_claude_local_beta).toBe(false)
    expect(flags.agent_provider_openai).toBe(true)
  })

  it("accepts explicit rollout overrides", () => {
    const flags = resolveAgentFeatureFlags({
      FORGE_FEATURE_AGENT_WRITE_TOOLS: "false",
      FORGE_FEATURE_AGENT_SKILLS: "true",
      FORGE_FEATURE_AGENT_CLAUDE_LOCAL_BETA: "true",
      FORGE_FEATURE_AGENT_PROVIDER_ANTHROPIC: "off",
    })
    expect(flags.agent_write_tools).toBe(false)
    expect(flags.agent_skills).toBe(true)
    expect(flags.agent_claude_local_beta).toBe(true)
    expect(flags.agent_provider_anthropic).toBe(false)
  })
})

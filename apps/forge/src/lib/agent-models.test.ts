import { describe, expect, test } from "vitest"

import {
  AGENT_MODELS,
  AGENT_REASONING_EFFORTS,
  formatAgentModelLabel,
  getAgentModels,
  getAgentReasoningEfforts,
} from "@/lib/agent-models"

describe("agent models", () => {
  test("orders available models by descending priority", () => {
    expect(getAgentModels().map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ])
  })

  test("exposes GPT 6 Astra with its supported effort range", () => {
    expect(getAgentReasoningEfforts("gpt-6-astra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })

  test("exposes the configured effort range for Auto", () => {
    expect(getAgentReasoningEfforts("auto")).toEqual(AGENT_REASONING_EFFORTS)
  })

  test("returns no effort options for an unavailable model", () => {
    expect(getAgentReasoningEfforts("missing", AGENT_MODELS)).toEqual([])
  })

  test("formats raw OpenAI model identifiers for display", () => {
    expect(formatAgentModelLabel("gpt-5.6-sol", "gpt-5.6-sol")).toBe(
      "GPT 5.6 Sol"
    )
    expect(formatAgentModelLabel("Custom model name", "gpt-5.6-sol")).toBe(
      "Custom model name"
    )
  })
})

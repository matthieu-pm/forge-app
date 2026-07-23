import { describe, expect, test } from "vitest"

import {
  AGENT_MODELS,
  AGENT_REASONING_EFFORTS,
  getAgentModels,
  getAgentReasoningEfforts,
} from "@/lib/agent-models"

describe("agent models", () => {
  test("orders available models by descending priority", () => {
    expect(getAgentModels().map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ])
  })

  test("exposes the configured effort range for Auto", () => {
    expect(getAgentReasoningEfforts("auto")).toEqual(AGENT_REASONING_EFFORTS)
  })

  test("returns no effort options for an unavailable model", () => {
    expect(getAgentReasoningEfforts("missing", AGENT_MODELS)).toEqual([])
  })
})

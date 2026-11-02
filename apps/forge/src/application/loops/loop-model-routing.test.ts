import { describe, expect, it } from "vitest"
import { resolveLoopModel } from "./loop-model-routing"
import type { ModelCatalogEntry } from "@/application/agents/model-contract"
import {
  OPENAI_AUTO_POLICY_VERSION,
  resolveModel,
} from "@/application/agents/model-router"

const model: ModelCatalogEntry = {
  selectionId: "00000000-0000-4000-8000-000000000001:gpt-6-luna",
  connectionId: "00000000-0000-4000-8000-000000000001",
  executionKind: "forge-native",
  provider: "openai",
  modelId: "gpt-6-luna",
  displayName: "Cloud model",
  providerLabel: "OpenAI",
  sourceLabel: "Workspace API",
  locality: "server-capable",
  billingMode: "pay-as-you-go",
  inputModalities: ["text"],
  supportsTools: true,
  supportsCode: true,
  supportedReasoningEfforts: ["low", "medium", "high"],
  contextWindowTokens: null,
  status: "available",
}
const input = {
  mode: "auto" as const,
  message: "Summarize one event",
  availableModels: [model],
}
describe("shared Loop model routing", () => {
  it("uses the published reasoning while preserving Auto selection and audit; personal Auto stays unchanged", async () => {
    const personal = await resolveModel({ ...input, reasoningEffort: "high" })
    const loop = await resolveLoopModel({ ...input, reasoningEffort: "high" })
    expect(personal.reasoningEffort).toBe("low")
    expect(loop).toMatchObject({
      requestedSelection: "auto",
      model: personal.model,
      reasoningEffort: "high",
      route: { reasoningEffort: "high" },
      routingPolicyVersion: OPENAI_AUTO_POLICY_VERSION,
      routingReason: personal.routingReason,
    })
  })
  it("retains normal Auto effort when no explicit reasoning is published", async () => {
    expect(await resolveLoopModel(input)).toEqual(await resolveModel(input))
  })
  it("rejects an unsupported published effort instead of silently substituting Auto effort", async () => {
    await expect(
      resolveLoopModel({
        ...input,
        reasoningEffort: "high",
        availableModels: [{ ...model, supportedReasoningEfforts: ["low"] }],
      })
    ).rejects.toMatchObject({ code: "EFFORT_UNSUPPORTED" })
  })
  it.each([
    { ...model, provider: "anthropic" },
    { ...model, locality: "local-only" as const },
    { ...model, executionKind: "external-agent" as const },
    { ...model, supportsTools: false },
    { ...model, supportedReasoningEfforts: [] },
  ])(
    "rejects a catalogue without an executable workspace OpenAI Auto route",
    async (candidate) => {
      await expect(
        resolveLoopModel({ ...input, availableModels: [candidate] })
      ).rejects.toMatchObject({ code: "AUTO_UNAVAILABLE" })
    }
  )
})

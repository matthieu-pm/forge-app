import { describe, expect, it } from "vitest"

import type { ModelCatalogEntry } from "@/application/agents/model-contract"
import {
  OPENAI_AUTO_POLICY_VERSION,
  resolveModel,
} from "@/application/agents/model-router"

const CONNECTIONS = {
  openAI: "00000000-0000-4000-8000-000000000001",
  anthropic: "00000000-0000-4000-8000-000000000002",
} as const

function catalogModel(
  modelId: string,
  provider = "openai",
  connectionId: string = CONNECTIONS.openAI
): ModelCatalogEntry {
  return {
    selectionId: `${connectionId}:${modelId}`,
    connectionId,
    executionKind: "forge-native",
    provider,
    modelId,
    displayName: modelId,
    providerLabel: provider,
    sourceLabel: "Personal API key",
    locality: "server-capable",
    billingMode: "pay-as-you-go",
    inputModalities: ["text"],
    supportsTools: true,
    supportsCode: true,
    supportedReasoningEfforts: [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ],
    contextWindowTokens: 200_000,
    status: "available",
  }
}

const catalog = [
  catalogModel("gpt-5.6-luna"),
  catalogModel("gpt-5.6-terra"),
  catalogModel("gpt-5.6-sol"),
  catalogModel("claude-opus", "anthropic", CONNECTIONS.anthropic),
]

describe("model router", () => {
  it.each([
    ["Find the Forge team", "gpt-5.6-luna", "low"],
    [
      "Implement the team search and then format the results",
      "gpt-5.6-terra",
      "medium",
    ],
    ["Plan the complete production-ready architecture", "gpt-5.6-sol", "high"],
    ["Use maximum depth for this task", "gpt-5.6-sol", "xhigh"],
  ] as const)(
    "routes Auto from observable task signals",
    async (message, modelId, effort) => {
      await expect(
        resolveModel({ mode: "auto", message, availableModels: catalog })
      ).resolves.toMatchObject({
        requestedSelection: "auto",
        model: { provider: "openai", modelId },
        reasoningEffort: effort,
        routingPolicyVersion: OPENAI_AUTO_POLICY_VERSION,
        route: {
          runtimeKind: "eve",
          connectionLabel: "Personal API key",
          billingMode: "pay-as-you-go",
          locality: "server-capable",
          modelId,
          reasoningEffort: effort,
        },
      })
    }
  )

  it("never falls back from Auto to a non-OpenAI model", async () => {
    const result = resolveModel({
      mode: "auto",
      message: "Plan the complete architecture",
      availableModels: [
        catalogModel("claude-opus", "anthropic", CONNECTIONS.anthropic),
      ],
    })

    await expect(result).rejects.toMatchObject({
      code: "AUTO_UNAVAILABLE",
    })
  })

  it("escalates a failed strong attempt only within OpenAI", async () => {
    await expect(
      resolveModel({
        mode: "auto",
        message: "Try the task again",
        availableModels: catalog,
        priorStrongAttemptFailed: true,
      })
    ).resolves.toMatchObject({
      model: { provider: "openai", modelId: "gpt-5.6-sol" },
      reasoningEffort: "xhigh",
      routingReason: expect.stringContaining("prior-strong-attempt-failed"),
    })
  })

  it("routes real OpenAI catalog names when tier aliases are unavailable", async () => {
    const availableModels = [catalogModel("gpt-5-nano"), catalogModel("gpt-5")]

    await expect(
      resolveModel({
        mode: "auto",
        message: "Find the Forge team",
        availableModels,
      })
    ).resolves.toMatchObject({
      model: { modelId: "gpt-5-nano" },
      reasoningEffort: "low",
    })

    await expect(
      resolveModel({
        mode: "auto",
        message: "Plan the complete production-ready architecture",
        availableModels,
      })
    ).resolves.toMatchObject({
      model: { modelId: "gpt-5" },
      reasoningEffort: "high",
    })
  })

  it("uses a supported lower effort rather than failing Auto", async () => {
    const model: ModelCatalogEntry = {
      ...catalogModel("gpt-4.1"),
      supportedReasoningEfforts: ["none"],
    }
    await expect(
      resolveModel({
        mode: "auto",
        message: "Implement this change",
        availableModels: [model],
      })
    ).resolves.toMatchObject({
      model: { modelId: "gpt-4.1" },
      reasoningEffort: "none",
    })
  })

  it("keeps Auto on the user's preferred OpenAI billing source", async () => {
    const preferredConnection = "00000000-0000-4000-8000-000000000099"
    await expect(
      resolveModel({
        mode: "auto",
        message: "Summarize this",
        availableModels: [
          ...catalog,
          catalogModel("gpt-5.6-luna", "openai", preferredConnection),
        ],
        preferredOpenAIConnectionId: preferredConnection,
      })
    ).resolves.toMatchObject({
      model: { connectionId: preferredConnection },
      route: { connectionId: preferredConnection },
    })
  })

  it("pins the exact manual connection and model", async () => {
    const selected = catalog[0]

    await expect(
      resolveModel({
        mode: "manual",
        message: "Use this model",
        availableModels: catalog,
        manualModel: selected,
        reasoningEffort: "minimal",
      })
    ).resolves.toMatchObject({
      requestedSelection: selected.selectionId,
      model: {
        connectionId: CONNECTIONS.openAI,
        modelId: "gpt-5.6-luna",
      },
      reasoningEffort: "minimal",
      routingPolicyVersion: null,
      route: {
        runtimeKind: "eve",
        connectionLabel: "Personal API key",
        billingMode: "pay-as-you-go",
        locality: "server-capable",
      },
    })
  })
})

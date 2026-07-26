import "@tanstack/react-start/server-only"

import { Agent } from "undici"

import type { ModelProvider } from "@/application/agents/model-connection-contract"
import type { ModelReasoningEffort } from "@/application/agents/model-contract"
import {
  createPinnedEndpointLookup,
  resolveServerProviderEndpoint,
} from "@/application/agents/custom-endpoint-policy.server"

export type DiscoveredProviderModel = {
  modelId: string
  displayName: string
  inputModalities: Array<string>
  supportsTools: boolean
  supportsCode: boolean
  supportedReasoningEfforts: Array<ModelReasoningEffort>
  contextWindowTokens: number | null
}

type DiscoverInput = {
  provider: ModelProvider
  apiKey: string
  endpointUrl?: string
  modelIds?: Array<string>
}

type DiscoveryDependencies = {
  fetcher?: typeof fetch
  resolveEndpoint?: typeof resolveServerProviderEndpoint
}

const BUILT_IN_ENDPOINTS: Partial<Record<ModelProvider, string>> = {
  openai: "https://api.openai.com/v1/",
  anthropic: "https://api.anthropic.com/v1/",
  google: "https://generativelanguage.googleapis.com/v1beta/",
  minimax: "https://api.minimax.io/v1/",
  mistral: "https://api.mistral.ai/v1/",
  xai: "https://api.x.ai/v1/",
  deepseek: "https://api.deepseek.com/v1/",
  kimi: "https://api.moonshot.ai/v1/",
}

function headers(
  provider: ModelProvider,
  apiKey: string
): Record<string, string> {
  if (provider === "anthropic" || provider === "custom-anthropic") {
    return {
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
    }
  }
  if (provider === "google") {
    return { "x-goog-api-key": apiKey }
  }
  return { authorization: `Bearer ${apiKey}` }
}

function modelArray(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  const candidate = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  return candidate.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object"
  )
}

function normalizeId(model: Record<string, unknown>) {
  const value =
    typeof model.id === "string"
      ? model.id
      : typeof model.name === "string"
        ? model.name.replace(/^models\//, "")
        : undefined
  return value?.trim()
}

function looksLikeTextModel(modelId: string) {
  return !/(embedding|moderation|tts|speech|audio|image|whisper|transcri)/i.test(
    modelId
  )
}

function reasoningEfforts(provider: ModelProvider, modelId: string) {
  if (provider === "openai" || provider === "custom-openai") {
    return /^(o[134]|gpt-5|codex)/i.test(modelId)
      ? (["none", "low", "medium", "high", "xhigh"] as const)
      : (["none"] as const)
  }
  return ["none"] as const
}

function supportsAgentTools(provider: ModelProvider, modelId: string) {
  if (provider === "custom-openai" || provider === "custom-anthropic") {
    return true
  }
  const patterns: Partial<Record<ModelProvider, RegExp>> = {
    openai: /^(?:gpt-|o[134](?:-|$)|codex)/i,
    anthropic: /^claude-/i,
    google: /^gemini-/i,
    minimax: /^(?:minimax-|abab)/i,
    mistral: /^(?:mistral-|ministral-|codestral-|pixtral-)/i,
    xai: /^grok-/i,
    deepseek: /^deepseek-(?:chat|reasoner)/i,
    kimi: /^(?:kimi-|moonshot-)/i,
  }
  return patterns[provider]?.test(modelId) ?? false
}

async function readBoundedJson(response: Response) {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > 2_000_000) {
    throw new Error("The provider model catalog is too large.")
  }
  const text = await response.text()
  if (text.length > 2_000_000) {
    throw new Error("The provider model catalog is too large.")
  }
  if (!response.ok) {
    throw new Error(
      `The provider rejected the credential (${response.status}).`
    )
  }
  return JSON.parse(text) as unknown
}

export async function discoverApiProviderModels(
  input: DiscoverInput,
  dependencies: DiscoveryDependencies = {}
): Promise<Array<DiscoveredProviderModel>> {
  const fetcher = dependencies.fetcher ?? fetch
  const resolveEndpoint =
    dependencies.resolveEndpoint ?? resolveServerProviderEndpoint
  const manualIds = input.modelIds?.filter(looksLikeTextModel) ?? []
  const builtIn = BUILT_IN_ENDPOINTS[input.provider]
  const configuredEndpoint = builtIn
    ? null
    : await resolveEndpoint(input.endpointUrl ?? "")
  const endpoint = builtIn ? new URL(builtIn) : configuredEndpoint!.url
  const modelsUrl = new URL("models", endpoint)
  const dispatcher = configuredEndpoint
    ? new Agent({
        connect: {
          lookup: createPinnedEndpointLookup(configuredEndpoint.addresses),
          servername: endpoint.hostname,
        },
      })
    : null

  let discovered: Array<string>
  try {
    const request: RequestInit & { dispatcher?: Agent } = {
      method: "GET",
      headers: {
        accept: "application/json",
        ...headers(input.provider, input.apiKey),
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }
    if (dispatcher) request.dispatcher = dispatcher
    const response = await fetcher(modelsUrl, request)
    const payload = await readBoundedJson(response)
    discovered = modelArray(payload)
      .map(normalizeId)
      .filter((value): value is string => Boolean(value))
      .filter(looksLikeTextModel)
  } catch (error) {
    if (manualIds.length === 0) throw error
    discovered = []
  } finally {
    await dispatcher?.close()
  }

  return [...new Set([...discovered, ...manualIds])]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 250)
    .map((modelId) => ({
      modelId,
      displayName: modelId,
      inputModalities: ["text"],
      supportsTools: supportsAgentTools(input.provider, modelId),
      supportsCode: supportsAgentTools(input.provider, modelId),
      supportedReasoningEfforts: [...reasoningEfforts(input.provider, modelId)],
      contextWindowTokens: null,
    }))
}

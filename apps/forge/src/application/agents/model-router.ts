import type {
  ModelCatalogEntry,
  ModelReasoningEffort,
  ModelReference,
  ResolvedModel,
} from "@/application/agents/model-contract"

export const OPENAI_AUTO_POLICY_VERSION = "openai-auto-v1"

export type AutoDifficulty = "simple" | "standard" | "complex" | "exceptional"

export type RoutingSignal =
  | "bounded-read"
  | "formatting-or-extraction"
  | "multi-step"
  | "implementation"
  | "architecture"
  | "diagnosis"
  | "broad-scope"
  | "maximum-depth"
  | "prior-strong-attempt-failed"

export type RoutingInput = {
  mode: "auto" | "manual"
  message: string
  availableModels: ReadonlyArray<ModelCatalogEntry>
  manualModel?: ModelReference
  reasoningEffort?: ModelReasoningEffort
  preferredOpenAIConnectionId?: string
  priorStrongAttemptFailed?: boolean
}

export class ModelRoutingError extends Error {
  constructor(
    readonly code:
      | "AUTO_UNAVAILABLE"
      | "MODEL_UNAVAILABLE"
      | "MODEL_NOT_OPENAI"
      | "EFFORT_UNSUPPORTED",
    message: string
  ) {
    super(message)
    this.name = "ModelRoutingError"
  }
}

type AutoClassification = {
  difficulty: AutoDifficulty
  signals: Array<RoutingSignal>
}

const SIGNAL_PATTERNS: Array<{
  signal: RoutingSignal
  pattern: RegExp
}> = [
  {
    signal: "formatting-or-extraction",
    pattern: /\b(format|reformat|extract|summari[sz]e|list|translate)\b/i,
  },
  {
    signal: "bounded-read",
    pattern: /\b(find|get|show|look up|read|search)\b/i,
  },
  {
    signal: "multi-step",
    pattern: /\b(first|then|after that|multiple|several|across)\b/i,
  },
  {
    signal: "implementation",
    pattern: /\b(implement|build|code|refactor|migrate|integrate)\b/i,
  },
  {
    signal: "architecture",
    pattern: /\b(architecture|system design|design the system|trade-?offs?)\b/i,
  },
  {
    signal: "diagnosis",
    pattern:
      /\b(diagnos|debug|root cause|race condition|performance regression)\b/i,
  },
  {
    signal: "broad-scope",
    pattern: /\b(complete|entire|end-to-end|production-ready|full plan)\b/i,
  },
  {
    signal: "maximum-depth",
    pattern: /\b(max(?:imum)? depth|deepest|xhigh|extra high|do not stop)\b/i,
  },
]

const AUTO_ROUTE = {
  simple: { modelFragment: "luna", effort: "low" },
  standard: { modelFragment: "terra", effort: "medium" },
  complex: { modelFragment: "sol", effort: "high" },
  exceptional: { modelFragment: "sol", effort: "xhigh" },
} as const satisfies Record<
  AutoDifficulty,
  { modelFragment: string; effort: ModelReasoningEffort }
>

const FALLBACK_EFFORTS: Array<ModelReasoningEffort> = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
]

function modelStrength(modelId: string) {
  const normalized = modelId.toLowerCase()
  const version =
    normalized.match(/gpt-(\d+)(?:[.-](\d+))?/) ?? normalized.match(/^o(\d+)/)
  const major = Number(version?.[1] ?? 0)
  const minor = Number(version?.[2] ?? 0)
  let score = major * 100 + minor * 10
  if (normalized.startsWith("o")) score += 450
  if (normalized.includes("sol")) score += 1_000
  if (normalized.includes("terra")) score += 700
  if (normalized.includes("luna")) score += 400
  if (normalized.includes("mini")) score -= 120
  if (normalized.includes("nano")) score -= 220
  return score
}

function chooseAutoModel(
  models: ReadonlyArray<ModelCatalogEntry>,
  difficulty: AutoDifficulty,
  preferredFragment: string
) {
  const exact = models.find((model) =>
    model.modelId.toLowerCase().includes(preferredFragment)
  )
  if (exact) return exact

  const scored = [...models].sort((left, right) => {
    const leftSmall = /(mini|nano)/i.test(left.modelId)
    const rightSmall = /(mini|nano)/i.test(right.modelId)
    if (difficulty === "simple" && leftSmall !== rightSmall) {
      return leftSmall ? -1 : 1
    }
    if (
      (difficulty === "complex" || difficulty === "exceptional") &&
      leftSmall !== rightSmall
    ) {
      return leftSmall ? 1 : -1
    }
    return modelStrength(right.modelId) - modelStrength(left.modelId)
  })
  return scored.at(0)
}

function compatibleAutoEffort(
  model: ModelCatalogEntry,
  preferred: ModelReasoningEffort
) {
  if (model.supportedReasoningEfforts.includes(preferred)) return preferred
  const preferredIndex = FALLBACK_EFFORTS.indexOf(preferred)
  return (
    FALLBACK_EFFORTS.slice(preferredIndex).find((effort) =>
      model.supportedReasoningEfforts.includes(effort)
    ) ??
    FALLBACK_EFFORTS.find((effort) =>
      model.supportedReasoningEfforts.includes(effort)
    )
  )
}

function classifyAuto(input: RoutingInput): AutoClassification {
  const signals = SIGNAL_PATTERNS.filter(({ pattern }) =>
    pattern.test(input.message)
  ).map(({ signal }) => signal)

  if (input.priorStrongAttemptFailed) {
    signals.push("prior-strong-attempt-failed")
  }

  if (
    signals.includes("maximum-depth") ||
    signals.includes("prior-strong-attempt-failed")
  ) {
    return { difficulty: "exceptional", signals }
  }

  if (
    signals.includes("architecture") ||
    signals.includes("diagnosis") ||
    signals.includes("broad-scope")
  ) {
    return { difficulty: "complex", signals }
  }

  if (
    signals.includes("implementation") ||
    signals.includes("multi-step") ||
    input.message.length > 600
  ) {
    return { difficulty: "standard", signals }
  }

  return { difficulty: "simple", signals }
}

function availableEntry(
  models: ReadonlyArray<ModelCatalogEntry>,
  reference: ModelReference
) {
  return models.find(
    (candidate) =>
      candidate.status === "available" &&
      candidate.supportsTools &&
      candidate.connectionId === reference.connectionId &&
      candidate.modelId === reference.modelId &&
      candidate.executionKind === reference.executionKind
  )
}

function assertEffortSupported(
  model: ModelCatalogEntry,
  effort: ModelReasoningEffort
) {
  if (!model.supportedReasoningEfforts.includes(effort)) {
    throw new ModelRoutingError(
      "EFFORT_UNSUPPORTED",
      `${model.displayName} does not support ${effort} reasoning.`
    )
  }
}

function runtimeKind(model: ModelCatalogEntry) {
  if (model.executionKind === "forge-native") return "eve" as const
  if (model.selectionId.startsWith("local:codex:")) return "codex" as const
  return "claude" as const
}

function resolvedRoute(
  model: ModelCatalogEntry,
  reasoningEffort: ModelReasoningEffort
) {
  return {
    runtimeKind: runtimeKind(model),
    executionKind: model.executionKind,
    connectionId: model.connectionId,
    connectionLabel: model.sourceLabel,
    locality: model.locality,
    billingMode: model.billingMode,
    provider: model.provider,
    providerLabel: model.providerLabel,
    modelId: model.modelId,
    modelDisplayName: model.displayName,
    reasoningEffort,
  }
}

function resolveManual(input: RoutingInput): ResolvedModel {
  if (!input.manualModel) {
    throw new ModelRoutingError(
      "MODEL_UNAVAILABLE",
      "Manual routing requires a model."
    )
  }

  const model = availableEntry(input.availableModels, input.manualModel)
  if (!model) {
    throw new ModelRoutingError(
      "MODEL_UNAVAILABLE",
      "The selected model is no longer available through that connection."
    )
  }

  const effort = input.reasoningEffort ?? "medium"
  assertEffortSupported(model, effort)

  return {
    requestedSelection: model.selectionId,
    model: input.manualModel,
    reasoningEffort: effort,
    routingPolicyVersion: null,
    routingReason: null,
    route: resolvedRoute(model, effort),
  }
}

function resolveAuto(input: RoutingInput): ResolvedModel {
  const classification = classifyAuto(input)
  const route = AUTO_ROUTE[classification.difficulty]
  const openAIModels = input.availableModels.filter(
    (model) =>
      model.provider.toLowerCase() === "openai" &&
      model.status === "available" &&
      model.supportsTools &&
      (!input.preferredOpenAIConnectionId ||
        model.connectionId === input.preferredOpenAIConnectionId)
  )
  const chosen = chooseAutoModel(
    openAIModels,
    classification.difficulty,
    route.modelFragment
  )

  if (!chosen) {
    throw new ModelRoutingError(
      "AUTO_UNAVAILABLE",
      "Connect OpenAI or Codex with a compatible model to use Auto."
    )
  }

  const effort = compatibleAutoEffort(chosen, route.effort)
  if (!effort) {
    throw new ModelRoutingError(
      "AUTO_UNAVAILABLE",
      "The available OpenAI models do not support a compatible effort level."
    )
  }

  return {
    requestedSelection: "auto",
    model: {
      selectionId: chosen.selectionId,
      connectionId: chosen.connectionId,
      executionKind: chosen.executionKind,
      provider: chosen.provider,
      modelId: chosen.modelId,
    },
    reasoningEffort: effort,
    routingPolicyVersion: OPENAI_AUTO_POLICY_VERSION,
    routingReason: JSON.stringify({
      difficulty: classification.difficulty,
      signals: classification.signals,
    }),
    route: resolvedRoute(chosen, effort),
  }
}

export function resolveModel(input: RoutingInput): Promise<ResolvedModel> {
  return Promise.resolve().then(() =>
    input.mode === "manual" ? resolveManual(input) : resolveAuto(input)
  )
}

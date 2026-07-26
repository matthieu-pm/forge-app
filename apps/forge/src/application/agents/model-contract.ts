import { z } from "zod"

export const MODEL_EXECUTION_KINDS = ["forge-native", "external-agent"] as const

export const MODEL_CONNECTION_KINDS = [
  "managed",
  "api-key",
  "workload-identity",
  "local-agent",
] as const

export const MODEL_CONNECTION_LOCALITIES = [
  "local-only",
  "server-capable",
] as const

export const MODEL_BILLING_MODES = [
  "forge-managed",
  "subscription",
  "token-plan",
  "pay-as-you-go",
] as const

export const MODEL_CREDENTIAL_OWNERS = [
  "forge-local-vault",
  "forge-server-vault",
  "provider-process",
] as const

export const MODEL_CONNECTION_STATUSES = [
  "ready",
  "login-required",
  "expired",
  "repair-required",
  "unavailable",
  "policy-blocked",
] as const

export const MODEL_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number]

export const modelReferenceSchema = z
  .object({
    selectionId: z.string().trim().min(1).max(255),
    connectionId: z.string().uuid(),
    executionKind: z.enum(MODEL_EXECUTION_KINDS),
    provider: z.string().trim().min(1).max(100),
    modelId: z.string().trim().min(1).max(255),
  })
  .strict()

export type ModelReference = z.infer<typeof modelReferenceSchema>

export const modelCatalogEntrySchema = modelReferenceSchema
  .extend({
    displayName: z.string().trim().min(1).max(255),
    providerLabel: z.string().trim().min(1).max(100),
    sourceLabel: z.string().trim().min(1).max(100),
    locality: z.enum(MODEL_CONNECTION_LOCALITIES),
    billingMode: z.enum(MODEL_BILLING_MODES),
    inputModalities: z.array(z.string().trim().min(1).max(50)),
    supportsTools: z.boolean(),
    supportsCode: z.boolean(),
    supportedReasoningEfforts: z.array(z.enum(MODEL_REASONING_EFFORTS)),
    contextWindowTokens: z.number().int().positive().nullable(),
    status: z.enum(["available", "unavailable", "deprecated", "hidden"]),
  })
  .strict()

export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>

export const resolvedModelRouteSchema = z
  .object({
    runtimeKind: z.enum(["eve", "codex", "claude"]),
    executionKind: z.enum(MODEL_EXECUTION_KINDS),
    connectionId: z.string().uuid(),
    connectionLabel: z.string().trim().min(1).max(100),
    locality: z.enum(MODEL_CONNECTION_LOCALITIES),
    billingMode: z.enum(MODEL_BILLING_MODES),
    provider: z.string().trim().min(1).max(100),
    providerLabel: z.string().trim().min(1).max(100),
    modelId: z.string().trim().min(1).max(255),
    modelDisplayName: z.string().trim().min(1).max(255),
    reasoningEffort: z.enum(MODEL_REASONING_EFFORTS),
  })
  .strict()

export type ResolvedModelRoute = z.infer<typeof resolvedModelRouteSchema>

export const resolvedModelSchema = z
  .object({
    requestedSelection: z.string().trim().min(1).max(255),
    model: modelReferenceSchema,
    reasoningEffort: z.enum(MODEL_REASONING_EFFORTS),
    routingPolicyVersion: z.string().trim().min(1).max(100).nullable(),
    routingReason: z.string().trim().min(1).max(1000).nullable(),
    route: resolvedModelRouteSchema,
  })
  .strict()

export type ResolvedModel = z.infer<typeof resolvedModelSchema>

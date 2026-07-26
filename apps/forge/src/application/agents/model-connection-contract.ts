import { z } from "zod"

import {
  MODEL_BILLING_MODES,
  MODEL_CONNECTION_KINDS,
  MODEL_CONNECTION_LOCALITIES,
  MODEL_CONNECTION_STATUSES,
  MODEL_CREDENTIAL_OWNERS,
  MODEL_EXECUTION_KINDS,
} from "@/application/agents/model-contract"

export const MODEL_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "minimax",
  "mistral",
  "xai",
  "deepseek",
  "kimi",
  "custom-openai",
  "custom-anthropic",
] as const

export type ModelProvider = (typeof MODEL_PROVIDERS)[number]

export class ModelConnectionError extends Error {
  constructor(
    readonly code:
      | "CONNECTION_NOT_FOUND"
      | "DISCOVERY_FAILED"
      | "INVALID_ENDPOINT"
      | "VAULT_UNAVAILABLE"
      | "POLICY_BLOCKED",
    message: string
  ) {
    super(message)
    this.name = "ModelConnectionError"
  }
}

export const modelConnectionSummarySchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().min(1),
    userId: z.string().nullable(),
    scope: z.enum(["personal", "workspace"]),
    provider: z.enum(MODEL_PROVIDERS),
    kind: z.enum(MODEL_CONNECTION_KINDS),
    executionKind: z.enum(MODEL_EXECUTION_KINDS),
    locality: z.enum(MODEL_CONNECTION_LOCALITIES),
    billingMode: z.enum(MODEL_BILLING_MODES),
    credentialOwner: z.enum(MODEL_CREDENTIAL_OWNERS),
    displayName: z.string().min(1).max(100),
    maskedCredentialSuffix: z.string().nullable(),
    endpointUrl: z.string().nullable(),
    status: z.enum(MODEL_CONNECTION_STATUSES),
    statusReason: z.string().nullable(),
    discoveredAt: z.iso.datetime().nullable(),
    lastHealthCheckedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    modelCount: z.number().int().nonnegative(),
  })
  .strict()

export type ModelConnectionSummary = z.infer<
  typeof modelConnectionSummarySchema
>

export const createModelConnectionInputSchema = z
  .object({
    provider: z.enum(MODEL_PROVIDERS),
    scope: z.enum(["personal", "workspace"]).default("personal"),
    displayName: z.string().trim().min(1).max(100),
    apiKey: z.string().trim().min(8).max(10_000),
    endpointUrl: z.url().max(2048).optional(),
    modelIds: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const custom = value.provider.startsWith("custom-")
    if (custom && !value.endpointUrl) {
      context.addIssue({
        code: "custom",
        message: "A custom provider requires an endpoint URL.",
        path: ["endpointUrl"],
      })
    }
    if (!custom && value.endpointUrl) {
      context.addIssue({
        code: "custom",
        message: "Built-in providers use their official API endpoint.",
        path: ["endpointUrl"],
      })
    }
  })

export type CreateModelConnectionInput = z.infer<
  typeof createModelConnectionInputSchema
>

export const modelConnectionActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh") }).strict(),
  z.object({ action: z.literal("test") }).strict(),
])

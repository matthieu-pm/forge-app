import { z } from "zod"

import { API_SCOPES } from "@/application/actor"

export const FORGE_API_KEY_CONFIG_ID = "forge-api"
export const FORGE_API_KEY_PREFIX = "forge_"
export const DEFAULT_API_KEY_EXPIRES_IN_DAYS = 90
export const MAX_API_KEY_EXPIRES_IN_DAYS = 365

export const createApiKeyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(32),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(MAX_API_KEY_EXPIRES_IN_DAYS)
      .default(DEFAULT_API_KEY_EXPIRES_IN_DAYS),
    scopes: z.array(z.enum(API_SCOPES)).min(1),
  })
  .strict()

export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>

export const apiKeySummarySchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    start: z.string().nullable(),
    scopes: z.array(z.enum(API_SCOPES)),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    lastRequest: z.string().nullable(),
    enabled: z.boolean(),
  })
  .strict()

export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>

export const deleteApiKeyInputSchema = z
  .object({ keyId: z.string().min(1) })
  .strict()

export function scopesToPermissions(scopes: ReadonlyArray<string>) {
  const permissions: Record<string, Array<string>> = {}

  for (const scope of scopes) {
    const [resource, action] = scope.split(":")
    if (!resource || !action) continue
    permissions[resource] ??= []
    if (!permissions[resource].includes(action)) {
      permissions[resource].push(action)
    }
  }

  return permissions
}

export function permissionsToScopes(value: unknown) {
  if (!value || typeof value !== "object") return []

  const validScopes = new Set<string>(API_SCOPES)
  const scopes: Array<(typeof API_SCOPES)[number]> = []

  for (const [resource, actions] of Object.entries(value)) {
    if (!Array.isArray(actions)) continue
    for (const action of actions) {
      const scope = `${resource}:${String(action)}`
      if (validScopes.has(scope)) {
        scopes.push(scope as (typeof API_SCOPES)[number])
      }
    }
  }

  return scopes
}

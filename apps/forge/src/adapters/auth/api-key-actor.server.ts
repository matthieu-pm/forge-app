import "@tanstack/react-start/server-only"

import { and, eq } from "drizzle-orm"

import type { Actor } from "@/application/actor"
import {
  FORGE_API_KEY_CONFIG_ID,
  permissionsToScopes,
} from "@/application/api-keys/api-key-contract"
import { db, members } from "@/db"
import { auth } from "@/lib/auth"

export class ApiCredentialError extends Error {
  constructor(
    readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "RATE_LIMITED",
    message: string
  ) {
    super(message)
    this.name = "ApiCredentialError"
  }
}

export function readBearerCredential(headers: Headers) {
  const authorization = headers.get("authorization")
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i)
  return match?.[1] ?? null
}

export async function requireApiKeyActor(headers: Headers): Promise<Actor> {
  const credential = readBearerCredential(headers)

  if (!credential) {
    throw new ApiCredentialError(
      "UNAUTHORIZED",
      "Provide a Forge API key as a Bearer credential."
    )
  }

  const result = await auth.api.verifyApiKey({
    body: { configId: FORGE_API_KEY_CONFIG_ID, key: credential },
  })

  if (!result.valid || !result.key) {
    if (result.error?.code === "RATE_LIMIT_EXCEEDED") {
      throw new ApiCredentialError(
        "RATE_LIMITED",
        "The API key rate limit has been exceeded."
      )
    }

    throw new ApiCredentialError("UNAUTHORIZED", "The API key is invalid.")
  }

  const workspaceId =
    result.key.metadata && typeof result.key.metadata.workspaceId === "string"
      ? result.key.metadata.workspaceId
      : null

  if (!workspaceId) {
    throw new ApiCredentialError(
      "UNAUTHORIZED",
      "The API key is not attached to a workspace."
    )
  }

  const membership = await db
    .select({ role: members.role })
    .from(members)
    .where(
      and(
        eq(members.organizationId, workspaceId),
        eq(members.userId, result.key.referenceId)
      )
    )
    .limit(1)
  const role = membership.at(0)?.role

  if (!role) {
    throw new ApiCredentialError(
      "FORBIDDEN",
      "The API key owner no longer belongs to this workspace."
    )
  }

  return {
    userId: result.key.referenceId,
    workspaceId,
    workspaceRole: role,
    authentication: { kind: "apiKey", credentialId: result.key.id },
    scopes: permissionsToScopes(result.key.permissions),
  }
}

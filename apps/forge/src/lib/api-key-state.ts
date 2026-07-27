import { createServerFn } from "@tanstack/react-start"

import {
  FORGE_API_KEY_CONFIG_ID,
  apiKeySummarySchema,
  createApiKeyInputSchema,
  deleteApiKeyInputSchema,
  permissionsToScopes,
  scopesToPermissions,
} from "@/application/api-keys/api-key-contract"

function workspaceIdFromMetadata(metadata: unknown) {
  return metadata &&
    typeof metadata === "object" &&
    "workspaceId" in metadata &&
    typeof metadata.workspaceId === "string"
    ? metadata.workspaceId
    : null
}

export const createWorkspaceApiKey = createServerFn({ method: "POST" })
  .inputValidator(createApiKeyInputSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { requireSessionActor }, { auth }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/adapters/auth/session-actor.server"),
        import("@/lib/auth"),
      ])
    const actor = await requireSessionActor(getRequest())
    const { assertWorkspaceActionAllowed } =
      await import("@/application/workspace-security/workspace-security.server")
    await assertWorkspaceActionAllowed(actor, "api-keys.create")
    const created = await auth.api.createApiKey({
      body: {
        configId: FORGE_API_KEY_CONFIG_ID,
        name: data.name,
        expiresIn: data.expiresInDays * 24 * 60 * 60,
        userId: actor.userId,
        metadata: { workspaceId: actor.workspaceId },
        permissions: scopesToPermissions(data.scopes),
      },
    })

    return {
      key: created.key,
      summary: apiKeySummarySchema.parse({
        id: created.id,
        name: created.name,
        start: created.start,
        scopes: permissionsToScopes(created.permissions),
        createdAt: created.createdAt.toISOString(),
        expiresAt: created.expiresAt?.toISOString() ?? null,
        lastRequest: created.lastRequest?.toISOString() ?? null,
        enabled: created.enabled,
      }),
    }
  })

export const listWorkspaceApiKeys = createServerFn({ method: "GET" }).handler(
  async () => {
    const [{ getRequest }, { requireSessionActor }, { auth }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/adapters/auth/session-actor.server"),
        import("@/lib/auth"),
      ])
    const request = getRequest()
    const actor = await requireSessionActor(request)
    const result = await auth.api.listApiKeys({
      headers: request.headers,
      query: { configId: FORGE_API_KEY_CONFIG_ID, limit: 100 },
    })

    return result.apiKeys
      .filter(
        (key) => workspaceIdFromMetadata(key.metadata) === actor.workspaceId
      )
      .map((key) =>
        apiKeySummarySchema.parse({
          id: key.id,
          name: key.name,
          start: key.start,
          scopes: permissionsToScopes(key.permissions),
          createdAt: key.createdAt.toISOString(),
          expiresAt: key.expiresAt?.toISOString() ?? null,
          lastRequest: key.lastRequest?.toISOString() ?? null,
          enabled: key.enabled,
        })
      )
  }
)

export const loadWorkspaceApiKeyPolicy = createServerFn({
  method: "GET",
}).handler(async () => {
  const [
    { getRequest },
    { requireSessionActor },
    { getWorkspaceApiKeyPolicy },
  ] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("@/adapters/auth/session-actor.server"),
    import("@/application/workspace-security/workspace-security.server"),
  ])
  return getWorkspaceApiKeyPolicy(await requireSessionActor(getRequest()))
})

export const revokeWorkspaceApiKey = createServerFn({ method: "POST" })
  .inputValidator(deleteApiKeyInputSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { requireSessionActor }, { auth }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/adapters/auth/session-actor.server"),
        import("@/lib/auth"),
      ])
    const request = getRequest()
    const actor = await requireSessionActor(request)
    const key = await auth.api.getApiKey({
      headers: request.headers,
      query: { configId: FORGE_API_KEY_CONFIG_ID, id: data.keyId },
    })

    if (workspaceIdFromMetadata(key.metadata) !== actor.workspaceId) {
      return { ok: false as const, code: "NOT_FOUND" as const }
    }

    await auth.api.deleteApiKey({
      headers: request.headers,
      body: { configId: FORGE_API_KEY_CONFIG_ID, keyId: data.keyId },
    })

    return { ok: true as const }
  })

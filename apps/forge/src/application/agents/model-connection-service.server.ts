import "@tanstack/react-start/server-only"

import { randomUUID } from "node:crypto"
import { and, desc, eq, or, sql } from "drizzle-orm"

import type { Actor } from "@/application/actor"
import type {
  CreateModelConnectionInput,
  ModelConnectionSummary,
  ModelProvider,
} from "@/application/agents/model-connection-contract"
import type { ModelSecretVault } from "@/application/agents/model-secret-vault.server"
import {
  requireAgentRun,
  requireModelConnectionRead,
  requirePersonalModelConnectionWrite,
  requireWorkspaceModelConnectionWrite,
} from "@/application/agents/agent-authorization"
import { validateServerProviderEndpoint } from "@/application/agents/custom-endpoint-policy.server"
import {
  ModelConnectionError,
  modelConnectionSummarySchema,
} from "@/application/agents/model-connection-contract"
import { EnvelopeModelSecretVault } from "@/application/agents/model-secret-vault.server"
import { discoverApiProviderModels } from "@/adapters/agents/provider-catalogs/api-provider-catalog.server"
import { db, modelCatalogEntries, modelConnections } from "@/db"

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  minimax: "MiniMax",
  mistral: "Mistral",
  xai: "xAI",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  "custom-openai": "OpenAI compatible",
  "custom-anthropic": "Anthropic compatible",
}

function requireConnectionWrite(actor: Actor, scope: "personal" | "workspace") {
  if (scope === "workspace") {
    requireWorkspaceModelConnectionWrite(actor)
  } else {
    requirePersonalModelConnectionWrite(actor)
  }
}

function secretContext(actor: Actor, connectionId: string) {
  return `${actor.workspaceId}:${connectionId}`
}

function accessibleConnectionWhere(actor: Actor, connectionId?: string) {
  return and(
    eq(modelConnections.workspaceId, actor.workspaceId),
    connectionId ? eq(modelConnections.id, connectionId) : undefined,
    or(
      eq(modelConnections.scope, "workspace"),
      and(
        eq(modelConnections.scope, "personal"),
        eq(modelConnections.userId, actor.userId)
      )
    )
  )
}

async function getAccessibleConnection(actor: Actor, connectionId: string) {
  const rows = await db
    .select()
    .from(modelConnections)
    .where(accessibleConnectionWhere(actor, connectionId))
    .limit(1)
  const connection = rows.at(0)
  if (!connection) {
    throw new ModelConnectionError(
      "CONNECTION_NOT_FOUND",
      "The model connection was not found."
    )
  }
  return connection
}

function toSummary(
  connection: typeof modelConnections.$inferSelect,
  modelCount: number
): ModelConnectionSummary {
  return modelConnectionSummarySchema.parse({
    id: connection.id,
    workspaceId: connection.workspaceId,
    userId: connection.userId,
    scope: connection.scope,
    provider: connection.provider,
    kind: connection.kind,
    executionKind: connection.executionKind,
    locality: connection.locality,
    billingMode: connection.billingMode,
    credentialOwner: connection.credentialOwner,
    displayName: connection.displayName,
    maskedCredentialSuffix: connection.maskedCredentialSuffix,
    endpointUrl: connection.endpointUrl,
    status: connection.status,
    statusReason: connection.statusReason,
    discoveredAt: connection.discoveredAt?.toISOString() ?? null,
    lastHealthCheckedAt: connection.lastHealthCheckedAt?.toISOString() ?? null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
    modelCount,
  })
}

export class ModelConnectionService {
  constructor(
    private readonly vault: ModelSecretVault = new EnvelopeModelSecretVault(),
    private readonly allowedProviders: ReadonlySet<string> | null = null
  ) {}

  private requireProviderAllowed(provider: string) {
    if (this.allowedProviders && !this.allowedProviders.has(provider)) {
      throw new ModelConnectionError(
        "POLICY_BLOCKED",
        "This model provider is disabled by workspace policy."
      )
    }
  }

  async list(actor: Actor) {
    requireModelConnectionRead(actor)
    const rows = await db
      .select({
        connection: modelConnections,
        modelCount: sql<number>`count(${modelCatalogEntries.id})::int`,
      })
      .from(modelConnections)
      .leftJoin(
        modelCatalogEntries,
        eq(modelCatalogEntries.connectionId, modelConnections.id)
      )
      .where(accessibleConnectionWhere(actor))
      .groupBy(modelConnections.id)
      .orderBy(desc(modelConnections.updatedAt))
    return rows.map(({ connection, modelCount }) => {
      const summary = toSummary(connection, modelCount)
      return this.allowedProviders &&
        !this.allowedProviders.has(connection.provider)
        ? {
            ...summary,
            status: "policy-blocked" as const,
            statusReason:
              "This model provider is disabled by deployment policy.",
          }
        : summary
    })
  }

  async create(actor: Actor, input: CreateModelConnectionInput) {
    requireConnectionWrite(actor, input.scope)
    this.requireProviderAllowed(input.provider)
    const connectionId = randomUUID()
    let endpointUrl: string | null = null
    if (input.endpointUrl) {
      try {
        endpointUrl = (
          await validateServerProviderEndpoint(input.endpointUrl)
        ).toString()
      } catch {
        throw new ModelConnectionError(
          "INVALID_ENDPOINT",
          "The custom endpoint must use HTTPS and resolve only to public addresses."
        )
      }
    }

    let models
    try {
      models = await discoverApiProviderModels({
        provider: input.provider,
        apiKey: input.apiKey,
        endpointUrl: endpointUrl ?? undefined,
        modelIds: input.modelIds,
      })
    } catch {
      throw new ModelConnectionError(
        "DISCOVERY_FAILED",
        "Forge could not authenticate with this provider or discover its models."
      )
    }
    if (models.length === 0) {
      throw new ModelConnectionError(
        "DISCOVERY_FAILED",
        "The provider did not return any compatible text models."
      )
    }

    let secretReference: string
    try {
      secretReference = await this.vault.seal(
        input.apiKey,
        secretContext(actor, connectionId)
      )
    } catch {
      throw new ModelConnectionError(
        "VAULT_UNAVAILABLE",
        "The credential vault is unavailable."
      )
    }

    const now = new Date()
    const inserted = await db
      .insert(modelConnections)
      .values({
        id: connectionId,
        workspaceId: actor.workspaceId,
        userId: input.scope === "personal" ? actor.userId : null,
        scope: input.scope,
        provider: input.provider,
        kind: "api-key",
        executionKind: "forge-native",
        locality: "server-capable",
        billingMode: "pay-as-you-go",
        credentialOwner: "forge-server-vault",
        displayName: input.displayName,
        maskedCredentialSuffix: input.apiKey.slice(-4),
        secretReference,
        endpointUrl,
        status: "ready",
        discoveredAt: now,
        lastHealthCheckedAt: now,
        createdByUserId: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    const connection = inserted.at(0)

    if (!connection) {
      throw new Error("The model connection could not be created.")
    }
    try {
      await db.insert(modelCatalogEntries).values(
        models.map((model) => ({
          connectionId,
          selectionId: `${connectionId}:${model.modelId}`,
          providerModelId: model.modelId,
          displayName: model.displayName,
          providerLabel: PROVIDER_LABELS[input.provider],
          sourceLabel:
            input.scope === "personal" ? "Personal API" : "Workspace API",
          executionKind: "forge-native",
          inputModalities: model.inputModalities,
          supportsTools: model.supportsTools,
          supportsCode: model.supportsCode,
          supportedReasoningEfforts: model.supportedReasoningEfforts,
          contextWindowTokens: model.contextWindowTokens,
          status: "available",
          discoveredAt: now,
          createdAt: now,
          updatedAt: now,
        }))
      )
    } catch (error) {
      await db
        .delete(modelConnections)
        .where(eq(modelConnections.id, connectionId))
      throw error
    }
    return toSummary(connection, models.length)
  }

  async refresh(actor: Actor, connectionId: string) {
    const connection = await getAccessibleConnection(actor, connectionId)
    requireConnectionWrite(
      actor,
      connection.scope === "workspace" ? "workspace" : "personal"
    )
    return this.refreshResolved(actor, connection)
  }

  async refreshForRouting(actor: Actor, connectionId?: string) {
    requireAgentRun(actor)
    const connections = connectionId
      ? [await getAccessibleConnection(actor, connectionId)]
      : await db
          .select()
          .from(modelConnections)
          .where(accessibleConnectionWhere(actor))
    await Promise.allSettled(
      connections
        .filter(
          (connection) =>
            !this.allowedProviders ||
            this.allowedProviders.has(connection.provider)
        )
        .map((connection) => this.refreshResolved(actor, connection))
    )
  }

  private async refreshResolved(
    actor: Actor,
    connection: typeof modelConnections.$inferSelect
  ) {
    this.requireProviderAllowed(connection.provider)
    if (!connection.secretReference) {
      throw new ModelConnectionError(
        "VAULT_UNAVAILABLE",
        "This connection has no server credential."
      )
    }
    let apiKey: string
    try {
      apiKey = await this.vault.open(
        connection.secretReference,
        secretContext(actor, connection.id)
      )
    } catch {
      throw new ModelConnectionError(
        "VAULT_UNAVAILABLE",
        "The credential vault could not open this connection."
      )
    }

    try {
      const models = await discoverApiProviderModels({
        provider: connection.provider as ModelProvider,
        apiKey,
        endpointUrl: connection.endpointUrl ?? undefined,
      })
      const now = new Date()
      await db
        .delete(modelCatalogEntries)
        .where(eq(modelCatalogEntries.connectionId, connection.id))
      if (models.length > 0) {
        await db.insert(modelCatalogEntries).values(
          models.map((model) => ({
            connectionId: connection.id,
            selectionId: `${connection.id}:${model.modelId}`,
            providerModelId: model.modelId,
            displayName: model.displayName,
            providerLabel:
              PROVIDER_LABELS[connection.provider as ModelProvider],
            sourceLabel:
              connection.scope === "personal"
                ? "Personal API"
                : "Workspace API",
            executionKind: "forge-native",
            inputModalities: model.inputModalities,
            supportsTools: model.supportsTools,
            supportsCode: model.supportsCode,
            supportedReasoningEfforts: model.supportedReasoningEfforts,
            contextWindowTokens: model.contextWindowTokens,
            status: "available",
            discoveredAt: now,
            createdAt: now,
            updatedAt: now,
          }))
        )
      }
      const updatedRows = await db
        .update(modelConnections)
        .set({
          status: models.length > 0 ? "ready" : "repair-required",
          statusReason:
            models.length > 0 ? null : "No compatible models were returned.",
          discoveredAt: now,
          lastHealthCheckedAt: now,
          updatedAt: now,
        })
        .where(eq(modelConnections.id, connection.id))
        .returning()
      const updated = updatedRows.at(0)
      if (!updated) throw new Error("The connection disappeared.")
      return toSummary(updated, models.length)
    } catch {
      const now = new Date()
      await db
        .update(modelConnections)
        .set({
          status: "repair-required",
          statusReason: "Authentication or model discovery failed.",
          lastHealthCheckedAt: now,
          updatedAt: now,
        })
        .where(eq(modelConnections.id, connection.id))
      throw new ModelConnectionError(
        "DISCOVERY_FAILED",
        "Forge could not authenticate with this provider or refresh its models."
      )
    }
  }

  async delete(actor: Actor, connectionId: string) {
    const connection = await getAccessibleConnection(actor, connectionId)
    requireConnectionWrite(
      actor,
      connection.scope === "workspace" ? "workspace" : "personal"
    )
    await db
      .delete(modelConnections)
      .where(eq(modelConnections.id, connection.id))
    return { ok: true as const }
  }
}

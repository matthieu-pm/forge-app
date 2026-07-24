import "@tanstack/react-start/server-only"

import { and, eq, gt, isNull, or } from "drizzle-orm"

import type { Actor } from "@/application/actor"
import type { ModelCatalogEntry } from "@/application/agents/model-contract"
import {
  requireAgentRun,
  requireModelConnectionRead,
} from "@/application/agents/agent-authorization"
import { modelCatalogEntrySchema } from "@/application/agents/model-contract"
import { db, modelCatalogEntries, modelConnections } from "@/db"
import { ensureManagedOpenAIModels } from "@/application/agents/managed-openai-models.server"

async function queryAccessibleCatalog(actor: Actor) {
  const rows = await db
    .select({
      catalog: modelCatalogEntries,
      connection: modelConnections,
    })
    .from(modelCatalogEntries)
    .innerJoin(
      modelConnections,
      eq(modelCatalogEntries.connectionId, modelConnections.id)
    )
    .where(
      and(
        eq(modelConnections.workspaceId, actor.workspaceId),
        or(
          eq(modelConnections.scope, "workspace"),
          and(
            eq(modelConnections.scope, "personal"),
            eq(modelConnections.userId, actor.userId)
          )
        ),
        eq(modelConnections.status, "ready"),
        eq(modelCatalogEntries.status, "available"),
        or(
          isNull(modelCatalogEntries.expiresAt),
          gt(modelCatalogEntries.expiresAt, new Date())
        )
      )
    )

  return rows.map(({ catalog, connection }) =>
    modelCatalogEntrySchema.parse({
      selectionId: catalog.selectionId,
      connectionId: catalog.connectionId,
      executionKind: catalog.executionKind,
      provider: connection.provider,
      modelId: catalog.providerModelId,
      displayName: catalog.displayName,
      providerLabel: catalog.providerLabel,
      sourceLabel: catalog.sourceLabel,
      locality: connection.locality,
      billingMode: connection.billingMode,
      inputModalities: catalog.inputModalities,
      supportsTools: catalog.supportsTools,
      supportsCode: catalog.supportsCode,
      supportedReasoningEfforts: catalog.supportedReasoningEfforts,
      contextWindowTokens: catalog.contextWindowTokens,
      status: catalog.status,
    })
  )
}

export async function listModelCatalog(
  actor: Actor
): Promise<Array<ModelCatalogEntry>> {
  requireModelConnectionRead(actor)
  return [
    ...(await ensureManagedOpenAIModels(actor)),
    ...(await queryAccessibleCatalog(actor)),
  ]
}

export async function listModelsForRouting(
  actor: Actor
): Promise<Array<ModelCatalogEntry>> {
  requireAgentRun(actor)
  return [
    ...(await ensureManagedOpenAIModels(actor)),
    ...(await queryAccessibleCatalog(actor)),
  ]
}

import "@tanstack/react-start/server-only"

import { createHash } from "node:crypto"

import type { Actor } from "@/application/actor"
import type { ModelCatalogEntry } from "@/application/agents/model-contract"

const DEFAULT_MODELS = [
  "gpt-6-astra",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const

type ManagedOpenAIConnection = {
  id: string
  workspaceId: string
  createdByUserId: string
}

export type EnsureManagedOpenAIConnection = (
  connection: ManagedOpenAIConnection
) => Promise<void>

function configuredModelIds(environment: Record<string, string | undefined>) {
  const configured = environment.FORGE_MANAGED_OPENAI_MODELS?.split(",")
    .map((modelId) => modelId.trim())
    .filter(
      (modelId) =>
        modelId.length > 0 &&
        modelId.length <= 255 &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(modelId)
    )
  return [...new Set(configured?.length ? configured : DEFAULT_MODELS)].slice(
    0,
    50
  )
}

export function managedOpenAIConnectionIdForWorkspace(workspaceId: string) {
  const hash = createHash("sha256")
    .update("forge-managed-openai:")
    .update(workspaceId)
    .digest("hex")
    .slice(0, 32)
  const versioned = `${hash.slice(0, 12)}5${hash.slice(13)}`
  const variant = (
    (Number.parseInt(versioned[16] ?? "0", 16) & 0x3) |
    0x8
  ).toString(16)
  return `${versioned.slice(0, 8)}-${versioned.slice(
    8,
    12
  )}-${versioned.slice(12, 16)}-${variant}${versioned.slice(
    17,
    20
  )}-${versioned.slice(20)}`
}

const ensureManagedOpenAIConnection: EnsureManagedOpenAIConnection = async (
  connection
) => {
  const { db, modelConnections } = await import("@/db")
  await db
    .insert(modelConnections)
    .values({
      ...connection,
      userId: null,
      scope: "workspace",
      provider: "openai",
      kind: "managed",
      executionKind: "forge-native",
      locality: "server-capable",
      billingMode: "forge-managed",
      credentialOwner: "forge-server-vault",
      displayName: "Forge managed OpenAI",
      status: "ready",
      metadata: { source: "server-environment" },
    })
    .onConflictDoNothing()
}

export function listManagedOpenAIModels(
  connectionId: string,
  environment: Record<string, string | undefined> = process.env
): Array<ModelCatalogEntry> {
  if (!environment.OPENAI_API_KEY?.trim()) return []
  return configuredModelIds(environment).map((modelId) => ({
    selectionId: `${connectionId}:${modelId}`,
    connectionId,
    executionKind: "forge-native",
    provider: "openai",
    modelId,
    displayName: modelId,
    providerLabel: "OpenAI",
    sourceLabel: "Forge managed",
    locality: "server-capable",
    billingMode: "forge-managed",
    inputModalities: ["text"],
    supportsTools: true,
    supportsCode: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    contextWindowTokens: null,
    status: "available",
  }))
}

export async function ensureManagedOpenAIModels(
  actor: Actor,
  environment: Record<string, string | undefined> = process.env,
  ensureConnection: EnsureManagedOpenAIConnection = ensureManagedOpenAIConnection
) {
  if (!environment.OPENAI_API_KEY?.trim()) return []
  const connectionId = managedOpenAIConnectionIdForWorkspace(actor.workspaceId)
  await ensureConnection({
    id: connectionId,
    workspaceId: actor.workspaceId,
    createdByUserId: actor.userId,
  })
  return listManagedOpenAIModels(connectionId, environment)
}

export function managedOpenAIApiKeyFor(
  connectionId: string,
  workspaceId: string,
  provider: string,
  modelId: string,
  environment: Record<string, string | undefined> = process.env
) {
  if (
    connectionId !== managedOpenAIConnectionIdForWorkspace(workspaceId) ||
    provider !== "openai"
  ) {
    return null
  }
  const key = environment.OPENAI_API_KEY?.trim()
  if (!key) return null
  return configuredModelIds(environment).includes(modelId) ? key : null
}

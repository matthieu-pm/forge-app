import type {
  CreateModelConnectionInput,
  ModelConnectionSummary,
} from "@/application/agents/model-connection-contract"
import { modelConnectionSummarySchema } from "@/application/agents/model-connection-contract"

const DEVELOPMENT_WORKSPACE_PROVIDERS = [
  { provider: "openai", displayName: "OpenAI API", modelCount: 98 },
  { provider: "anthropic", displayName: "Anthropic API", modelCount: 11 },
  { provider: "google", displayName: "Google Gemini API", modelCount: 14 },
  { provider: "minimax", displayName: "MiniMax API", modelCount: 8 },
  { provider: "mistral", displayName: "Mistral API", modelCount: 23 },
  { provider: "xai", displayName: "xAI API", modelCount: 12 },
  { provider: "deepseek", displayName: "DeepSeek API", modelCount: 9 },
  { provider: "kimi", displayName: "Kimi API", modelCount: 7 },
  {
    provider: "custom-openai",
    displayName: "Custom OpenAI-compatible",
    modelCount: 3,
  },
  {
    provider: "custom-anthropic",
    displayName: "Custom Anthropic-compatible",
    modelCount: 3,
  },
] as const

const dismissedDevelopmentProviders = new Set<string>()
const developmentConnectionsById = new Map<string, ModelConnectionSummary>()

function withDevelopmentWorkspaceConnections(
  connections: Array<ModelConnectionSummary>
) {
  if (import.meta.env.MODE !== "development") return connections

  const workspaceId = connections.at(0)?.workspaceId ?? "development-workspace"
  const existingWorkspaceProviders = new Set(
    connections
      .filter(
        (connection) =>
          connection.scope === "workspace" &&
          connection.billingMode !== "forge-managed"
      )
      .map((connection) => connection.provider)
  )
  const timestamp = "2026-08-01T00:00:00.000Z"
  const developmentConnections = DEVELOPMENT_WORKSPACE_PROVIDERS.flatMap(
    (fixture, index) => {
      if (
        existingWorkspaceProviders.has(fixture.provider) ||
        dismissedDevelopmentProviders.has(fixture.provider)
      ) {
        return []
      }

      const connection: ModelConnectionSummary = {
        id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
        workspaceId,
        userId: null,
        scope: "workspace",
        provider: fixture.provider,
        kind: "api-key",
        executionKind: "forge-native",
        locality: "server-capable",
        billingMode: "pay-as-you-go",
        credentialOwner: "forge-server-vault",
        displayName: fixture.displayName,
        maskedCredentialSuffix: "MOCK",
        endpointUrl: null,
        status: "ready",
        statusReason: null,
        discoveredAt: timestamp,
        lastHealthCheckedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        modelCount: fixture.modelCount,
      }
      developmentConnectionsById.set(connection.id, connection)
      return [connection]
    }
  )

  return [...connections, ...developmentConnections]
}

async function readResponse<T>(
  response: Response,
  parse: (value: unknown) => T
) {
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : "The model connection request failed."
    throw new Error(message)
  }
  return parse(payload)
}

export async function listModelConnections() {
  const response = await fetch("/api/agent/connections", {
    headers: { accept: "application/json" },
  })
  const connections = await readResponse(response, (value) =>
    modelConnectionSummarySchema.array().parse(value)
  )
  return withDevelopmentWorkspaceConnections(connections)
}

export async function createModelConnection(input: CreateModelConnectionInput) {
  const response = await fetch("/api/agent/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  return readResponse(response, (value) =>
    modelConnectionSummarySchema.parse(value)
  )
}

export async function refreshModelConnection(connectionId: string) {
  const developmentConnection = developmentConnectionsById.get(connectionId)
  if (developmentConnection) return developmentConnection

  const response = await fetch(
    `/api/agent/connections/${encodeURIComponent(connectionId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    }
  )
  return readResponse(response, (value) =>
    modelConnectionSummarySchema.parse(value)
  )
}

export async function deleteModelConnection(connectionId: string) {
  const developmentConnection = developmentConnectionsById.get(connectionId)
  if (developmentConnection) {
    dismissedDevelopmentProviders.add(developmentConnection.provider)
    developmentConnectionsById.delete(connectionId)
    return
  }

  const response = await fetch(
    `/api/agent/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" }
  )
  await readResponse(response, () => undefined)
}

export type { ModelConnectionSummary }

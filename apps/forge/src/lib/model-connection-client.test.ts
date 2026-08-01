import { afterEach, describe, expect, it, vi } from "vitest"

import {
  deleteModelConnection,
  listModelConnections,
  refreshModelConnection,
} from "./model-connection-client"

describe("development workspace model connections", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("adds every provider and handles mock actions locally", async () => {
    vi.stubEnv("MODE", "development")
    const managedOpenAiConnection = {
      id: "00000000-0000-4000-8000-000000000099",
      workspaceId: "workspace-1",
      userId: null,
      scope: "workspace",
      provider: "openai",
      kind: "managed",
      executionKind: "forge-native",
      locality: "server-capable",
      billingMode: "forge-managed",
      credentialOwner: "forge-server-vault",
      displayName: "Forge managed OpenAI",
      maskedCredentialSuffix: null,
      endpointUrl: null,
      status: "ready",
      statusReason: null,
      discoveredAt: null,
      lastHealthCheckedAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      modelCount: 0,
    }
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([managedOpenAiConnection]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    )
    vi.stubGlobal("fetch", fetchMock)

    const connections = await listModelConnections()
    const userVisibleConnections = connections.filter(
      (connection) => connection.billingMode !== "forge-managed"
    )

    expect(connections).toHaveLength(11)
    expect(
      userVisibleConnections.every(
        (connection) => connection.scope === "workspace"
      )
    ).toBe(true)
    expect(
      userVisibleConnections.map((connection) => connection.provider)
    ).toEqual([
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
    ])

    const openAiConnection = userVisibleConnections[0]
    expect(await refreshModelConnection(openAiConnection.id)).toEqual(
      openAiConnection
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await deleteModelConnection(openAiConnection.id)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const connectionsAfterDelete = await listModelConnections()
    expect(
      connectionsAfterDelete.some(
        (connection) =>
          connection.provider === "openai" &&
          connection.billingMode !== "forge-managed"
      )
    ).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

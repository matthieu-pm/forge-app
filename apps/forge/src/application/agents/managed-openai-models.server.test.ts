// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import {
  ensureManagedOpenAIModels,
  listManagedOpenAIModels,
  managedOpenAIApiKeyFor,
  managedOpenAIConnectionIdForWorkspace,
} from "@/application/agents/managed-openai-models.server"

describe("Forge-managed OpenAI models", () => {
  it("includes GPT 6 Astra in the default managed catalog", () => {
    const models = listManagedOpenAIModels(
      "00000000-0000-4000-8000-000000000001",
      { OPENAI_API_KEY: "server-secret" }
    )

    expect(models[0]).toEqual(
      expect.objectContaining({
        modelId: "gpt-6-astra",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      })
    )
  })

  it("provisions a workspace-owned connection before exposing models", async () => {
    const ensureConnection = vi.fn().mockResolvedValue(undefined)

    const models = await ensureManagedOpenAIModels(
      {
        userId: "user-1",
        workspaceId: "workspace-1",
        workspaceRole: "owner",
        authentication: { kind: "session", sessionId: "session-1" },
        scopes: null,
      },
      {
        OPENAI_API_KEY: "server-secret",
        FORGE_MANAGED_OPENAI_MODELS: "gpt-5.6-luna,gpt-5.6-sol",
      },
      ensureConnection
    )

    expect(ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        workspaceId: "workspace-1",
        createdByUserId: "user-1",
      })
    )
    const connectionId =
      ensureConnection.mock.calls[0]?.[0].id ?? "missing-managed-connection-id"
    expect(models).toEqual([
      expect.objectContaining({
        connectionId,
        modelId: "gpt-5.6-luna",
        billingMode: "forge-managed",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      }),
      expect.objectContaining({
        connectionId,
        modelId: "gpt-5.6-sol",
        billingMode: "forge-managed",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      }),
    ])
    expect(JSON.stringify(models)).not.toContain("server-secret")
  })

  it("opens the key only for an allowlisted model on the managed connection", () => {
    const environment = {
      OPENAI_API_KEY: "server-secret",
      FORGE_MANAGED_OPENAI_MODELS: "gpt-5.6-luna",
    }
    const connectionId = managedOpenAIConnectionIdForWorkspace("workspace-1")

    expect(
      managedOpenAIApiKeyFor(
        connectionId,
        "workspace-1",
        "openai",
        "gpt-5.6-luna",
        environment
      )
    ).toBe("server-secret")
    expect(
      managedOpenAIApiKeyFor(
        connectionId,
        "workspace-1",
        "openai",
        "gpt-5.6-sol",
        environment
      )
    ).toBeNull()
    expect(
      managedOpenAIApiKeyFor(
        connectionId,
        "workspace-1",
        "anthropic",
        "gpt-5.6-luna",
        environment
      )
    ).toBeNull()
    expect(
      managedOpenAIApiKeyFor(
        connectionId,
        "workspace-2",
        "openai",
        "gpt-5.6-luna",
        environment
      )
    ).toBeNull()
  })
})

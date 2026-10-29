// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { createOpenAIModelProxy } from "@/application/agents/openai-model-proxy.server"
import { managedOpenAIConnectionIdForWorkspace } from "@/application/agents/managed-openai-models.server"

const claims = {
  sub: "user-1",
  workspaceId: "workspace-1",
  runId: "00000000-0000-4000-8000-000000000010",
  connectionId: "00000000-0000-4000-8000-000000000020",
  provider: "openai",
  modelId: "gpt-5.6-luna",
  tokenId: "00000000-0000-4000-8000-000000000030",
}

describe("OpenAI model proxy", () => {
  it("refuses unregistered stored connections in staging before database or provider I/O", async () => {
    const old = process.env.FORGE_ENVIRONMENT
    process.env.FORGE_ENVIRONMENT = "staging"
    const fetcher = vi.fn<typeof fetch>()
    try {
      const handler = createOpenAIModelProxy({
        verifyToken: vi.fn().mockResolvedValue(claims),
        fetcher,
      })
      const result = await handler(
        new Request("https://forge.test/api/agent/runtime/model/responses", {
          method: "POST",
          headers: { authorization: "Bearer fixture" },
          body: JSON.stringify({
            model: claims.modelId,
            input: "Synthetic fixture",
          }),
        }),
        "responses"
      )
      expect(result.status).toBe(403)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      if (old === undefined) delete process.env.FORGE_ENVIRONMENT
      else process.env.FORGE_ENVIRONMENT = old
    }
  })
  it("uses the selected server-side credential without returning it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('data: {"type":"response.completed"}\n\n', {
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "req_123",
        },
      })
    )
    const handler = createOpenAIModelProxy({
      verifyToken: vi.fn().mockResolvedValue(claims),
      loadCredential: vi.fn().mockResolvedValue({
        apiKey: "secret-provider-key",
        baseUrl: new URL("https://api.openai.com/v1/"),
        provider: "openai",
      }),
      fetcher,
    })

    const response = await handler(
      new Request("http://forge.test/api/agent/runtime/openai/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer run-model-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: claims.modelId,
          input: "Hello",
          stream: true,
        }),
      }),
      "responses"
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
    expect(await response.text()).not.toContain("secret-provider-key")
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://api.openai.com/v1/responses"),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer secret-provider-key",
        }),
      })
    )
  })

  it("executes a Forge-managed model without exposing its environment key", async () => {
    const previousKey = process.env.OPENAI_API_KEY
    const previousModels = process.env.FORGE_MANAGED_OPENAI_MODELS
    process.env.OPENAI_API_KEY = "managed-environment-key"
    process.env.FORGE_MANAGED_OPENAI_MODELS = "gpt-5.6-luna"
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "response-1" }))
    const managedClaims = {
      ...claims,
      connectionId: managedOpenAIConnectionIdForWorkspace(claims.workspaceId),
    }
    try {
      const handler = createOpenAIModelProxy({
        verifyToken: vi.fn().mockResolvedValue(managedClaims),
        fetcher,
      })

      const response = await handler(
        new Request("http://forge.test/api/agent/runtime/model/responses", {
          method: "POST",
          headers: {
            authorization: "Bearer run-model-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: managedClaims.modelId,
            input: "Hello",
          }),
        }),
        "responses"
      )

      expect(response.status).toBe(200)
      expect(fetcher).toHaveBeenCalledWith(
        new URL("https://api.openai.com/v1/responses"),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: "Bearer managed-environment-key",
          }),
        })
      )
      expect(await response.text()).not.toContain("managed-environment-key")
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
      if (previousModels === undefined) {
        delete process.env.FORGE_MANAGED_OPENAI_MODELS
      } else {
        process.env.FORGE_MANAGED_OPENAI_MODELS = previousModels
      }
    }
  })

  it("uses the selected provider authentication without exposing its key", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "message-1" }))
    const handler = createOpenAIModelProxy({
      verifyToken: vi.fn().mockResolvedValue({
        ...claims,
        provider: "anthropic",
        modelId: "claude-sonnet",
      }),
      loadCredential: vi.fn().mockResolvedValue({
        apiKey: "secret-anthropic-key",
        baseUrl: new URL("https://api.anthropic.com/v1/"),
        provider: "anthropic",
      }),
      fetcher,
    })

    const response = await handler(
      new Request("http://forge.test/api/agent/runtime/model/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer run-model-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet",
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
      "messages"
    )

    expect(response.status).toBe(200)
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://api.anthropic.com/v1/messages"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "anthropic-version": "2023-06-01",
          "x-api-key": "secret-anthropic-key",
        }),
      })
    )
    expect(JSON.stringify(fetcher.mock.calls)).toContain("secret-anthropic-key")
    expect(await response.text()).not.toContain("secret-anthropic-key")
  })

  it("rejects model substitution before opening a credential", async () => {
    const loadCredential = vi.fn()
    const handler = createOpenAIModelProxy({
      verifyToken: vi.fn().mockResolvedValue(claims),
      loadCredential,
    })
    const response = await handler(
      new Request("http://forge.test/api/agent/runtime/openai/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer run-model-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-other", input: "Hello" }),
      }),
      "responses"
    )

    expect(response.status).toBe(403)
    expect(loadCredential).not.toHaveBeenCalled()
  })
})

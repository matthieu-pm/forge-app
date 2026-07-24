// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest"

import { discoverApiProviderModels } from "@/adapters/agents/provider-catalogs/api-provider-catalog.server"

describe("API provider catalog", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("discovers text models without returning the credential", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [
          { id: "gpt-5.6-terra" },
          { id: "babbage-002" },
          { id: "text-embedding-4" },
        ],
      })
    )

    const models = await discoverApiProviderModels({
      provider: "openai",
      apiKey: "sk-test-secret",
    })

    expect(models).toEqual([
      expect.objectContaining({
        modelId: "babbage-002",
        supportsTools: false,
      }),
      expect.objectContaining({
        modelId: "gpt-5.6-terra",
        supportsTools: true,
      }),
    ])
    expect(JSON.stringify(models)).not.toContain("sk-test-secret")
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://api.openai.com/v1/models"),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer sk-test-secret",
        }),
        redirect: "error",
      })
    )
  })

  it("uses manual custom model IDs only when discovery is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))

    await expect(
      discoverApiProviderModels({
        provider: "openai",
        apiKey: "sk-test-secret",
        modelIds: ["private-deployment"],
      })
    ).resolves.toEqual([
      expect.objectContaining({ modelId: "private-deployment" }),
    ])
  })

  it("pins custom endpoint discovery to the validated DNS result", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ id: "custom-text-model" }] }))

    await discoverApiProviderModels(
      {
        provider: "custom-openai",
        apiKey: "custom-secret",
        endpointUrl: "https://models.example/v1/",
      },
      {
        fetcher,
        resolveEndpoint: vi.fn().mockResolvedValue({
          url: new URL("https://models.example/v1/"),
          addresses: [{ address: "203.0.114.10", family: 4 }],
        }),
      }
    )

    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://models.example/v1/models"),
      expect.objectContaining({
        dispatcher: expect.any(Object),
        redirect: "error",
      })
    )
  })
})

// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { handlePublicApiRequest } from "@/api/v1/handler.server"

const mocks = vi.hoisted(() => ({
  verifyApiKey: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({
  auth: { api: { verifyApiKey: mocks.verifyApiKey } },
}))

vi.mock("@/db", () => ({
  apiIdempotencyKeys: {},
  db: {},
  members: {},
  teams: {},
}))

describe("public API HTTP handler", () => {
  it.each([
    "signals",
    "reviews",
    "insights",
    "billing",
    "applications",
    "integrations",
    "exports",
    "imports",
  ])(
    "FOR-103: does not publish or execute a deferred %s API",
    async (feature) => {
      const discovery = await handlePublicApiRequest(
        new Request("https://forge.test/api/v1/openapi.json")
      )
      const document = await discovery.json()
      expect(document.paths[`/${feature}`]).toBeUndefined()
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
        const response = await handlePublicApiRequest(
          new Request(
            `https://forge.test/api/v1/${feature}?enabled=true&workspaceId=w1`,
            {
              method,
              headers: {
                authorization: "Bearer forged",
                "x-feature-enabled": "true",
                "x-workspace-id": "w1",
              },
            }
          )
        )
        expect(response.status).toBe(404)
      }
      expect(mocks.verifyApiKey).not.toHaveBeenCalled()
    }
  )
  it("publishes an authenticated OpenAPI 3.1 contract", async () => {
    const response = await handlePublicApiRequest(
      new Request("https://forge.test/api/v1/openapi.json")
    )
    const document = (await response.json()) as {
      openapi: string
      paths: Record<string, Record<string, unknown>>
      security: Array<Record<string, Array<string>>>
    }

    expect(response.status).toBe(200)
    expect(document.openapi).toBe("3.1.1")
    expect(document.paths["/teams"].get).toBeDefined()
    expect(document.paths["/teams"].post).toBeDefined()
    expect(document.paths["/teams/{teamId}"].patch).toBeDefined()
    expect(document.security).toEqual([{ bearerAuth: [] }])
  })

  it("rejects resource requests without falling back to session cookies", async () => {
    const response = await handlePublicApiRequest(
      new Request("https://forge.test/api/v1/teams", {
        headers: { cookie: "better-auth.session_token=session" },
      })
    )

    expect(response.status).toBe(401)
    expect(response.headers.get("x-request-id")).toEqual(expect.any(String))
    expect(mocks.verifyApiKey).not.toHaveBeenCalled()
  })
})

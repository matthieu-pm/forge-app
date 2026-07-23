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

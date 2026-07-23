import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  ApiCredentialError,
  readBearerCredential,
  requireApiKeyActor,
} from "@/adapters/auth/api-key-actor.server"

const mocks = vi.hoisted(() => ({
  membershipLimit: vi.fn(),
  verifyApiKey: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({
  auth: { api: { verifyApiKey: mocks.verifyApiKey } },
}))

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: mocks.membershipLimit }),
      }),
    }),
  },
  members: {},
}))

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: Array<unknown>) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}))

describe("API-key actor adapter", () => {
  beforeEach(() => {
    mocks.verifyApiKey.mockResolvedValue({
      valid: true,
      error: null,
      key: {
        id: "key-1",
        referenceId: "user-1",
        metadata: { workspaceId: "workspace-1" },
        permissions: { teams: ["read", "write"], admin: ["everything"] },
      },
    })
    mocks.membershipLimit.mockResolvedValue([{ role: "admin" }])
  })

  it("extracts only a single Bearer credential", () => {
    expect(
      readBearerCredential(new Headers({ authorization: "Bearer forge_key" }))
    ).toBe("forge_key")
    expect(
      readBearerCredential(new Headers({ authorization: "Basic forge_key" }))
    ).toBeNull()
  })

  it("resolves workspace membership and recognized scopes", async () => {
    await expect(
      requireApiKeyActor(new Headers({ authorization: "Bearer forge_secret" }))
    ).resolves.toEqual({
      userId: "user-1",
      workspaceId: "workspace-1",
      workspaceRole: "admin",
      authentication: { kind: "apiKey", credentialId: "key-1" },
      scopes: ["teams:read", "teams:write"],
    })
  })

  it("rejects missing, invalid, and rate-limited credentials", async () => {
    await expect(requireApiKeyActor(new Headers())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })

    mocks.verifyApiKey.mockResolvedValueOnce({
      valid: false,
      key: null,
      error: { code: "INVALID_API_KEY" },
    })
    await expect(
      requireApiKeyActor(new Headers({ authorization: "Bearer invalid" }))
    ).rejects.toBeInstanceOf(ApiCredentialError)

    mocks.verifyApiKey.mockResolvedValueOnce({
      valid: false,
      key: null,
      error: { code: "RATE_LIMIT_EXCEEDED" },
    })
    await expect(
      requireApiKeyActor(new Headers({ authorization: "Bearer limited" }))
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
  })

  it("removes access immediately after workspace membership is revoked", async () => {
    mocks.membershipLimit.mockResolvedValue([])

    await expect(
      requireApiKeyActor(new Headers({ authorization: "Bearer forge_key" }))
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})

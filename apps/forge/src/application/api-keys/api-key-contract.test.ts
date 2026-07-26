import { describe, expect, it } from "vitest"

import {
  createApiKeyInputSchema,
  permissionsToScopes,
  scopesToPermissions,
} from "@/application/api-keys/api-key-contract"

describe("API key contract", () => {
  it("uses a secure expiry default and rejects unknown scopes", () => {
    expect(
      createApiKeyInputSchema.parse({
        name: "Automation",
        scopes: ["teams:read"],
      })
    ).toMatchObject({ expiresInDays: 90 })

    expect(() =>
      createApiKeyInputSchema.parse({
        name: "Automation",
        scopes: ["admin:everything"],
      })
    ).toThrow()
  })

  it("round-trips resource permissions and ignores unknown values", () => {
    const permissions = scopesToPermissions([
      "teams:read",
      "teams:write",
      "teams:read",
    ])

    expect(permissions).toEqual({ teams: ["read", "write"] })
    expect(
      permissionsToScopes({ ...permissions, admin: ["everything"] })
    ).toEqual(["teams:read", "teams:write"])
  })
})

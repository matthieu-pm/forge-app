// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { assertIsolatedTestConnection } from "./isolated-test-database"
import {
  integrationFixtureIds,
  manageIntegrationFixtures,
} from "./integration-fixtures"
import { DATABASE_TARGETS } from "./database-targets"

describe("integration fixture safety", () => {
  it.each(["seed", "cleanup"] as const)(
    "refuses SQL production identity before %s mutation",
    async (action) => {
      const client = {
        query: vi.fn().mockResolvedValue({
          rows: [{ database: "neondb", branch: "br-muddy-queen-zaeeysjt" }],
        }),
      }
      await expect(
        manageIntegrationFixtures(
          client,
          action,
          "12345678-1234-4123-8123-123456789abc"
        )
      ).rejects.toThrow("identity")
      expect(client.query).toHaveBeenCalledTimes(1)
      expect(client.query.mock.calls[0][0]).toMatch(/^SELECT current_database/)
    }
  )
  it("refuses production URL even with staging labels and rejects driver routing overrides", () => {
    const staging = DATABASE_TARGETS.staging
    expect(() =>
      assertIsolatedTestConnection(
        "postgresql://user:password@ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require"
      )
    ).toThrow()
    const connection = `postgresql://fixture:fixture@${staging.host}/${staging.database}?sslmode=require`
    expect(() => assertIsolatedTestConnection(connection)).not.toThrow()
    for (const suffix of [
      "&host=production.example.com",
      "&options=endpoint%3Dep-production",
      "&dbname=neondb",
      "&sslmode=disable",
    ])
      expect(() => assertIsolatedTestConnection(connection + suffix)).toThrow()
  })
  it("cannot supply arbitrary row IDs or a cleanup wildcard", async () => {
    const client = { query: vi.fn() }
    for (const id of [
      "%",
      "production",
      "12345678-1234-4123-8123-123456789abc%",
    ])
      await expect(
        manageIntegrationFixtures(client, "cleanup", id)
      ).rejects.toThrow("UUID")
    expect(client.query).not.toHaveBeenCalled()
    const ids = integrationFixtureIds("12345678-1234-4123-8123-123456789abc")
    expect(new Set(ids.map((f) => f.workspaceId)).size).toBe(2)
    expect(ids.every((f) => f.email.endsWith("@example.test"))).toBe(true)
  })
})

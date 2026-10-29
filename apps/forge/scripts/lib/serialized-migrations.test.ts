import { describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "./database-targets"
import {
  assertMigrationTarget,
  runSerializedMigrations,
} from "./serialized-migrations"

const target = {
  environment: "rehearsal" as const,
  ...DATABASE_TARGETS.rehearsal,
}
const connection = `postgresql://fixture:fixture@${target.host}/${target.database}?sslmode=require`

describe("migration safety boundaries", () => {
  it("rejects an untrusted journal namespace before any query", async () => {
    const client = { query: vi.fn() }
    await expect(
      runSerializedMigrations(client, [], target, "public;DROP SCHEMA public")
    ).rejects.toThrow("journal schema")
    expect(client.query).not.toHaveBeenCalled()
  })
  it("accepts only the reviewed exact direct target", () => {
    expect(() => assertMigrationTarget(connection, target)).not.toThrow()
    expect(() =>
      assertMigrationTarget(
        connection.replace(target.host, target.host.replace(".", "-pooler.")),
        target
      )
    ).toThrow("direct database host")
    expect(() =>
      assertMigrationTarget(
        connection.replace(target.database, "neondb"),
        target
      )
    ).toThrow("expected database")
    expect(() =>
      assertMigrationTarget(
        connection.replace(target.host, "production.example.com"),
        target
      )
    ).toThrow("direct database host")
  })
  it("rejects a renamed production environment or unreviewed branch before any query", async () => {
    const client = { query: vi.fn() }
    await expect(
      runSerializedMigrations(client, [], {
        ...target,
        branchId: "br-muddy-queen-zaeeysjt",
      })
    ).rejects.toThrow("approved isolated environment")
    expect(client.query).not.toHaveBeenCalled()
  })
  it("rejects actual branch mismatch before locks or DDL", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{ database: target.database, branch: "br-production" }],
      }),
    }
    await expect(runSerializedMigrations(client, [], target)).rejects.toThrow(
      "identity does not match"
    )
    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.query.mock.calls[0][0]).toMatch(/^SELECT current_database/)
  })
})

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

describe("source-bound production migration release", () => {
  const production = {
    environment: "production" as const,
    ...DATABASE_TARGETS.production,
  }
  const url = `postgresql://fixture:fixture@${production.host}/${production.database}?sslmode=require`
  it("rejects production without explicit release authority before any query", async () => {
    expect(() => assertMigrationTarget(url, production)).toThrow("source-bound")
    const client = { query: vi.fn() }
    await expect(
      runSerializedMigrations(client, [], production)
    ).rejects.toThrow("source-bound")
    expect(client.query).not.toHaveBeenCalled()
  })
  it("still rejects a substituted production endpoint with a valid source approval", () => {
    const release = {
      sourceRevision: "a".repeat(40),
      expectedCurrentCount: 26,
      expectedCurrentHash: "b".repeat(64),
    }
    expect(() => assertMigrationTarget(url, production, release)).not.toThrow()
    expect(() =>
      assertMigrationTarget(
        url.replace(production.host, "foreign.example.test"),
        production,
        release
      )
    ).toThrow("direct database host")
  })
  it("rolls back on a changed approved journal without applying a migration", async () => {
    const client = {
      query: vi.fn((statement: string) =>
        Promise.resolve({
          rows: statement.startsWith("SELECT current_database")
            ? [{ database: production.database, branch: production.branchId }]
            : statement.startsWith("SELECT pg_try_advisory_lock")
              ? [{ acquired: true }]
              : statement.startsWith("SELECT hash,created_at")
                ? [{ hash: "old", created_at: 1 }]
                : [],
        })
      ),
    }
    await expect(
      runSerializedMigrations(
        client,
        [
          { hash: "old", folderMillis: 1, sql: ["OLD"], bps: true },
          { hash: "new", folderMillis: 2, sql: ["MUTATION"], bps: true },
        ],
        production,
        "drizzle",
        {
          sourceRevision: "a".repeat(40),
          expectedCurrentCount: 26,
          expectedCurrentHash: "b".repeat(64),
        }
      )
    ).rejects.toThrow("changed since")
    expect(client.query).toHaveBeenCalledWith("ROLLBACK")
    expect(client.query).not.toHaveBeenCalledWith("MUTATION")
  })
})

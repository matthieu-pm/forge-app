// @vitest-environment node
import { readMigrationFiles } from "drizzle-orm/migrator"
import { describe, expect, it, vi } from "vitest"
import {
  healthResponse,
  readinessCode,
} from "../../../../../packages/telemetry/health"
import manifest from "./migrations.generated.json"
import { schemaIsReady } from "./readiness-schema"

describe("public liveness and readiness", () => {
  const ready = () => ({
    configuration: async () => true,
    database: async () => true,
    schema: async () => true,
  })
  it("liveness needs no dependencies", async () => {
    expect(await healthResponse("ALIVE").json()).toEqual({
      status: "ok",
      code: "ALIVE",
    })
  })
  it.each([
    "configuration",
    "database",
    "schema",
    "runtime",
    "storage",
  ] as const)("fails safely when %s is missing", async (key) => {
    const code = await readinessCode({
      ...ready(),
      [key]: async () => {
        throw new Error("postgresql://user:SECRET-FIXTURE@private-host/db")
      },
    })
    const response = healthResponse(code)
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).not.toMatch(/SECRET|private-host|postgresql/)
  })
  it("bounds a hung dependency and stops after its first failing boundary", async () => {
    const schema = vi.fn()
    expect(
      await readinessCode(
        { ...ready(), database: () => new Promise(() => {}), schema },
        10
      )
    ).toBe("DATABASE_UNAVAILABLE")
    expect(schema).not.toHaveBeenCalled()
  })
  it("checks required migration hashes, including missing/edited/reordered history", async () => {
    const rows = manifest.map((entry) => ({
      hash: entry.hash,
      created_at: entry.createdAt,
    }))
    for (const data of [
      rows.slice(0, -1),
      [...rows].reverse(),
      [{ ...rows[0], hash: "wrong" }, ...rows.slice(1)],
    ]) {
      expect(await schemaIsReady({ query: async () => ({ rows: data }) })).toBe(
        false
      )
    }
    expect(await schemaIsReady({ query: async () => ({ rows }) })).toBe(true)
    expect(
      await schemaIsReady({
        query: async () => ({
          rows: [...rows, { hash: "new-expansion", created_at: Date.now() }],
        }),
      })
    ).toBe(true)
    expect(
      await schemaIsReady({
        query: async () => {
          throw new Error("journal missing")
        },
      })
    ).toBe(false)
  })
  it("keeps the built readiness contract synchronized with the migration source", () => {
    expect(manifest).toEqual(
      readMigrationFiles({ migrationsFolder: "drizzle" }).map(
        ({ hash, folderMillis }) => ({ hash, createdAt: folderMillis })
      )
    )
  })
})

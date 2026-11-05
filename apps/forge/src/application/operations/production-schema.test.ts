// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { verifyProductionSchema } from "../../../scripts/lib/production-schema"
import manifest from "./migrations.generated.json"

const database = "postgresql://fixture:SECRET@private-host/db"
const production = { VERCEL_ENV: "production", DATABASE_URL: database }

describe("production promotion schema preflight", () => {
  it.each([undefined, "development", "preview"])(
    "does not connect for %s builds",
    async (VERCEL_ENV) => {
      const connect = vi.fn()
      await expect(
        verifyProductionSchema({ VERCEL_ENV }, connect)
      ).resolves.toBe(false)
      expect(connect).not.toHaveBeenCalled()
    }
  )

  it("blocks production with missing credentials before connecting", async () => {
    const connect = vi.fn()
    await expect(
      verifyProductionSchema({ VERCEL_ENV: "production" }, connect)
    ).rejects.toThrow("blocked promotion")
    expect(connect).not.toHaveBeenCalled()
  })

  it("blocks unapplied production migrations", async () => {
    const query = vi.fn((_text: string) => Promise.resolve({ rows: [] }))
    await expect(
      verifyProductionSchema(production, () => ({ query }))
    ).rejects.toThrow("blocked promotion")
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT hash,created_at/)
  })

  it("accepts the runtime readiness prefix including later applied migrations", async () => {
    const rows = manifest.map((entry) => ({
      hash: entry.hash,
      created_at: String(entry.createdAt),
    }))
    rows.push({ hash: "later-expanded-schema", created_at: "9999999999999" })
    await expect(
      verifyProductionSchema(production, () => ({
        query: () => Promise.resolve({ rows }),
      }))
    ).resolves.toBe(true)
  })

  it("fails closed without leaking provider credentials", async () => {
    await expect(
      verifyProductionSchema(production, () => {
        throw new Error(database)
      })
    ).rejects.toThrow(/^Production schema preflight blocked promotion\./)
  })
})

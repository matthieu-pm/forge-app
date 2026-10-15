// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { sql } from "drizzle-orm"
import type { PoolClient } from "@neondatabase/serverless"

describe("database driver", () => {
  afterEach(async () => {
    const { neonConfig } = await import("@neondatabase/serverless")
    neonConfig.poolQueryViaFetch = false
    neonConfig.fetchFunction = undefined
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("uses the transaction-capable Neon WebSocket client", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:password@example.test/database"
    )

    const { db } = await import("./index")

    expect(db.$client.constructor.name).toBe("NeonPool")
    const { neonConfig } = await import("@neondatabase/serverless")
    expect(neonConfig.poolQueryViaFetch).toBe(false)
  })

  it("sends standalone Neon queries over HTTP without opening a WebSocket", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://fixture:fixture@ep-test.eu-central-1.aws.neon.tech/database"
    )
    const { db } = await import("./index")
    const { neonConfig } = await import("@neondatabase/serverless")
    const fetchQuery = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            fields: [{ name: "value", dataTypeID: 23 }],
            rows: [["1"]],
            rowCount: 1,
            command: "SELECT",
            rowAsArray: false,
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      )
    )
    neonConfig.fetchFunction = fetchQuery
    vi.spyOn(db.$client, "connect").mockImplementation(() => {
      throw new Error("Unexpected WebSocket connection for a standalone query")
    })
    const result = await db.execute(sql`select 1 as value`)
    expect(result.rows).toEqual([{ value: 1 }])
    expect(fetchQuery).toHaveBeenCalledOnce()
  })

  it("keeps a transaction on its checked-out connection and rolls back failures", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://fixture:fixture@ep-test.eu-central-1.aws.neon.tech/database"
    )
    const { db } = await import("./index")
    const { neonConfig } = await import("@neondatabase/serverless")
    const fetchQuery = vi.fn()
    neonConfig.fetchFunction = fetchQuery
    const query = vi.fn<
      (config: { text: string }) => Promise<{ rows: Array<unknown> }>
    >(() => Promise.resolve({ rows: [] }))
    const release = vi.fn()
    vi.spyOn(db.$client, "connect").mockImplementation(() =>
      Promise.resolve({ query, release } as unknown as PoolClient)
    )
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`select 1`)
        throw new Error("rollback fixture")
      })
    ).rejects.toThrow("rollback fixture")
    expect(query.mock.calls.map(([config]) => config.text.trim())).toEqual([
      "begin",
      "select 1",
      "rollback",
    ])
    expect(release).toHaveBeenCalledOnce()
    expect(fetchQuery).not.toHaveBeenCalled()
  })
})

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { STAGING } from "../../../../../packages/environment/staging-environment"
import { handleDatabaseReleaseRehearsal } from "./database-release-handler"
import {
  backfillRehearsalChunk,
  rehearsalSchema,
  useRehearsalApplication,
} from "./database-release-rehearsal"

describe("database release rehearsal boundaries", () => {
  it("rejects identifiers and unbounded chunks before querying", async () => {
    const client = { query: vi.fn() }
    expect(() => rehearsalSchema("public;DROP SCHEMA public")).toThrow("UUID")
    for (const size of [0, -1, 1.5, 1001, NaN])
      await expect(
        backfillRehearsalChunk(client, randomUUID(), size)
      ).rejects.toThrow("Batch size")
    await expect(
      useRehearsalApplication(client, randomUUID(), "old", { id: 0 })
    ).rejects.toThrow("input")
    expect(client.query).not.toHaveBeenCalled()
  })
  it("refuses production SQL identity before any lock or mutation", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{ database: "forge_staging", branch: "br-production" }],
      }),
    }
    await expect(backfillRehearsalChunk(client, randomUUID())).rejects.toThrow(
      "identity"
    )
    expect(client.query).toHaveBeenCalledTimes(1)
  })
  it("refuses changed backfill source and rolls back the chunk", async () => {
    const client = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.startsWith("SELECT current_database")
          ? [
              {
                database: STAGING.database.database,
                branch: STAGING.database.branchId,
              },
            ]
          : sql.includes(" AS acquired")
            ? [{ acquired: true }]
            : sql.includes("FOR UPDATE")
              ? [{ source_hash: "changed" }]
              : [],
      })),
    }
    await expect(backfillRehearsalChunk(client, randomUUID())).rejects.toThrow(
      "source changed"
    )
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK")
    expect(
      client.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))
    ).toBe(false)
  })
  it("does not construct a database client for disabled, expired or unauthorized probes", async () => {
    const now = Date.now(),
      token = randomBytes(32).toString("base64url"),
      use = vi.fn()
    const env = {
      FORGE_ENVIRONMENT: "staging",
      VERCEL_PROJECT_ID: STAGING.webProjectId,
      FORGE_DB_REHEARSAL_RUN_ID: randomUUID(),
      FORGE_DB_REHEARSAL_VERSION: "old",
      FORGE_DB_REHEARSAL_EXPIRES_AT: new Date(now + 60000).toISOString(),
      FORGE_DB_REHEARSAL_TOKEN_SHA256: createHash("sha256")
        .update(token)
        .digest("hex"),
    }
    const request = new Request("https://staging.test/probe?id=1", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-environment-check-challenge": "a".repeat(32),
      },
    })
    for (const patch of [
      { FORGE_ENVIRONMENT: "production" },
      { VERCEL_PROJECT_ID: "production" },
      { FORGE_DB_REHEARSAL_RUN_ID: "public" },
      { FORGE_DB_REHEARSAL_VERSION: "unknown" },
      { FORGE_DB_REHEARSAL_EXPIRES_AT: new Date(now - 1).toISOString() },
      {
        FORGE_DB_REHEARSAL_EXPIRES_AT: new Date(
          now + 3 * 3600000
        ).toISOString(),
      },
      { FORGE_DB_REHEARSAL_TOKEN_SHA256: "b".repeat(64) },
    ])
      expect(
        (
          await handleDatabaseReleaseRehearsal(
            request,
            { ...env, ...patch },
            use,
            now
          )
        ).status
      ).toBe(404)
    expect(use).not.toHaveBeenCalled()
    use.mockResolvedValue({ value: "synthetic-1" })
    expect(
      (await handleDatabaseReleaseRehearsal(request, env, use, now)).status
    ).toBe(200)
    expect(use).toHaveBeenCalledWith(env.FORGE_DB_REHEARSAL_RUN_ID, "old", {
      id: 1,
      value: undefined,
    })
    use.mockRejectedValue(new Error("private driver/SQL details"))
    const failure = await handleDatabaseReleaseRehearsal(request, env, use, now)
    expect(failure.status).toBe(503)
    expect(await failure.text()).not.toContain("private")
  })
})

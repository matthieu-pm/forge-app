// @vitest-environment node
import { randomUUID } from "node:crypto"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { describe, expect, it } from "vitest"
import { assertIsolatedTestConnection } from "../../../scripts/lib/isolated-test-database"
import {
  applyRehearsalRelease,
  backfillRehearsalChunk,
  cleanupRehearsal,
  rehearsalSchema,
  retireRehearsalReaders,
  useRehearsalApplication,
} from "./database-release-rehearsal"

const connection = process.env.FORGE_FIXTURE_DATABASE_URL
describe.skipIf(!connection)("expand/contract PostgreSQL release", () => {
  it("serializes owners, resumes interrupted chunks, rolls back application writes and fences retirement before contraction", async () => {
    assertIsolatedTestConnection(connection!)
    neonConfig.webSocketConstructor = WebSocket
    const pool = new Pool({ connectionString: connection, max: 3 })
    const a = await pool.connect(),
      b = await pool.connect()
    const run = randomUUID(),
      sentinel = randomUUID(),
      s = rehearsalSchema(run)
    const productJournal = await a.query(
      "SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id"
    )
    let seeded = false,
      otherSeeded = false
    try {
      await applyRehearsalRelease(a, sentinel, "prior")
      otherSeeded = true
      await applyRehearsalRelease(a, run, "prior")
      seeded = true
      const app = (
        version: "old" | "bridge" | "new",
        id: number,
        value?: string
      ) => useRehearsalApplication(a, run, version, { id, value })
      expect((await app("old", 1)).value).toBe("synthetic-1")
      // Pause the actual owning runner after lock acquisition, then start a
      // second deployment job. Scheduling cannot turn this into sequential runs.
      let ownerAcquired!: () => void
      let resumeOwner!: () => void
      const acquired = new Promise<void>((resolve) => {
        ownerAcquired = resolve
      })
      const resume = new Promise<void>((resolve) => {
        resumeOwner = resolve
      })
      const owningClient = {
        query: async (sql: string, values?: Array<unknown>) => {
          const result = await a.query(sql, values)
          if (
            sql.includes("pg_try_advisory_lock") &&
            result.rows[0]?.acquired
          ) {
            ownerAcquired()
            await resume
          }
          return result
        },
      }
      const applying = applyRehearsalRelease(owningClient, run, "expand")
      await acquired
      try {
        await expect(applyRehearsalRelease(b, run, "expand")).rejects.toThrow(
          "MIGRATION_BUSY"
        )
      } finally {
        resumeOwner()
      }
      expect(await applying).toEqual({
        applied: 1,
        total: 2,
      })
      expect(await applyRehearsalRelease(b, run, "expand")).toEqual({
        applied: 0,
        total: 2,
      })
      expect((await app("bridge", 1)).value).toBe("synthetic-1") // fallback before backfill
      expect(await backfillRehearsalChunk(a, run, 2)).toEqual({
        processed: 2,
        lastId: 2,
        complete: false,
      })
      // Fail after data UPDATE but before the checkpoint commits. Both must roll back.
      const failing = {
        query: async (sql: string, values?: Array<unknown>) => {
          if (sql.startsWith(`UPDATE ${s}.backfill SET`))
            throw new Error("injected interruption")
          return a.query(sql, values)
        },
      }
      await expect(backfillRehearsalChunk(failing, run, 2)).rejects.toThrow(
        "interruption"
      )
      expect(
        (await a.query(`SELECT last_id FROM ${s}.backfill`)).rows[0].last_id
      ).toBe(2)
      expect(
        (await a.query(`SELECT value_v2 FROM ${s}.records WHERE id=3`)).rows[0]
          .value_v2
      ).toBeNull()
      await app("old", 1, "old-writer-after-backfill")
      await app("old", 6, "late-old-insert") // beyond captured high-water mark
      expect((await app("bridge", 1)).value).toBe("old-writer-after-backfill")
      expect((await app("bridge", 6)).value).toBe("late-old-insert")
      expect((await backfillRehearsalChunk(b, run, 2)).lastId).toBe(4)
      expect((await backfillRehearsalChunk(b, run, 2)).complete).toBe(true)
      expect((await backfillRehearsalChunk(b, run, 2)).processed).toBe(0)
      await app("new", 2, "new-write")
      expect((await app("old", 2)).value).toBe("new-write") // app rollback retains valid data
      await app("old", 2, "rollback-write")
      expect((await app("new", 2)).value).toBe("rollback-write")
      await expect(applyRehearsalRelease(a, run, "contract")).rejects.toThrow(
        "old readers/writers"
      )
      // In-flight old readers also prevent retirement, not just new arrivals.
      await a.query("BEGIN")
      await a.query("SELECT pg_advisory_xact_lock_shared(646735021)")
      try {
        await expect(retireRehearsalReaders(b, run)).rejects.toThrow(
          "MIGRATION_BUSY"
        )
      } finally {
        await a.query("ROLLBACK")
      }
      await retireRehearsalReaders(a, run)
      await expect(app("old", 1, "must-not-write")).rejects.toThrow(
        "RELEASE_RETIRED"
      )
      await expect(app("bridge", 1)).rejects.toThrow("RELEASE_RETIRED")
      expect(await applyRehearsalRelease(a, run, "contract")).toEqual({
        applied: 1,
        total: 3,
      })
      expect((await app("new", 2)).value).toBe("rollback-write")
      expect((await app("new", 7, "contracted-write")).value).toBe(
        "contracted-write"
      )
      expect(
        (
          await a.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='records'",
            [s]
          )
        ).rows.map((row) => row.column_name)
      ).not.toContain("legacy_value")
      expect(
        (
          await a.query(
            `SELECT count(*)::integer AS count FROM ${s}.__drizzle_migrations`
          )
        ).rows[0].count
      ).toBe(3)
      await cleanupRehearsal(a, run)
      seeded = false
      expect(
        (await useRehearsalApplication(a, sentinel, "old", { id: 1 })).value
      ).toBe("synthetic-1")
      expect(
        (
          await a.query(
            "SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id"
          )
        ).rows
      ).toEqual(productJournal.rows)
    } finally {
      if (seeded) await cleanupRehearsal(a, run)
      if (otherSeeded) await cleanupRehearsal(a, sentinel)
      a.release()
      b.release()
      await pool.end()
    }
  }, 120_000)
  it("refuses incomplete or changed backfills even after old applications are retired", async () => {
    assertIsolatedTestConnection(connection!)
    neonConfig.webSocketConstructor = WebSocket
    const pool = new Pool({ connectionString: connection, max: 1 })
    const client = await pool.connect(),
      run = randomUUID(),
      s = rehearsalSchema(run)
    let seeded = false
    try {
      await applyRehearsalRelease(client, run, "expand")
      seeded = true
      await retireRehearsalReaders(client, run)
      await expect(
        applyRehearsalRelease(client, run, "contract")
      ).rejects.toThrow("backfill is incomplete")
      expect(
        (
          await client.query(
            `SELECT count(*)::integer AS count FROM ${s}.__drizzle_migrations`
          )
        ).rows[0].count
      ).toBe(2)
      const hash = (await client.query(`SELECT source_hash FROM ${s}.backfill`))
        .rows[0].source_hash
      await client.query(`UPDATE ${s}.backfill SET source_hash='changed'`)
      await expect(backfillRehearsalChunk(client, run)).rejects.toThrow(
        "source changed"
      )
      expect(
        (await client.query(`SELECT last_id FROM ${s}.backfill`)).rows[0]
          .last_id
      ).toBe(0)
      await client.query(`UPDATE ${s}.backfill SET source_hash=$1`, [hash])
      expect((await backfillRehearsalChunk(client, run, 1000)).complete).toBe(
        true
      )
      expect(
        (await applyRehearsalRelease(client, run, "contract")).applied
      ).toBe(1)
    } finally {
      if (seeded) await cleanupRehearsal(client, run)
      client.release()
      await pool.end()
    }
  }, 60_000)
})

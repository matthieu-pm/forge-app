// @vitest-environment node
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DATABASE_TARGETS } from "./database-targets"
import {
  assertMigrationTarget,
  runSerializedMigrations,
} from "./serialized-migrations"
import type { MigrationMeta } from "drizzle-orm/migrator"

const connection = process.env.FORGE_MIGRATION_TEST_DATABASE_URL
const target = {
  environment: "rehearsal" as const,
  ...DATABASE_TARGETS.rehearsal,
}

describe.skipIf(!connection)(
  "serialized PostgreSQL migration rehearsal",
  () => {
    const table = `migration_fixture_${randomUUID().replaceAll("-", "")}`
    const fixtureHash = randomUUID()
    const nextHash = randomUUID()
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL("../../drizzle", import.meta.url)
      ),
    })
    const fixture: MigrationMeta = {
      sql: [
        `CREATE TABLE public.${table}(id integer PRIMARY KEY)`,
        "SELECT pg_sleep(0.2)",
      ],
      folderMillis: migrations.at(-1)!.folderMillis + 1,
      hash: fixtureHash,
      bps: true,
    }
    let pool: Pool
    const cleanup: { pool?: Pool } = {}
    let verified = false

    beforeAll(async () => {
      assertMigrationTarget(connection!, target)
      neonConfig.webSocketConstructor = WebSocket
      pool = new Pool({ connectionString: connection, max: 3 })
      cleanup.pool = pool
      const client = await pool.connect()
      try {
        const identity = await client.query(
          "SELECT current_database() AS database,current_setting('neon.branch_id',true) AS branch"
        )
        expect(identity.rows[0]).toEqual({
          database: target.database,
          branch: target.branchId,
        })
        verified = true
        // Apply the complete checked-in history on the empty, explicitly selected database.
        const result = await runSerializedMigrations(client, migrations, target)
        expect(result.total).toBe(migrations.length)
        const rows = await client.query(
          'SELECT (SELECT count(*)::int FROM public.organization) AS workspaces,(SELECT count(*)::int FROM public."user") AS users'
        )
        expect(rows.rows[0]).toEqual({ workspaces: 0, users: 0 })
      } finally {
        client.release()
      }
    }, 60_000)

    afterAll(async () => {
      if (cleanup.pool) {
        if (verified) {
          // Remove only this invocation's own fixture and exact journal hashes.
          await pool.query(`DROP TABLE IF EXISTS public.${table}`)
          await pool.query(
            "DELETE FROM drizzle.__drizzle_migrations WHERE hash=ANY($1::text[])",
            [[fixtureHash, nextHash]]
          )
        }
        await pool.end()
      }
    })

    it("allows one of two independent migration owners and then safely replays", async () => {
      const a = await pool.connect(),
        b = await pool.connect()
      try {
        const outcomes = await Promise.allSettled([
          runSerializedMigrations(a, [...migrations, fixture], target),
          runSerializedMigrations(b, [...migrations, fixture], target),
        ])
        const successes = outcomes.filter(
          (result) => result.status === "fulfilled"
        )
        const failures = outcomes.filter(
          (result) => result.status === "rejected"
        )
        expect(successes).toHaveLength(1)
        expect(failures).toHaveLength(1)
        expect(failures[0].reason.message).toContain("MIGRATION_BUSY")
        expect(
          await runSerializedMigrations(a, [...migrations, fixture], target)
        ).toEqual({ applied: 0, total: migrations.length + 1 })
        const receipt = await a.query(
          "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash=$1",
          [fixtureHash]
        )
        expect(receipt.rows[0].count).toBe(1)
      } finally {
        a.release()
        b.release()
      }
    })

    it("rolls back schema changes and journal entries together, then retries once", async () => {
      const client = await pool.connect()
      const failed: MigrationMeta = {
        ...fixture,
        hash: nextHash,
        folderMillis: fixture.folderMillis + 1,
        sql: [`INSERT INTO public.${table}(id) VALUES(1)`, "SELECT 1/0"],
      }
      try {
        await expect(
          runSerializedMigrations(
            client,
            [...migrations, fixture, failed],
            target
          )
        ).rejects.toMatchObject({ code: "22012" })
        expect(
          (
            await client.query(
              `SELECT count(*)::int AS count FROM public.${table}`
            )
          ).rows[0].count
        ).toBe(0)
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash=$1",
              [nextHash]
            )
          ).rows[0].count
        ).toBe(0)
        const corrected = { ...failed, sql: [failed.sql[0]] }
        expect(
          await runSerializedMigrations(
            client,
            [...migrations, fixture, corrected],
            target
          )
        ).toEqual({ applied: 1, total: migrations.length + 2 })
        expect(
          await runSerializedMigrations(
            client,
            [...migrations, fixture, corrected],
            target
          )
        ).toEqual({ applied: 0, total: migrations.length + 2 })
      } finally {
        client.release()
      }
    })

    it("refuses edited applied history without executing new migration statements", async () => {
      const client = await pool.connect()
      try {
        const edited = migrations.map((migration, i) =>
          i ? migration : { ...migration, hash: "changed-source" }
        )
        await expect(
          runSerializedMigrations(client, edited, target)
        ).rejects.toThrow("exact prefix")
        expect(
          (
            await client.query(
              `SELECT count(*)::int AS count FROM public.${table}`
            )
          ).rows[0].count
        ).toBe(1)
      } finally {
        client.release()
      }
    })
  }
)

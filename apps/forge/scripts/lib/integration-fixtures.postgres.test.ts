// @vitest-environment node
import { randomUUID } from "node:crypto"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { describe, expect, it } from "vitest"
import { assertIsolatedTestConnection } from "./isolated-test-database"
import {
  integrationFixtureIds,
  manageIntegrationFixtures,
} from "./integration-fixtures"

const connection = process.env.FORGE_FIXTURE_DATABASE_URL
describe.skipIf(!connection)("isolated disposable A/B fixtures", () => {
  it("replays seed and cleanup, preserves a separate run, and refuses edited ownership atomically", async () => {
    assertIsolatedTestConnection(connection!)
    neonConfig.webSocketConstructor = WebSocket
    const pool = new Pool({ connectionString: connection, max: 1 })
    const client = await pool.connect()
    const run = randomUUID(),
      sentinel = randomUUID()
    const ids = integrationFixtureIds(run),
      other = integrationFixtureIds(sentinel)
    let seeded = false,
      sentinelSeeded = false
    try {
      await manageIntegrationFixtures(client, "seed", sentinel)
      sentinelSeeded = true
      await manageIntegrationFixtures(client, "seed", run)
      seeded = true
      await manageIntegrationFixtures(client, "seed", run)
      const count = async (values: Array<string>) =>
        (
          await client.query(
            "SELECT count(*)::int AS count FROM public.organization WHERE id=ANY($1::text[])",
            [values]
          )
        ).rows[0].count
      expect(await count(ids.map((f) => f.workspaceId))).toBe(2)
      expect(
        (
          await client.query(
            "SELECT active_member_count FROM public.workspace_member_capacity WHERE workspace_id=ANY($1::text[])",
            [ids.map((f) => f.workspaceId)]
          )
        ).rows.map((r) => r.active_member_count)
      ).toEqual([1, 1])
      await client.query(
        "UPDATE public.organization SET name='edited' WHERE id=$1",
        [ids[1].workspaceId]
      )
      await expect(
        manageIntegrationFixtures(client, "cleanup", run)
      ).rejects.toThrow("ownership")
      expect(await count(ids.map((f) => f.workspaceId))).toBe(2) // first deletion rolled back too
      await client.query("UPDATE public.organization SET name=$2 WHERE id=$1", [
        ids[1].workspaceId,
        ids[1].name,
      ])
      await manageIntegrationFixtures(client, "cleanup", run)
      await manageIntegrationFixtures(client, "cleanup", run)
      expect(await count(ids.map((f) => f.workspaceId))).toBe(0)
      expect(await count(other.map((f) => f.workspaceId))).toBe(2)
      expect(
        (
          await client.query(
            'SELECT count(*)::int AS count FROM public."user" WHERE id=ANY($1::text[])',
            [ids.map((f) => f.userId)]
          )
        ).rows[0].count
      ).toBe(0)
    } finally {
      if (seeded) await manageIntegrationFixtures(client, "cleanup", run)
      if (sentinelSeeded)
        await manageIntegrationFixtures(client, "cleanup", sentinel)
      client.release()
      await pool.end()
    }
  }, 60_000)
})

// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import type { Actor } from "@/application/actor"
import type { ProfileCommand } from "@/lib/profile-contract"
import type * as Service from "./profiles.server"
import type * as Database from "@/db"

const file = process.env.FORGE_PROFILE_TEST_DATABASE_FILE
describe.skipIf(!file)("FOR-102 real PostgreSQL acceptance", () => {
  const marker = `for102-${randomUUID()}`,
    alice = `${marker}-alice`,
    bob = `${marker}-bob`
  const sessionA = `${marker}-a`,
    sessionB = `${marker}-b`
  let pool: Pool,
    service: typeof Service,
    database: typeof Database,
    verified = false
  const actor = (userId = alice, sessionId = sessionA): Actor => ({
    userId,
    workspaceId: marker,
    workspaceRole: "member",
    scopes: null,
    authentication: { kind: "session", sessionId },
  })
  async function command(
    patch: ProfileCommand["patch"] = { title: "Engineer" }
  ): Promise<ProfileCommand> {
    return {
      commandKey: randomUUID(),
      sessionId: sessionA,
      expectedWorkspaceId: marker,
      expectedRevision: (await service.readProfile(actor())).revision,
      patch,
    }
  }
  beforeAll(async () => {
    const { connection, applicationConnection } = JSON.parse(
      readFileSync(file!, "utf8")
    )
    // Reuse the existing isolated template acceptance database; no schema changes are needed.
    const target = {
      environment: "template-acceptance" as const,
      ...DATABASE_TARGETS["template-acceptance"],
    }
    assertMigrationTarget(connection, target)
    assertMigrationTarget(
      applicationConnection.replace("-pooler.", "."),
      target
    )
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: connection, max: 4 })
    const identity = (
      await pool.query(
        "SELECT current_database() database,current_setting('neon.branch_id',true) branch"
      )
    ).rows[0]
    if (
      identity.database !== target.database ||
      identity.branch !== target.branchId
    )
      throw new Error("Wrong isolated profile database")
    verified = true
    vi.stubEnv("DATABASE_URL", applicationConnection)
    vi.stubEnv("FORGE_PROFILE_EDITING_ENABLED", "true")
    database = await import("@/db")
    service = await import("./profiles.server")
    await pool.query(
      "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
      [marker]
    )
    for (const id of [alice, bob]) {
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [id, `${id}@example.test`]
      )
      await pool.query(
        "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,'member')",
        [randomUUID(), id, marker]
      )
    }
    for (const [id, userId] of [
      [sessionA, alice],
      [sessionB, alice],
      [bob, bob],
    ])
      await pool.query(
        "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
        [id, userId, marker]
      )
  }, 30000)
  afterAll(async () => {
    if (verified) {
      await pool.query(
        "DROP TRIGGER IF EXISTS for102_reject_audit ON command_audit_events"
      )
      await pool.query("DROP FUNCTION IF EXISTS for102_reject_audit()")
      await pool.query("DELETE FROM organization WHERE id=$1", [marker])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[alice, bob]])
      expect(
        (
          await pool.query(
            'SELECT (SELECT count(*)::int FROM "user" WHERE id=ANY($1)) users,(SELECT count(*)::int FROM command_receipts WHERE user_id=ANY($1)) receipts',
            [[alice, bob]]
          )
        ).rows[0]
      ).toEqual({ users: 0, receipts: 0 })
    }
    await database?.databaseClient.end()
    await pool?.end()
    vi.unstubAllEnvs()
  })
  it("AT-01: independent owner sessions read canonical normalized fields; another account retains its own profile", async () => {
    const before = await service.readProfile(actor(bob, bob))
    const input = await command({
      name: "  Alice Owner  ",
      title: "  Product engineer  ",
      username: `u_${randomUUID().slice(0, 8)}`,
    })
    expect((await service.patchProfile(actor(), input)).status).toBe("saved")
    expect(await service.readProfile(actor(alice, sessionB))).toMatchObject({
      name: "Alice Owner",
      title: "Product engineer",
      username: input.patch.username,
    })
    expect(await service.readProfile(actor(bob, bob))).toEqual(before)
  })
  it("AT-02: protected fields and another account ID are rejected atomically", async () => {
    const before = await service.readProfile(actor())
    for (const forbidden of [
      { userId: bob },
      { accountId: bob },
      { role: "owner" },
      { workspaceId: "other" },
      { emailVerified: true },
      { preferences: {} },
    ]) {
      await expect(
        service.patchProfile(actor(), {
          ...(await command()),
          ...forbidden,
        } as ProfileCommand)
      ).rejects.toThrow()
      await expect(
        service.patchProfile(actor(), {
          ...(await command()),
          patch: { title: "Forbidden mixed patch", ...forbidden },
        } as ProfileCommand)
      ).rejects.toThrow()
    }
    expect(await service.readProfile(actor())).toEqual(before)
    expect(
      (
        await pool.query(
          "SELECT role FROM member WHERE user_id=$1 AND organization_id=$2",
          [alice, marker]
        )
      ).rows[0].role
    ).toBe("member")
  })
  it("requires the originating session and workspace, and denies API/agent actors", async () => {
    const input = await command()
    await expect(
      service.patchProfile(actor(alice, sessionB), input)
    ).rejects.toThrow()
    await expect(
      service.patchProfile(actor(), { ...input, expectedWorkspaceId: "other" })
    ).rejects.toThrow()
    for (const authentication of [
      { kind: "apiKey", credentialId: "key" },
      { kind: "agent", runId: "run", tokenId: "token" },
    ] as const)
      await expect(
        service.patchProfile({ ...actor(), authentication }, input)
      ).rejects.toThrow()
  })
  it("serializes competing edits and exposes a stale-write conflict", async () => {
    const first = await command({ title: "Winner" }),
      second = {
        ...first,
        commandKey: randomUUID(),
        patch: { title: "Other winner" },
      }
    const results = await Promise.all([
      service.patchProfile(actor(), first),
      service.patchProfile(actor(), second),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(["conflict", "saved"])
    const stale = await service.patchProfile(actor(), {
      ...first,
      commandKey: randomUUID(),
      patch: { name: "Stale name", title: "Stale title" },
    })
    expect(stale.status).toBe("conflict")
    expect(stale.snapshot.name).toBe("Alice Owner")
  })
  it("replays a lost response once, rejects key reuse and keeps content out of audit/receipts/outbox", async () => {
    const input = await command({ title: "Private profile title" })
    const first = await service.patchProfile(actor(), input)
    expect(await service.patchProfile(actor(), input)).toEqual(first)
    await expect(
      service.patchProfile(actor(), { ...input, patch: { title: "Different" } })
    ).rejects.toThrow()
    const receipt = (
      await pool.query("SELECT * FROM command_receipts WHERE command_key=$1", [
        input.commandKey,
      ])
    ).rows
    expect(receipt).toHaveLength(1)
    expect(receipt[0].response_body).not.toContain("Private profile title")
    expect(
      (
        await pool.query(
          "SELECT * FROM command_audit_events WHERE command_id=$1",
          [receipt[0].id]
        )
      ).rows
    ).toHaveLength(1)
    expect(
      (
        await pool.query(
          "SELECT * FROM command_outbox_events WHERE command_id=$1",
          [receipt[0].id]
        )
      ).rows
    ).toHaveLength(0)
  })
  it("rolls profile and receipt back after audit failure, then retries once", async () => {
    const before = await service.readProfile(actor()),
      input = await command({ title: "Rollback title" })
    await pool.query(
      `CREATE FUNCTION for102_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='accountProfile.patch@1' THEN RAISE EXCEPTION 'FOR102 injected failure'; END IF; RETURN NEW; END $$`
    )
    await pool.query(
      "CREATE TRIGGER for102_reject_audit BEFORE INSERT ON command_audit_events FOR EACH ROW EXECUTE FUNCTION for102_reject_audit()"
    )
    try {
      await expect(service.patchProfile(actor(), input)).rejects.toThrow()
    } finally {
      await pool.query(
        "DROP TRIGGER for102_reject_audit ON command_audit_events"
      )
      await pool.query("DROP FUNCTION for102_reject_audit()")
    }
    expect(await service.readProfile(actor())).toEqual(before)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM command_receipts WHERE command_key=$1",
          [input.commandKey]
        )
      ).rows[0].count
    ).toBe(0)
    expect((await service.patchProfile(actor(), input)).status).toBe("saved")
  })
  it("rejects invalid avatars, accepts a bounded raster avatar, and persists removal", async () => {
    for (const image of [
      "https://example.test/avatar.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/png;base64,SGVsbG8=",
    ])
      await expect(
        service.patchProfile(actor(), await command({ image }))
      ).rejects.toThrow()
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII="
    await service.patchProfile(actor(), await command({ image }))
    expect((await service.readProfile(actor(alice, sessionB))).image).toBe(
      image
    )
    await service.patchProfile(actor(), await command({ image: null }))
    expect((await service.readProfile(actor(alice, sessionB))).image).toBeNull()
  })
  it("denies live-revoked session replay and reads", async () => {
    const input = await command()
    await service.patchProfile(actor(), input)
    await pool.query(
      "UPDATE session SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [sessionA]
    )
    try {
      await expect(service.patchProfile(actor(), input)).rejects.toThrow()
      await expect(service.readProfile(actor())).rejects.toThrow()
    } finally {
      await pool.query(
        "UPDATE session SET expires_at=now()+interval '1 day' WHERE id=$1",
        [sessionA]
      )
    }
  })
  it("denies both reads and writes with the gate off", async () => {
    const input = await command()
    vi.stubEnv("FORGE_PROFILE_EDITING_ENABLED", "false")
    try {
      await expect(service.patchProfile(actor(), input)).rejects.toThrow(
        "unavailable"
      )
      await expect(service.readProfile(actor())).rejects.toThrow("unavailable")
    } finally {
      vi.stubEnv("FORGE_PROFILE_EDITING_ENABLED", "true")
    }
  })
})

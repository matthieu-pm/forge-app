// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import type { AccountPreferenceCommand } from "@/lib/account-preference-contract"
import type { Actor } from "@/application/actor"
import type * as Preferences from "./preferences.server"
import type * as Database from "@/db"
import { emptyPreferenceSnapshot } from "@/lib/account-preference-contract"

const file = process.env.FORGE_PREFERENCE_TEST_DATABASE_FILE

describe.skipIf(!file)("FOR-127 real PostgreSQL acceptance", () => {
  const marker = `for127-${randomUUID()}`,
    alice = `${marker}-alice`,
    bob = `${marker}-bob`,
    workspace = marker,
    workspace2 = `${marker}-other`
  const sessionA = `${marker}-a`,
    sessionB = `${marker}-b`,
    sessionOther = `${marker}-bob-session`,
    sessionWorkspace2 = `${marker}-w2-session`
  let pool: Pool,
    service: typeof Preferences,
    database: typeof Database,
    verified = false
  const actor = (
    userId = alice,
    sessionId = sessionA,
    workspaceId = workspace
  ): Actor => ({
    userId,
    workspaceId,
    workspaceRole: "member",
    authentication: { kind: "session", sessionId },
    scopes: null,
  })
  function input(
    patch: Record<string, unknown>,
    expectedVersions: Record<string, number> = {},
    sessionId = sessionA
  ): AccountPreferenceCommand {
    return {
      sessionId,
      expectedWorkspaceId: workspace,
      commandKey: randomUUID(),
      version: 1,
      patch,
      expectedVersions: Object.fromEntries(
        Object.keys(patch).map((key) => [key, expectedVersions[key] ?? 0])
      ),
    }
  }
  beforeAll(async () => {
    const { connection, applicationConnection } = JSON.parse(
      readFileSync(file!, "utf8")
    )
    const target = {
      environment: "personal-preference-acceptance" as const,
      ...DATABASE_TARGETS["personal-preference-acceptance"],
    }
    assertMigrationTarget(connection, target)
    assertMigrationTarget(applicationConnection, target)
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: connection, max: 4 })
    const identity = (
      await pool.query(
        "SELECT current_database() AS database,current_setting('neon.branch_id',true) AS branch"
      )
    ).rows[0]
    if (
      identity.database !== target.database ||
      identity.branch !== target.branchId
    )
      throw new Error("Acceptance database identity mismatch")
    verified = true
    vi.stubEnv("DATABASE_URL", applicationConnection)
    vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", "true")
    database = await import("@/db")
    service = await import("./preferences.server")
    for (const id of [workspace, workspace2])
      await pool.query(
        "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
        [id]
      )
    for (const id of [alice, bob])
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [id, `${id}@example.test`]
      )
    for (const [userId, workspaceId] of [
      [alice, workspace],
      [alice, workspace2],
      [bob, workspace],
    ])
      await pool.query(
        "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,'member')",
        [randomUUID(), userId, workspaceId]
      )
    for (const [id, userId, workspaceId] of [
      [sessionA, alice, workspace],
      [sessionB, alice, workspace],
      [sessionOther, bob, workspace],
      [sessionWorkspace2, alice, workspace2],
    ])
      await pool.query(
        "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
        [id, userId, workspaceId]
      )
  }, 30000)
  afterAll(async () => {
    if (verified) {
      await pool.query(
        "DROP TRIGGER IF EXISTS for127_reject_audit ON command_audit_events"
      )
      await pool.query("DROP FUNCTION IF EXISTS for127_reject_audit()")
      await pool.query("DELETE FROM organization WHERE id=ANY($1)", [
        [workspace, workspace2],
      ])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[alice, bob]])
      const result = await pool.query(
        "SELECT (SELECT count(*)::int FROM account_preferences WHERE user_id=ANY($1)) preferences,(SELECT count(*)::int FROM command_receipts WHERE user_id=ANY($1)) receipts",
        [[alice, bob]]
      )
      expect(result.rows[0]).toEqual({ preferences: 0, receipts: 0 })
    }
    await database?.databaseClient.end()
    await pool?.end()
    vi.unstubAllEnvs()
  })
  it("AT-01: two owner sessions read all saved groups across workspaces; another account receives only its own defaults", async () => {
    expect(
      await service.readAccountPreferences(actor(bob, sessionOther))
    ).toEqual(emptyPreferenceSnapshot(bob))
    const saved = await service.patchAccountPreferences(
      actor(),
      input({
        "general.interfaceTheme": "dark",
        "calls.language": "fr",
        "reviews.codeTheme": "github-light",
        "notifications.updates.marketing": true,
        "agent.guidance": "Private",
      })
    )
    expect(saved.status).toBe("saved")
    const second = await service.readAccountPreferences(actor(alice, sessionB))
    expect(second.values).toMatchObject({
      "general.interfaceTheme": "dark",
      "calls.language": "fr",
      "agent.guidance": "Private",
    })
    expect(
      await service.readAccountPreferences(
        actor(alice, sessionWorkspace2, workspace2)
      )
    ).toEqual(second)
    expect(
      (await service.readAccountPreferences(actor(bob, sessionOther))).values
    ).toEqual({})
  })
  it("AT-02: concurrent independent fields survive; stale same-field patches visibly conflict without partial mutation", async () => {
    const [a, b] = await Promise.all([
      service.patchAccountPreferences(
        actor(),
        input({ "general.pointerCursors": true })
      ),
      service.patchAccountPreferences(
        actor(alice, sessionB),
        input({ "calls.timestamps": false }, {}, sessionB)
      ),
    ])
    expect([a.status, b.status]).toEqual(["saved", "saved"])
    const current = await service.readAccountPreferences(actor())
    expect(current.values).toMatchObject({
      "general.pointerCursors": true,
      "calls.timestamps": false,
    })
    const conflict = await service.patchAccountPreferences(
      actor(),
      input({ "general.pointerCursors": false, "calls.speakerLabels": false })
    )
    expect(conflict.status).toBe("conflict")
    if (conflict.status === "conflict")
      expect(conflict.fields).toEqual(["general.pointerCursors"])
    expect(
      (await service.readAccountPreferences(actor())).values
    ).not.toHaveProperty("calls.speakerLabels")
  })
  it("races same-field versions: exactly one succeeds", async () => {
    const results = await Promise.all([
      service.patchAccountPreferences(
        actor(),
        input({ "general.fontSize": "large" })
      ),
      service.patchAccountPreferences(
        actor(alice, sessionB),
        input({ "general.fontSize": "small" }, {}, sessionB)
      ),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(["conflict", "saved"])
  })
  it("AT-03: lost-response replay in another owner session creates one effect and stores no private values in audit/outbox/receipt", async () => {
    const command = input(
      { "agent.guidance": "Receipt secret" },
      { "agent.guidance": 1 }
    )
    const first = await service.patchAccountPreferences(actor(), command)
    const replay = await service.patchAccountPreferences(
      actor(alice, sessionB),
      { ...command, sessionId: sessionB }
    )
    expect(replay).toEqual(first)
    const rows = (
      await pool.query(
        "SELECT r.response_body,(SELECT count(*)::int FROM command_audit_events a WHERE a.command_id=r.id) audit,(SELECT count(*)::int FROM command_outbox_events o WHERE o.command_id=r.id) outbox FROM command_receipts r WHERE r.command_key=$1",
        [command.commandKey]
      )
    ).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ audit: 1, outbox: 0 })
    expect(rows[0].response_body).not.toContain("Receipt secret")
    await expect(
      service.patchAccountPreferences(actor(), {
        ...command,
        patch: { "agent.guidance": "changed" },
      })
    ).rejects.toMatchObject({ reason: "reused" })
  })
  it("rejects arbitrary owners, protected fields and stale-login queue delivery before writing", async () => {
    await expect(
      service.patchAccountPreferences(
        actor(bob, sessionOther),
        input({ "agent.guidance": "Wrong account" })
      )
    ).rejects.toThrow()
    await expect(
      service.patchAccountPreferences(actor(), {
        ...input({ "general.interfaceTheme": "light" }),
        userId: bob,
      } as AccountPreferenceCommand)
    ).rejects.toThrow()
    await expect(
      service.patchAccountPreferences(
        actor(),
        input({ "workspace.role": "owner" })
      )
    ).rejects.toThrow()
    await expect(
      service.readAccountPreferences({
        ...actor(),
        authentication: { kind: "apiKey", credentialId: "fake" },
      })
    ).rejects.toThrow()
    expect(
      (await service.readAccountPreferences(actor(bob, sessionOther))).values
    ).toEqual({})
  })
  it("rechecks revoked sessions before replay and leaves the effect untouched", async () => {
    const command = input({ "reviews.startOnToolOpen": false })
    await service.patchAccountPreferences(actor(), command)
    await pool.query(
      "UPDATE session SET expires_at=now()-interval '1 second' WHERE id=$1",
      [sessionA]
    )
    await expect(
      service.patchAccountPreferences(actor(), command)
    ).rejects.toThrow()
    expect(
      (await service.readAccountPreferences(actor(alice, sessionB))).values[
        "reviews.startOnToolOpen"
      ]
    ).toBe(false)
    await pool.query(
      "UPDATE session SET expires_at=now()+interval '1 day' WHERE id=$1",
      [sessionA]
    )
  })
  it("rolls back preference values and receipt when audit fails after the business mutation", async () => {
    const previous = await service.readAccountPreferences(actor())
    await pool.query(
      "CREATE FUNCTION for127_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FOR127 injected audit failure'; END $$"
    )
    await pool.query(
      "CREATE TRIGGER for127_reject_audit BEFORE INSERT ON command_audit_events FOR EACH ROW EXECUTE FUNCTION for127_reject_audit()"
    )
    const command = input({ "calls.actionItems": false })
    try {
      await expect(
        service.patchAccountPreferences(actor(), command)
      ).rejects.toThrow()
    } finally {
      await pool.query(
        "DROP TRIGGER for127_reject_audit ON command_audit_events"
      )
      await pool.query("DROP FUNCTION for127_reject_audit()")
    }
    expect(await service.readAccountPreferences(actor())).toEqual(previous)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE command_key=$1",
          [command.commandKey]
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (await service.patchAccountPreferences(actor(), command)).status
    ).toBe("saved")
  })
  it("preserves unknown values and refuses a future schema version", async () => {
    await pool.query(
      "UPDATE account_preferences SET values=values || $2::jsonb WHERE user_id=$1",
      [alice, JSON.stringify({ futureSetting: { preserve: true } })]
    )
    await service.patchAccountPreferences(
      actor(),
      input({ "calls.decisions": false })
    )
    expect(
      (await service.readAccountPreferences(actor())).values.futureSetting
    ).toEqual({ preserve: true })
    await pool.query(
      "UPDATE account_preferences SET version=2 WHERE user_id=$1",
      [alice]
    )
    await expect(
      service.patchAccountPreferences(
        actor(),
        input({ "calls.generateSummary": false })
      )
    ).rejects.toThrow("newer version")
    expect(
      (
        await pool.query(
          "SELECT version FROM account_preferences WHERE user_id=$1",
          [alice]
        )
      ).rows[0].version
    ).toBe(2)
    await pool.query(
      "UPDATE account_preferences SET version=1 WHERE user_id=$1",
      [alice]
    )
  })
  it("workspace choices follow only the same account and workspace", async () => {
    const command = {
      ...input({
        "inbox.main.preferences.ordering": "oldest",
        "myIssues.main.display.layout": "board",
        "reviews.main.display.groupBy": "repository",
        "projects.main.sidebar": true,
        "initiatives.main.sidebar": true,
        "teamIssues.team-a.favorite": true,
        "cycles.cycle-a.favorite": true,
        "directory.main.descending": true,
        "teamHome.team-a.collapsedSectionIds": ["section-a"],
      }),
      scope: "workspace" as const,
    }
    const saved = await service.patchAccountPreferences(actor(), command)
    expect(saved.status).toBe("saved")
    const owner = await service.readAccountPreferences(
      actor(alice, sessionB),
      "workspace"
    )
    expect(owner.workspaceId).toBe(workspace)
    expect(owner.values).toMatchObject(command.patch)
    expect(
      (
        await service.readAccountPreferences(
          actor(alice, sessionWorkspace2, workspace2),
          "workspace"
        )
      ).values
    ).toEqual({})
    expect(
      (
        await service.readAccountPreferences(
          actor(bob, sessionOther),
          "workspace"
        )
      ).values
    ).toEqual({})
    expect(
      (await service.readAccountPreferences(actor())).values
    ).not.toHaveProperty("inbox.main.preferences.ordering")
  })
  it("rejects a queued workspace write after the same session switches active workspace", async () => {
    const command = {
      ...input({ "inbox.main.unreadOnly": true }),
      scope: "workspace" as const,
      expectedWorkspaceId: workspace,
    }
    await pool.query(
      "UPDATE session SET active_organization_id=$2 WHERE id=$1",
      [sessionA, workspace2]
    )
    try {
      await expect(
        service.patchAccountPreferences(
          actor(alice, sessionA, workspace2),
          command
        )
      ).rejects.toThrow()
    } finally {
      await pool.query(
        "UPDATE session SET active_organization_id=$2 WHERE id=$1",
        [sessionA, workspace]
      )
    }
    expect(
      (
        await service.readAccountPreferences(
          actor(alice, sessionWorkspace2, workspace2),
          "workspace"
        )
      ).values
    ).toEqual({})
  })
  it("workspace field races preserve independent edits and deny account fields, policy and business records", async () => {
    const results = await Promise.all([
      service.patchAccountPreferences(actor(), {
        ...input({ "inbox.main.unreadOnly": true }),
        scope: "workspace",
      }),
      service.patchAccountPreferences(actor(alice, sessionB), {
        ...input({ "projects.main.descending": true }, {}, sessionB),
        scope: "workspace",
      }),
    ])
    expect(results.map((result) => result.status)).toEqual(["saved", "saved"])
    const conflict = await service.patchAccountPreferences(actor(), {
      ...input({ "inbox.main.unreadOnly": false }),
      scope: "workspace",
    })
    expect(conflict.status).toBe("conflict")
    for (const patch of [
      { "general.interfaceTheme": "dark" },
      { "teamIssues.team-a.issues": [] },
      { "teamIssues.team-a.role": "owner" },
      { "workspace.policy": "all" },
    ])
      await expect(
        service.patchAccountPreferences(actor(), {
          ...input(patch),
          scope: "workspace",
        })
      ).rejects.toThrow()
  })
  it("denies reads and writes while the feature gate is off", async () => {
    vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", "false")
    await expect(service.readAccountPreferences(actor())).rejects.toThrow(
      "unavailable"
    )
    await expect(
      service.patchAccountPreferences(
        actor(),
        input({ "calls.generateSummary": false })
      )
    ).rejects.toThrow("unavailable")
    vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", "true")
  })
})

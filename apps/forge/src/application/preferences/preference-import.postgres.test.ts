// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type * as ImportService from "./preference-import.server"
import type * as Preferences from "./preferences.server"
import type { Actor } from "@/application/actor"
import type { PreferenceImportPlan } from "@/lib/preference-import-contract"
import { emptyPreferenceSnapshot } from "@/lib/account-preference-contract"
import { preferenceSourceFingerprint } from "@/lib/preference-import-contract"

const connection = process.env.FORGE_PREF_IMPORT_TEST_DATABASE_URL
const database = vi.hoisted(() => ({ pool: null as Pool | null }))
vi.mock("@/db", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres")
  const schema = {
    ...(await import("@/db/schema")),
    ...(await import("@/db/auth-schema")),
    ...(await import("@/db/planning-schema")),
    ...(await import("@/db/loops-schema")),
    ...(await import("@/db/jobs-schema")),
    ...(await import("@/db/sla-schema")),
    ...(await import("@/db/resources-schema")),
  }
  return { ...schema, db: drizzle(database.pool!, { schema }) }
})
describe.skipIf(!connection)("FOR-144 local PostgreSQL acceptance", () => {
  const userId = `for144-${randomUUID()}`,
    workspaceId = userId,
    sessionId = `${userId}-session`,
    otherId = `${userId}-other`
  let service: typeof ImportService
  let preferences: typeof Preferences
  const identity = { userId, workspaceId, sessionId }
  const actor: Actor = {
    userId,
    workspaceId,
    workspaceRole: "member",
    scopes: null,
    authentication: { kind: "session", sessionId },
  }
  async function plan(
    raw = '{"interfaceTheme":"dark","fontSize":"large"}'
  ): Promise<PreferenceImportPlan> {
    const source = {
      location: "local" as const,
      key: "forge.personal-preferences",
      raw,
    }
    const { inspectPreferenceSource } =
      await import("@/lib/preference-import-contract")
    return {
      id: randomUUID(),
      identity,
      source,
      fingerprint: await preferenceSourceFingerprint(source),
      ownershipConfirmed: true,
      snapshot: await preferences.readAccountPreferences(actor),
      choices: Object.fromEntries(
        Object.keys(inspectPreferenceSource(source, userId).fields).map(
          (path) => [path, "import" as const]
        )
      ),
    }
  }
  const step = (input: PreferenceImportPlan, path: string) =>
    service.applyPreferenceImportField(actor, {
      identity,
      id: input.id,
      fingerprint: input.fingerprint,
      path,
    })
  beforeAll(async () => {
    const url = new URL(connection!)
    if (
      url.hostname !== "127.0.0.1" ||
      url.port !== "55444" ||
      url.pathname !== "/for144_acceptance"
    )
      throw new Error("Only the isolated local FOR-144 database is allowed.")
    database.pool = new Pool({ connectionString: connection, max: 8 })
    expect(
      (await database.pool.query("select current_database() as name")).rows[0]
        .name
    ).toBe("for144_acceptance")
    const journal = JSON.parse(
      readFileSync(
        new URL("../../../drizzle/meta/_journal.json", import.meta.url),
        "utf8"
      )
    )
    await database.pool.query(
      "CREATE TABLE IF NOT EXISTS for144_test_migrations (tag text PRIMARY KEY)"
    )
    const migrationClient = await database.pool.connect()
    try {
      for (const migration of journal.entries) {
        if (
          (
            await migrationClient.query(
              "select tag from for144_test_migrations where tag=$1",
              [migration.tag]
            )
          ).rowCount
        )
          continue
        await migrationClient.query("BEGIN")
        try {
          await migrationClient.query(
            readFileSync(
              new URL(`../../../drizzle/${migration.tag}.sql`, import.meta.url),
              "utf8"
            )
          )
          await migrationClient.query(
            "insert into for144_test_migrations(tag) values($1)",
            [migration.tag]
          )
          await migrationClient.query("COMMIT")
        } catch (error) {
          await migrationClient.query("ROLLBACK")
          throw error
        }
      }
    } finally {
      migrationClient.release()
    }
    vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", "true")
    vi.stubEnv(
      "FORGE_FEATURE_ROLLOUTS",
      JSON.stringify({
        personalPreferenceImport: {
          mode: "enabled",
          workspaceIds: [workspaceId],
        },
      })
    )
    service = await import("./preference-import.server")
    preferences = await import("./preferences.server")
    await database.pool.query(
      "insert into organization(id,name,slug) values($1,$1,$1)",
      [workspaceId]
    )
    for (const id of [userId, otherId]) {
      await database.pool.query(
        'insert into "user"(id,name,email,email_verified) values($1,$1,$2,true)',
        [id, `${id}@example.test`]
      )
      await database.pool.query(
        "insert into member(id,user_id,organization_id,role) values($1,$2,$3,'member')",
        [randomUUID(), id, workspaceId]
      )
      await database.pool.query(
        "insert into session(id,token,user_id,active_organization_id,expires_at) values($1,$1,$2,$3,now()+interval '1 day')",
        [id === userId ? sessionId : `${otherId}-session`, id, workspaceId]
      )
    }
  }, 60000)
  afterAll(async () => {
    if (database.pool) {
      await database.pool.query(
        "DROP TRIGGER IF EXISTS for144_reject_checkpoint ON personal_preference_imports"
      )
      await database.pool.query(
        "DROP FUNCTION IF EXISTS for144_reject_checkpoint()"
      )
      await database.pool.query("delete from organization where id=$1", [
        workspaceId,
      ])
      await database.pool.query('delete from "user" where id=any($1)', [
        [userId, otherId],
      ])
      await database.pool.end()
    }
    vi.unstubAllEnvs()
  })
  it("AC-01: preview is read-only; confirmation saves a private recoverable source before changing account fields", async () => {
    const before = await preferences.readAccountPreferences(actor)
    const loaded = await service.loadPreferenceImports(actor, identity)
    expect(loaded.status).toBe("ready")
    expect(await preferences.readAccountPreferences(actor)).toEqual(before)
    const input = await plan()
    const result = await service.preparePreferenceImport(actor, input)
    expect(result.plan.source.raw).toBe(input.source.raw)
    expect(result.fields).toEqual({
      "general.interfaceTheme": "pending",
      "general.fontSize": "pending",
    })
    expect(await preferences.readAccountPreferences(actor)).toEqual(before)
    await expect(
      service.preparePreferenceImport(actor, {
        ...input,
        id: randomUUID(),
        ownershipConfirmed: false,
      } as unknown as PreferenceImportPlan)
    ).rejects.toThrow()
  })
  it("AC-02: interruption resumes without replaying committed fields; concurrent changes conflict while remaining fields commit", async () => {
    const input = await plan()
    await service.preparePreferenceImport(actor, input)
    const first = await step(input, "general.interfaceTheme")
    expect(first.fields["general.interfaceTheme"]).toBe("saved")
    const saved = await preferences.readAccountPreferences(actor)
    await preferences.patchAccountPreferences(actor, {
      sessionId,
      expectedWorkspaceId: workspaceId,
      commandKey: randomUUID(),
      version: 1,
      patch: { "general.fontSize": "small" },
      expectedVersions: {
        "general.fontSize": saved.fieldVersions["general.fontSize"] ?? 0,
      },
    })
    const afterEdit = await preferences.readAccountPreferences(actor)
    await step(input, "general.interfaceTheme")
    expect(await preferences.readAccountPreferences(actor)).toEqual(afterEdit)
    const result = await step(input, "general.fontSize")
    expect(result.fields).toEqual({
      "general.interfaceTheme": "saved",
      "general.fontSize": "conflict",
    })
    expect(
      (await preferences.readAccountPreferences(actor)).values[
        "general.fontSize"
      ]
    ).toBe("small")
    const calls = await plan()
    calls.source = {
      location: "local",
      key: `forge:calls-and-transcripts:v1:${userId}`,
      raw: '{"language":"fr","summaryDetail":"detailed"}',
    }
    calls.fingerprint = await preferenceSourceFingerprint(calls.source)
    calls.choices = {
      "calls.language": "import",
      "calls.summaryDetail": "import",
    }
    await service.preparePreferenceImport(actor, calls)
    await step(calls, "calls.language")
    await step(calls, "calls.summaryDetail")
    expect(
      (await preferences.readAccountPreferences(actor)).values
    ).toMatchObject({
      "calls.language": "fr",
      "calls.summaryDetail": "detailed",
    })
  })
  it("atomic checkpoints roll back the field write on failure, and simultaneous retries produce one revision", async () => {
    const input = await plan('{"underlineLinks":true}')
    await service.preparePreferenceImport(actor, input)
    const before = await preferences.readAccountPreferences(actor)
    await database.pool!.query(
      "CREATE FUNCTION for144_reject_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'checkpoint failure'; END $$"
    )
    await database.pool!.query(
      "CREATE TRIGGER for144_reject_checkpoint BEFORE UPDATE ON personal_preference_imports FOR EACH ROW EXECUTE FUNCTION for144_reject_checkpoint()"
    )
    await expect(step(input, "general.underlineLinks")).rejects.toThrow()
    expect(await preferences.readAccountPreferences(actor)).toEqual(before)
    await database.pool!.query(
      "DROP TRIGGER for144_reject_checkpoint ON personal_preference_imports"
    )
    await database.pool!.query("DROP FUNCTION for144_reject_checkpoint()")
    await Promise.all([
      step(input, "general.underlineLinks"),
      step(input, "general.underlineLinks"),
    ])
    expect((await preferences.readAccountPreferences(actor)).revision).toBe(
      before.revision + 1
    )
  })
  it("AC-03: corrupt/future sources and changed fingerprints are rejected without a preference write", async () => {
    const before = await preferences.readAccountPreferences(actor)
    const input = await plan()
    await expect(
      service.preparePreferenceImport(actor, {
        ...input,
        fingerprint: "0".repeat(64),
      })
    ).rejects.toThrow(/fingerprint/)
    for (const raw of [
      "{corrupt",
      '{"version":2,"values":{"interfaceTheme":"light"}}',
    ])
      await expect(
        service.preparePreferenceImport(actor, {
          ...input,
          id: randomUUID(),
          source: { ...input.source, raw },
        })
      ).rejects.toThrow()
    expect(await preferences.readAccountPreferences(actor)).toEqual(before)
  })
  it("preserves kept fields, protects absent fields and imports Notifications independently", async () => {
    const input = await plan('{"pointerCursors":true,"fontSize":"large"}')
    input.choices["general.fontSize"] = "keep"
    await service.preparePreferenceImport(actor, input)
    await step(input, "general.fontSize")
    await preferences.patchAccountPreferences(actor, {
      sessionId,
      commandKey: randomUUID(),
      version: 1,
      patch: { "general.pointerCursors": false },
      expectedVersions: { "general.pointerCursors": 0 },
    })
    const result = await step(input, "general.pointerCursors")
    expect(result.fields).toEqual({
      "general.pointerCursors": "conflict",
      "general.fontSize": "kept",
    })
    const notification = await plan()
    notification.source = {
      location: "session",
      key: `forge:notifications:v1:${userId}`,
      raw: '{"updates":{"marketing":true}}',
    }
    notification.fingerprint = await preferenceSourceFingerprint(
      notification.source
    )
    notification.choices = { "notifications.updates.marketing": "import" }
    await service.preparePreferenceImport(actor, notification)
    await step(notification, "notifications.updates.marketing")
    expect(
      (await preferences.readAccountPreferences(actor)).values[
        "notifications.updates.marketing"
      ]
    ).toBe(true)
  })
  it("retries preparation after a lost response and a new session, without replacing its manifest", async () => {
    const input = await plan('{"checkSpelling":false}')
    await service.preparePreferenceImport(actor, input)
    const nextSession = `${sessionId}-new`
    await database.pool!.query(
      "insert into session(id,token,user_id,active_organization_id,expires_at) values($1,$1,$2,$3,now()+interval '1 day')",
      [nextSession, userId, workspaceId]
    )
    const nextActor = {
      ...actor,
      authentication: { kind: "session" as const, sessionId: nextSession },
    }
    expect(
      (
        await service.preparePreferenceImport(nextActor, {
          ...input,
          identity: { ...identity, sessionId: nextSession },
        })
      ).plan.id
    ).toBe(input.id)
    await expect(
      service.preparePreferenceImport(actor, {
        ...input,
        choices: { "general.checkSpelling": "keep" },
      })
    ).rejects.toThrow()
  })
  it("stores only imported field baselines and keeps source bodies outside checkpoint metadata", async () => {
    const input = await plan('{"fontSize":"large"}')
    input.snapshot.values["agent.guidance"] = "Unrelated private agent guidance"
    input.snapshot.fieldVersions["agent.guidance"] = 99
    const result = await service.preparePreferenceImport(actor, input)
    expect(result.plan.snapshot.values).toEqual({
      "general.fontSize": input.snapshot.values["general.fontSize"],
    })
    expect(result.plan.snapshot.fieldVersions).not.toHaveProperty(
      "agent.guidance"
    )
    const stored = (
      await database.pool!.query(
        "select manifest from personal_preference_imports where id=$1",
        [input.id]
      )
    ).rows[0].manifest
    expect(stored.plan.source).not.toHaveProperty("raw")
    expect(stored.plan.snapshot).not.toHaveProperty("values")
    expect(JSON.stringify(stored)).not.toContain(
      "Unrelated private agent guidance"
    )
    expect(result.plan.source.raw).toBe(input.source.raw)
  })
  it("migrates an older manifest without retaining unrelated account choices in metadata or content", async () => {
    const input = await plan('{"fontSize":"large"}')
    input.snapshot.values["agent.guidance"] = "Unrelated private agent guidance"
    input.snapshot.fieldVersions["agent.guidance"] = 99
    await database.pool!.query(
      "insert into personal_preference_imports(id,user_id,workspace_id,manifest) values($1,$2,$3,$4)",
      [
        input.id,
        userId,
        workspaceId,
        JSON.stringify({
          plan: input,
          fields: { "general.fontSize": "pending" },
        }),
      ]
    )
    const { identity: _identity, ...durable } = input
    const { executeCommand } =
      await import("@/application/commands/execute-command.server")
    await executeCommand({
      actor,
      commandKey: input.id,
      operation: "personalPreferenceImport.prepare@1",
      input: durable,
      status: 200,
      parse: (value) => value as { id: string },
      authorize: () => Promise.resolve(),
      run: () =>
        Promise.resolve({
          value: { id: input.id },
          resource: { type: "personalPreferenceImport", id: input.id },
          events: [],
        }),
    })
    const migration = readFileSync(
      new URL(
        "../../../drizzle/0074_preference_import_content.sql",
        import.meta.url
      ),
      "utf8"
    )
    const backfill = migration.slice(
      migration.indexOf('INSERT INTO "personal_preference_import_content"')
    )
    await database.pool!.query(backfill)
    await database.pool!.query(backfill)
    const stored = (
      await database.pool!.query(
        "select manifest from personal_preference_imports where id=$1",
        [input.id]
      )
    ).rows[0].manifest
    const content = (
      await database.pool!.query(
        "select source,baseline from personal_preference_import_content where import_id=$1",
        [input.id]
      )
    ).rows[0]
    expect(stored.plan.source).not.toHaveProperty("raw")
    expect(stored.plan.snapshot).not.toHaveProperty("values")
    expect(content.source.raw).toBe(input.source.raw)
    expect(content.baseline).toEqual(
      Object.fromEntries(
        Object.entries(input.snapshot.values).filter(
          ([path]) => path === "general.fontSize"
        )
      )
    )
    expect(JSON.stringify({ stored, content })).not.toContain(
      "Unrelated private agent guidance"
    )
    const replay = await service.preparePreferenceImport(actor, input)
    expect(replay.plan.id).toBe(input.id)
    expect(replay.plan.snapshot.values).not.toHaveProperty("agent.guidance")
  })
  it("fences authoritative saved sources during preparation and each resumed field", async () => {
    const input = await plan('{"checkSpelling":true}')
    input.source.location = "saved"
    input.fingerprint = await preferenceSourceFingerprint(input.source)
    await database.pool!.query(
      "insert into product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) values($1,$2,$3,$4,$5)",
      [
        workspaceId,
        `user:${userId}`,
        userId,
        input.source.key,
        JSON.stringify("{}"),
      ]
    )
    const before = await preferences.readAccountPreferences(actor)
    await expect(service.preparePreferenceImport(actor, input)).rejects.toThrow(
      /source changed/i
    )
    await database.pool!.query(
      "update product_state set encoded_value=$1 where workspace_id=$2 and key=$3",
      [JSON.stringify(input.source.raw), workspaceId, input.source.key]
    )
    await service.preparePreferenceImport(actor, input)
    await database.pool!.query(
      "update product_state set encoded_value=$1 where workspace_id=$2 and key=$3",
      [JSON.stringify("{}"), workspaceId, input.source.key]
    )
    await expect(step(input, "general.checkSpelling")).rejects.toThrow(
      /source changed/i
    )
    expect(await preferences.readAccountPreferences(actor)).toEqual(before)
    await database.pool!.query(
      "delete from product_state where workspace_id=$1 and key=$2",
      [workspaceId, input.source.key]
    )
    await expect(step(input, "general.checkSpelling")).rejects.toThrow(
      /source changed/i
    )
  })
  it("verifies saved recovery wrappers under the current owner and retains committed checkpoints after source changes", async () => {
    const input = await plan('{"convertEmoticons":true}')
    input.source.location = "saved"
    const key = `forge:legacy-conflict:v1:${randomUUID()}`
    const raw = JSON.stringify({
      key: input.source.key,
      value: input.source.raw,
    })
    input.source.recovery = { key, raw }
    input.fingerprint = await preferenceSourceFingerprint(input.source)
    for (const owner of [otherId, userId]) {
      await database.pool!.query(
        "insert into product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) values($1,$2,$3,$4,$5)",
        [workspaceId, `user:${owner}`, owner, key, JSON.stringify(raw)]
      )
      if (owner === otherId)
        await expect(
          service.preparePreferenceImport(actor, input)
        ).rejects.toThrow(/source changed/i)
    }
    await service.preparePreferenceImport(actor, input)
    await database.pool!.query(
      "update product_state set encoded_value=$1 where workspace_id=$2 and key=$3 and owner_user_id=$4",
      [JSON.stringify("{}"), workspaceId, key, otherId]
    )
    const checkpoint = await step(input, "general.convertEmoticons")
    expect(checkpoint.fields["general.convertEmoticons"]).toBe("saved")
    const after = await preferences.readAccountPreferences(actor)
    await database.pool!.query(
      "update product_state set encoded_value=$1 where workspace_id=$2 and key=$3 and owner_user_id=$4",
      [JSON.stringify("{}"), workspaceId, key, userId]
    )
    await expect(step(input, "general.convertEmoticons")).rejects.toThrow(
      /source changed/i
    )
    expect(await preferences.readAccountPreferences(actor)).toEqual(after)
    const loaded = await service.loadPreferenceImports(actor, identity)
    expect(
      loaded.status === "ready" &&
        loaded.manifests.find((item) => item.plan.id === input.id)?.plan.source
          .recovery?.raw
    ).toBe(raw)
  })
  it("rejects cross-account, stale session, fingerprint mismatches, revoked membership and disabled direct writes", async () => {
    const input = await plan('{"convertEmoticons":true}')
    await service.preparePreferenceImport(actor, input)
    const otherIdentity = {
      ...identity,
      userId: otherId,
      sessionId: `${otherId}-session`,
    }
    const otherActor = {
      ...actor,
      userId: otherId,
      authentication: {
        kind: "session" as const,
        sessionId: otherIdentity.sessionId,
      },
    }
    await expect(
      service.applyPreferenceImportField(otherActor, {
        identity: otherIdentity,
        id: input.id,
        fingerprint: input.fingerprint,
        path: "general.convertEmoticons",
      })
    ).rejects.toThrow()
    expect(
      (await service.loadPreferenceImports(otherActor, otherIdentity)).status
    ).toBe("ready")
    await expect(
      service.loadPreferenceImports(actor, { ...identity, sessionId: "stale" })
    ).rejects.toThrow()
    await expect(
      service.applyPreferenceImportField(actor, {
        identity,
        id: input.id,
        fingerprint: "0".repeat(64),
        path: "general.convertEmoticons",
      })
    ).rejects.toThrow()
    vi.stubEnv("FORGE_FEATURE_ROLLOUTS", "{}")
    expect(await service.loadPreferenceImports(actor, identity)).toEqual({
      status: "disabled",
    })
    await expect(step(input, "general.convertEmoticons")).rejects.toThrow()
    vi.stubEnv(
      "FORGE_FEATURE_ROLLOUTS",
      JSON.stringify({
        personalPreferenceImport: {
          mode: "enabled",
          workspaceIds: [workspaceId],
        },
      })
    )
    await database.pool!.query("delete from member where user_id=$1", [userId])
    await expect(step(input, "general.convertEmoticons")).rejects.toThrow()
    expect(await preferences.readAccountPreferences(otherActor)).toEqual(
      emptyPreferenceSnapshot(otherId)
    )
    const audit = await database.pool!.query(
      "select response_body from command_receipts where user_id=$1 and operation like 'personalPreferenceImport.%'",
      [userId]
    )
    expect(
      audit.rows.every(
        (row) => Object.keys(JSON.parse(row.response_body)).join() === "id"
      )
    ).toBe(true)
  })
})

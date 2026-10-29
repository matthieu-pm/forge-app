// @vitest-environment node
import { randomUUID } from "node:crypto"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { schemaIsReady } from "../operations/readiness-schema"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import { subscriptionAccess } from "../billing/subscription-access"
import type { Actor } from "../actor"
import type * as Teams from "./teams.server"
import type * as Database from "@/db"

const connection = process.env.FORGE_TEAM_CAPACITY_TEST_DATABASE_URL
describe.skipIf(!connection)("atomic PostgreSQL team capacity", () => {
  const marker = `team-capacity-${randomUUID()}`,
    workspaces: Array<string> = [],
    users: Array<string> = []
  let pool: Pool, app: typeof Teams, database: typeof Database
  const cleanup: { pool?: Pool; database?: typeof Database } = {}
  beforeAll(async () => {
    const target = {
      environment: "staging" as const,
      ...DATABASE_TARGETS.staging,
    }
    assertMigrationTarget(connection!, target)
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: connection, max: 8 })
    cleanup.pool = pool
    const identity = await pool.query(
      "SELECT current_database() AS database,current_setting('neon.branch_id',true) AS branch"
    )
    expect(identity.rows[0]).toEqual({
      database: target.database,
      branch: target.branchId,
    })
    expect(await schemaIsReady(pool)).toBe(true)
    vi.stubEnv("DATABASE_URL", connection)
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3098")
    vi.stubEnv(
      "BETTER_AUTH_SECRET",
      "team-capacity-isolated-fixture-secret-for-auth-only"
    )
    vi.stubEnv(
      "FORGE_INVITE_LINK_SECRET",
      "team-capacity-fixture-invite-signing-secret-only"
    )
    vi.stubEnv("PUBLIC_API_ENABLED", "true")
    database = await import("@/db")
    cleanup.database = database
    app = await import("./teams.server")
  }, 30_000)
  afterAll(async () => {
    try {
      if (cleanup.pool && workspaces.length) {
        expect(workspaces.every((x) => x.startsWith(marker))).toBe(true)
        await pool.query("DELETE FROM organization WHERE id=ANY($1::text[])", [
          workspaces,
        ])
        await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users])
      }
    } finally {
      if (cleanup.database) await cleanup.database.db.$client.end()
      if (cleanup.pool) await cleanup.pool.end()
      vi.unstubAllEnvs()
    }
  }, 30_000)
  async function workspace(plan = "free") {
    const id = `${marker}-${workspaces.length}`,
      owner = `${id}-owner`
    workspaces.push(id)
    users.push(owner)
    await pool.query(
      "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
      [id]
    )
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
      [owner, owner + "@example.test"]
    )
    await pool.query(
      "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
      [randomUUID(), id, owner]
    )
    await pool.query(
      "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,$2,'active')",
      [id, plan]
    )
    const actor: Actor = {
      workspaceId: id,
      userId: owner,
      workspaceRole: "owner",
      scopes: null,
      authentication: { kind: "session", sessionId: "fixture" },
    }
    return { id, owner, actor }
  }
  function input(n: number) {
    return {
      name: `Team ${n}`,
      identifier: `T${n}`,
      icon: {
        kind: "icon" as const,
        value: "UserGroup03Icon",
        color: "#818cf8" as const,
      },
      timezone: "Europe/Paris",
    }
  }
  async function count(id: string) {
    return (
      await pool.query(
        "SELECT (SELECT count(*)::int FROM teams WHERE workspace_id=$1 AND deleted_at IS NULL) AS actual,(SELECT active_team_count FROM workspace_team_capacity WHERE workspace_id=$1) AS tracked",
        [id]
      )
    ).rows[0]
  }
  async function rawTeam(
    f: Awaited<ReturnType<typeof workspace>>,
    n: number,
    archived = false,
    visibility = "workspace"
  ) {
    return (
      await pool.query(
        "INSERT INTO teams(workspace_id,name,slug,identifier,icon_kind,icon_value,color,timezone,created_by_user_id,deleted_at,visibility) VALUES($1,$2,$3,$4,'icon','UserGroup03Icon','#818cf8','Europe/Paris',$5,$6,$7) RETURNING id,slug",
        [
          f.id,
          `Team ${n}`,
          `team-${n}`,
          `T${n}`,
          f.owner,
          archived ? new Date() : null,
          visibility,
        ]
      )
    ).rows[0] as { id: string; slug: string }
  }
  it.each([
    ["free", 2],
    ["basic", 5],
  ] as const)(
    "enforces %s's final slot across concurrent commands with no partial memberships",
    async (plan, limit) => {
      const f = await workspace(plan)
      for (let n = 0; n < limit - 1; n++)
        expect((await app.createTeam(f.actor, input(n))).ok).toBe(true)
      const results = await Promise.all([
        app.createTeam(f.actor, input(10)),
        app.createTeam(f.actor, input(11)),
      ])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.find((r) => !r.ok)).toMatchObject({ code: "TEAM_LIMIT" })
      expect(await count(f.id)).toEqual({ actual: limit, tracked: limit })
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM team_members WHERE workspace_id=$1",
            [f.id]
          )
        ).rows[0].n
      ).toBe(limit)
    }
  )
  it("allows Plus and Enterprise beyond five without a commercial cap", async () => {
    for (const plan of ["business", "enterprise"]) {
      const f = await workspace(plan)
      for (let n = 0; n < 7; n++) await rawTeam(f, n)
      expect(await count(f.id)).toEqual({ actual: 7, tracked: 7 })
    }
  })
  it("rolls an over-cap bulk import back atomically", async () => {
    const f = await workspace(),
      conn = await pool.connect()
    try {
      await conn.query("BEGIN")
      await expect(
        conn.query(
          "INSERT INTO teams(workspace_id,name,slug,identifier,icon_kind,icon_value,color,timezone,created_by_user_id) SELECT $1,'Import '||n,'import-'||n,'I'||n,'icon','UserGroup03Icon','#818cf8','Europe/Paris',$2 FROM generate_series(1,3) n",
          [f.id, f.owner]
        )
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "workspace_team_limit",
      })
    } finally {
      await conn.query("ROLLBACK")
      conn.release()
    }
    expect(await count(f.id)).toEqual({ actual: 0, tracked: 0 })
  })
  it("grandfathers existing teams on downgrade; archive frees capacity and concurrent restore/create cannot exceed it", async () => {
    const f = await workspace("business"),
      entries = []
    for (let n = 0; n < 6; n++) entries.push(await rawTeam(f, n))
    const archived = await rawTeam(f, 7, true)
    await pool.query(
      "UPDATE workspace_entitlements SET plan='basic' WHERE workspace_id=$1",
      [f.id]
    )
    expect((await app.listTeams(f.actor)).items).toHaveLength(6)
    expect(
      (
        await app.updateTeam(
          f.actor,
          { id: entries[0].id },
          { description: "Still editable" }
        )
      ).ok
    ).toBe(true)
    expect(await app.restoreTeam(f.actor, { id: archived.id })).toMatchObject({
      ok: false,
      code: "TEAM_LIMIT",
    })
    await app.archiveTeam(f.actor, { id: entries[0].id })
    await app.archiveTeam(f.actor, { id: entries[1].id })
    const outcomes = await Promise.all([
      app.createTeam(f.actor, input(20)),
      app.restoreTeam(f.actor, { id: archived.id }),
    ])
    expect(outcomes.filter((x) => x.ok)).toHaveLength(1)
    expect(await count(f.id)).toEqual({ actual: 5, tracked: 5 })
  })
  it("counts private teams without disclosing them in a capacity error", async () => {
    const f = await workspace()
    await rawTeam(f, 0, false, "private")
    await rawTeam(f, 1)
    const result = await app.createTeam(f.actor, input(2))
    expect(result).toMatchObject({ ok: false, code: "TEAM_LIMIT" })
    expect(JSON.stringify(result)).not.toContain("private")
    expect(result).not.toHaveProperty("count")
  })
  it("rejects reparenting even with spare capacity and counts fresh destination identities", async () => {
    const source = await workspace("business"),
      dest = await workspace(),
      team = await rawTeam(source, 0)
    await rawTeam(dest, 1)
    await rawTeam(dest, 2)
    await expect(
      pool.query("UPDATE teams SET workspace_id=$1 WHERE id=$2", [
        dest.id,
        team.id,
      ])
    ).rejects.toMatchObject({ constraint: "forge_immutable_identity" })
    expect(await count(source.id)).toEqual({ actual: 1, tracked: 1 })
    expect(await count(dest.id)).toEqual({ actual: 2, tracked: 2 })
    await pool.query(
      "DELETE FROM teams WHERE workspace_id=$1 AND identifier='T2'",
      [dest.id]
    )
    await expect(
      pool.query("UPDATE teams SET workspace_id=$1 WHERE id=$2", [
        dest.id,
        team.id,
      ])
    ).rejects.toMatchObject({ constraint: "forge_immutable_identity" })
    await pool.query("DELETE FROM teams WHERE id=$1", [team.id])
    const replacement = await rawTeam(dest, 0)
    expect(replacement.id).not.toBe(team.id)
    expect(await count(source.id)).toEqual({ actual: 0, tracked: 0 })
    expect(await count(dest.id)).toEqual({ actual: 2, tracked: 2 })
  })
  it("keeps ON CONFLICT retries inert even for grandfathered over-capacity teams", async () => {
    const f = await workspace("business"),
      team = await rawTeam(f, 0)
    for (let n = 1; n < 6; n++) await rawTeam(f, n)
    await pool.query(
      "UPDATE workspace_entitlements SET plan='free' WHERE workspace_id=$1",
      [f.id]
    )
    await pool.query(
      "INSERT INTO teams SELECT * FROM teams WHERE id=$1 ON CONFLICT DO NOTHING",
      [team.id]
    )
    expect(await count(f.id)).toEqual({ actual: 6, tracked: 6 })
  })
  it("enforces the same limit through the real API-key HTTP router and preserves idempotent success", async () => {
    const f = await workspace(),
      { auth } = await import("@/lib/auth"),
      { handlePublicApiRequest } = await import("@/api/v1/handler.server")
    const key = await auth.api.createApiKey({
      body: {
        configId: "forge-api",
        userId: f.owner,
        name: "Team capacity fixture",
        metadata: { workspaceId: f.id },
        permissions: { teams: ["read", "write"] },
      },
    })
    const post = (n: number, requestId: string) =>
      handlePublicApiRequest(
        new Request("http://localhost:3098/api/v1/teams", {
          method: "POST",
          headers: {
            authorization: `Bearer ${key.key}`,
            "content-type": "application/json",
            "idempotency-key": requestId,
          },
          body: JSON.stringify(input(n)),
        })
      )
    const id = randomUUID(),
      first = await post(0, id)
    expect(first.status, await first.clone().text()).toBe(201)
    expect((await post(1, randomUUID())).status).toBe(201)
    const denied = await post(2, randomUUID())
    expect(denied.status, await denied.clone().text()).toBe(409)
    expect(JSON.stringify(await denied.json())).toContain("TEAM_LIMIT")
    const replay = await post(0, id)
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(await first.json())
    expect(await count(f.id)).toEqual({ actual: 2, tracked: 2 })
    const other = await workspace("business")
    for (const extra of [{ plan: "business" }, { workspaceId: other.id }]) {
      const forged = await handlePublicApiRequest(
        new Request("http://localhost:3098/api/v1/teams", {
          method: "POST",
          headers: {
            authorization: `Bearer ${key.key}`,
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify({ ...input(99), ...extra }),
        })
      )
      expect(forged.status).toBe(400)
    }
    const readOnly = await auth.api.createApiKey({
      body: {
        configId: "forge-api",
        userId: f.owner,
        name: "Read-only quota fixture",
        metadata: { workspaceId: f.id },
        permissions: { teams: ["read"] },
      },
    })
    const forbidden = await handlePublicApiRequest(
      new Request("http://localhost:3098/api/v1/teams", {
        method: "POST",
        headers: {
          authorization: `Bearer ${readOnly.key}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify(input(100)),
      })
    )
    expect(forbidden.status).toBe(403)
    expect(await count(other.id)).toEqual({ actual: 0, tracked: 0 })
    expect(await count(f.id)).toEqual({ actual: 2, tracked: 2 })
  }, 30_000)
  it.each([
    "active",
    "trialing",
    "grace",
    "expired-grace",
    "cancel-before",
    "cancel-after",
    "full-refund",
    "upgrade-refund",
    "upgrade-no-base",
    "terminated",
    "scheduled-pause",
    "paused",
    "not-activated",
    "expired-period",
  ])("matches shared access policy for %s billing state", async (mode) => {
    const f = await workspace("business"),
      now = new Date(),
      start = new Date(now.getTime() - 86400000),
      end = new Date(now.getTime() + 86400000 * 30),
      activated = new Date(now.getTime() - 86400000 * 2),
      sub = randomUUID(),
      upgrade = randomUUID()
    const state: typeof database.workspaceEntitlements.$inferInsert = {
      workspaceId: f.id,
      source: "polar",
      plan: "business",
      status: mode === "trialing" ? "trialing" : "active",
      providerEnvironment: "sandbox",
      sourceReference: sub,
      providerUpdatedAt: now,
      providerStateHash: "a".repeat(64),
      currentPeriodStart: start,
      currentPeriodEnd: end,
      paidActivatedAt: activated,
    }
    if (mode.includes("grace")) {
      const failed = new Date(
        now.getTime() - (mode === "expired-grace" ? 8 : 1) * 86400000
      )
      state.status = "past_due"
      state.paidActivatedAt = new Date(failed.getTime() - 86400000)
      state.paymentFailedAt = failed
      state.graceExpiresAt = new Date(failed.getTime() + 7 * 86400000)
    }
    if (mode.startsWith("cancel")) {
      state.status = "canceled"
      state.cancelAtPeriodEnd = true
      state.cancellationPeriodEnd =
        mode === "cancel-after" ? new Date(now.getTime() - 1000) : end
    }
    if (mode === "terminated") state.terminatedAt = now
    if (mode === "scheduled-pause") state.unsupportedPauseAt = end
    if (mode === "paused") state.unsupportedPauseAt = start
    if (mode === "not-activated") state.paidActivatedAt = null
    if (mode === "expired-period") {
      state.currentPeriodStart = new Date(now.getTime() - 86400000 * 32)
      state.currentPeriodEnd = new Date(now.getTime() - 86400000)
    }
    if (mode.includes("refund") || mode === "upgrade-no-base") {
      const refund = {
        orderId: upgrade,
        subscriptionId: sub,
        environment: "sandbox" as const,
        start: start.toISOString(),
        end: end.toISOString(),
        refundedAt: now.toISOString(),
      }
      state.refundedPeriods =
        mode === "full-refund"
          ? [refund]
          : [
              {
                ...refund,
                kind: "upgrade",
                starterOrderId:
                  mode === "upgrade-no-base" ? null : randomUUID(),
                basePeriodStart: start.toISOString(),
                basePeriodEnd: end.toISOString(),
              },
            ]
      if (mode !== "full-refund") state.paidUpgradeOrderId = upgrade
    }
    await database.db
      .update(database.workspaceEntitlements)
      .set(state)
      .where(
        (await import("drizzle-orm")).eq(
          database.workspaceEntitlements.workspaceId,
          f.id
        )
      )
    const persisted = await database.db.query.workspaceEntitlements.findFirst({
      where: (await import("drizzle-orm")).eq(
        database.workspaceEntitlements.workspaceId,
        f.id
      ),
    })
    const plan = subscriptionAccess(persisted).plan,
      expected =
        plan === "basic" ? "starter" : plan === "business" ? "plus" : plan
    expect(
      (
        await pool.query("SELECT forge_effective_workspace_plan($1) AS plan", [
          f.id,
        ])
      ).rows[0].plan
    ).toBe(expected)
    for (let n = 0; n < 2; n++) await rawTeam(f, n)
    const third = app.createTeam(f.actor, input(3))
    if (plan === "free")
      expect(await third).toMatchObject({ ok: false, code: "TEAM_LIMIT" })
    else expect((await third).ok).toBe(true)
  })
})

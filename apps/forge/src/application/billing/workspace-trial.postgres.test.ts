// @vitest-environment node
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import { subscriptionAccess } from "./subscription-access"
import type { Actor } from "@/application/actor"
import type * as Trial from "./workspace-trial.server"
import type * as Database from "@/db"

const connection = process.env.FORGE_TRIAL_TEST_DATABASE_URL
describe.skipIf(!connection)("durable workspace trials in PostgreSQL", () => {
  const marker = `trial-${randomUUID()}`
  const workspaces: Array<string> = [],
    userIds: Array<string> = []
  const cleanup: { pool?: Pool; database?: typeof Database } = {}
  let pool: Pool, trial: typeof Trial, database: typeof Database
  async function fixture(verified = true) {
    const id = `${marker}-${workspaces.length}`,
      userId = `${id}-owner`
    workspaces.push(id)
    userIds.push(userId)
    await pool.query(
      "INSERT INTO public.organization(id,name,slug) VALUES($1,$1,$1)",
      [id]
    )
    await pool.query(
      'INSERT INTO public."user"(id,name,email,email_verified) VALUES($1,$1,$2,$3)',
      [userId, `${userId}@example.test`, verified]
    )
    await pool.query(
      "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
      [`${id}-membership`, id, userId]
    )
    const actor: Actor = {
      userId,
      workspaceId: id,
      workspaceRole: "owner",
      authentication: { kind: "session", sessionId: "fixture-session" },
      scopes: null,
    }
    return { id, actor }
  }
  async function historical(actor: Actor) {
    // Seed a historical immutable redemption before the current trial projection.
    const start = new Date(Date.now() - 15 * 86400000),
      end = new Date(start.getTime() + 14 * 86400000)
    const id = randomUUID()
    await pool.query(
      `INSERT INTO public.workspace_trial_redemptions(workspace_id,id,initial_plan,actor_user_id,start_request_id,start_body_hash,started_at,expires_at)
      VALUES($1,$2,'plus',$3,$4,$5,$6,$7)`,
      [
        actor.workspaceId,
        id,
        actor.userId,
        randomUUID(),
        "a".repeat(64),
        start,
        end,
      ]
    )
    await pool.query(
      `INSERT INTO public.workspace_entitlements(workspace_id,plan,status,source,source_reference,trial_redemption_id,current_period_start,current_period_end)
      VALUES($1,'business','trialing','forge-trial',$2::text,$2::uuid,$3,$4)`,
      [actor.workspaceId, id, start, end]
    )
    return { id, start, end }
  }
  beforeAll(async () => {
    const target = {
      environment: "staging" as const,
      ...DATABASE_TARGETS.staging,
    }
    assertMigrationTarget(connection!, target)
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: connection, max: 8 })
    cleanup.pool = pool
    expect(
      (
        await pool.query(
          "SELECT current_database() AS database,current_setting('neon.branch_id',true) AS branch"
        )
      ).rows[0]
    ).toEqual({ database: target.database, branch: target.branchId })
    const sql = await readFile(
      new URL("../../../drizzle/0037_workspace_trials.sql", import.meta.url),
      "utf8"
    )
    expect(
      (
        await pool.query(
          "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1"
        )
      ).rows[0].hash
    ).toBe(createHash("sha256").update(sql).digest("hex"))
    vi.stubEnv("DATABASE_URL", connection)
    database = await import("@/db")
    cleanup.database = database
    trial = await import("./workspace-trial.server")
  }, 30000)
  afterAll(async () => {
    if (cleanup.pool) {
      if (workspaces.length)
        await pool.query(
          "DELETE FROM public.organization WHERE id=ANY($1::text[])",
          [workspaces]
        )
      if (userIds.length)
        await pool.query('DELETE FROM public."user" WHERE id=ANY($1::text[])', [
          userIds,
        ])
      await pool.end()
    }
    await cleanup.database?.db.$client.end()
    vi.unstubAllEnvs()
  })
  it("serializes concurrent starts into one window and one audit without provider traffic", async () => {
    const { actor, id } = await fixture(),
      input = { requestId: randomUUID(), plan: "starter" }
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const results = await Promise.all([
      trial.startWorkspaceTrial(actor, input),
      trial.startWorkspaceTrial(actor, input),
    ])
    expect(new Set(results.map((r) => r.trial.id)).size).toBe(1)
    expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    expect(
      results[0].trial.expiresAt.getTime() -
        results[0].trial.startedAt.getTime()
    ).toBe(14 * 86400000)
    expect(results[0].trial.allowanceUsdMicros).toBe(5_000_000)
    expect(
      fetchSpy.mock.calls.every(([url]) => !String(url).includes("polar"))
    ).toBe(true)
    fetchSpy.mockRestore()
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM public.workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.trial.started'",
          [id]
        )
      ).rows[0].n
    ).toBe(1)
  })
  it("locks the initial tier across distinct command IDs", async () => {
    const { actor } = await fixture()
    await trial.startWorkspaceTrial(actor, {
      requestId: randomUUID(),
      plan: "plus",
    })
    await expect(
      trial.startWorkspaceTrial(actor, {
        requestId: randomUUID(),
        plan: "starter",
      })
    ).rejects.toThrow("TRIAL_TIER_LOCKED")
    expect(
      (
        await trial.startWorkspaceTrial(actor, {
          requestId: randomUUID(),
          plan: "plus",
        })
      ).replayed
    ).toBe(true)
  })
  it("allows exactly one winner when distinct admins race different tiers", async () => {
    const { actor, id } = await fixture()
    const admin = `${id}-admin`
    userIds.push(admin)
    await pool.query(
      'INSERT INTO public."user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
      [admin, `${admin}@example.test`]
    )
    await pool.query(
      "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$1,'admin')",
      [admin, id]
    )
    const outcomes = await Promise.allSettled([
      trial.startWorkspaceTrial(actor, {
        requestId: randomUUID(),
        plan: "starter",
      }),
      trial.startWorkspaceTrial(
        { ...actor, userId: admin, workspaceRole: "admin" },
        { requestId: randomUUID(), plan: "plus" }
      ),
    ])
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM public.workspace_trial_redemptions WHERE workspace_id=$1",
          [id]
        )
      ).rows[0].n
    ).toBe(1)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM public.workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.trial.started'",
          [id]
        )
      ).rows[0].n
    ).toBe(1)
  })
  it("requires a currently authorized verified first-party owner/admin", async () => {
    const { actor, id } = await fixture(false)
    await expect(
      trial.startWorkspaceTrial(actor, {
        requestId: randomUUID(),
        plan: "plus",
      })
    ).rejects.toThrow("TRIAL_EMAIL_VERIFICATION_REQUIRED")
    await pool.query(
      'UPDATE public."user" SET email_verified=true WHERE id=$1',
      [actor.userId]
    )
    await pool.query(
      "UPDATE public.member SET role='member' WHERE organization_id=$1",
      [id]
    )
    await expect(
      trial.startWorkspaceTrial(actor, {
        requestId: randomUUID(),
        plan: "plus",
      })
    ).rejects.toThrow("TRIAL_ACTOR_REVOKED")
    await expect(
      trial.startWorkspaceTrial(
        { ...actor, authentication: { kind: "apiKey", credentialId: "key" } },
        { requestId: randomUUID(), plan: "plus" }
      )
    ).rejects.toThrow("authenticated workspace owner")
  })
  it("never returns a cached result after the caller is revoked", async () => {
    const { actor, id } = await fixture(),
      input = { requestId: randomUUID(), plan: "plus" }
    await trial.startWorkspaceTrial(actor, input)
    await pool.query(
      "UPDATE public.member SET role='member' WHERE organization_id=$1",
      [id]
    )
    await expect(trial.startWorkspaceTrial(actor, input)).rejects.toThrow(
      "TRIAL_ACTOR_REVOKED"
    )
  })
  it("rejects previously-paid Free workspaces in both command and direct SQL", async () => {
    const { actor, id } = await fixture()
    await pool.query(
      "INSERT INTO public.workspace_entitlements(workspace_id,plan,status,paid_activated_at) VALUES($1,'free','active',now())",
      [id]
    )
    await expect(
      trial.startWorkspaceTrial(actor, {
        requestId: randomUUID(),
        plan: "starter",
      })
    ).rejects.toThrow("TRIAL_NEVER_PAID_REQUIRED")
    await expect(historical(actor)).rejects.toMatchObject({
      constraint: "workspace_trial_never_paid",
    })
  })
  it("rejects client workspace/date/grant overrides before mutation", async () => {
    const { actor } = await fixture()
    for (const extra of [
      { workspaceId: "other" },
      { startedAt: new Date() },
      { allowanceUsdMicros: 10_000_000 },
    ])
      await expect(
        trial.startWorkspaceTrial(actor, {
          requestId: randomUUID(),
          plan: "plus",
          ...extra,
        })
      ).rejects.toThrow()
  })
  it("rolls back cross-workspace request ID collisions atomically", async () => {
    const a = await fixture(),
      b = await fixture(),
      input = { requestId: randomUUID(), plan: "plus" }
    await trial.startWorkspaceTrial(a.actor, input)
    await expect(trial.startWorkspaceTrial(b.actor, input)).rejects.toThrow()
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM public.workspace_trial_redemptions WHERE workspace_id=$1",
          [b.id]
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM public.workspace_entitlements WHERE workspace_id=$1",
          [b.id]
        )
      ).rows[0].n
    ).toBe(0)
  })
  it("prevents redemption deletion, extension, tier changes and mismatched projections", async () => {
    const { actor, id } = await fixture()
    await trial.startWorkspaceTrial(actor, {
      requestId: randomUUID(),
      plan: "starter",
    })
    for (const sql of [
      "DELETE FROM public.workspace_trial_redemptions WHERE workspace_id=$1",
      "UPDATE public.workspace_trial_redemptions SET initial_plan='plus' WHERE workspace_id=$1",
      "UPDATE public.workspace_trial_redemptions SET started_at=started_at+interval '1 hour',expires_at=expires_at+interval '1 hour' WHERE workspace_id=$1",
      "UPDATE public.workspace_entitlements SET plan='business' WHERE workspace_id=$1",
      "UPDATE public.workspace_entitlements SET current_period_end=current_period_end+interval '1 hour' WHERE workspace_id=$1",
    ])
      await expect(pool.query(sql, [id])).rejects.toMatchObject({
        code: "23514",
      })
  })
  it("expires at read time and SQL admission even with no expiry worker", async () => {
    const { actor, id } = await fixture(),
      t = await historical(actor)
    expect(
      (
        await pool.query(
          "SELECT public.forge_effective_workspace_plan($1) plan",
          [id]
        )
      ).rows[0].plan
    ).toBe("free")
    const state = {
      plan: "business",
      status: "trialing",
      source: "forge-trial",
      sourceReference: t.id,
      trialRedemptionId: t.id,
      currentPeriodStart: t.start,
      currentPeriodEnd: t.end,
    }
    expect(subscriptionAccess(state, new Date(t.end.getTime() - 1)).phase).toBe(
      "trial"
    )
    expect(subscriptionAccess(state, t.end).plan).toBe("free")
    for (let i = 0; i < 4; i++) {
      const u = `${id}-member${i}`
      userIds.push(u)
      await pool.query(
        'INSERT INTO public."user"(id,name,email) VALUES($1,$1,$2)',
        [u, `${u}@example.test`]
      )
      await pool.query(
        "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$1,'member')",
        [u, id]
      )
    }
    const u = `${id}-sixth`
    userIds.push(u)
    await pool.query(
      'INSERT INTO public."user"(id,name,email) VALUES($1,$1,$2)',
      [u, `${u}@example.test`]
    )
    await expect(
      pool.query(
        "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$1,'member')",
        [u, id]
      )
    ).rejects.toMatchObject({ constraint: "workspace_free_member_limit" })
  })
  it("expires once, keeps original grant/window and cannot restart", async () => {
    const { actor, id } = await fixture(),
      t = await historical(actor)
    expect(await trial.expireWorkspaceTrial(id)).toEqual({ expired: true })
    expect(await trial.expireWorkspaceTrial(id)).toEqual({ expired: false })
    const replay = await trial.startWorkspaceTrial(actor, {
      requestId: randomUUID(),
      plan: "plus",
    })
    expect(replay.replayed).toBe(true)
    expect(replay.trial.id).toBe(t.id)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM public.workspace_trial_redemptions WHERE workspace_id=$1",
          [id]
        )
      ).rows[0].n
    ).toBe(1)
  })
  it("a late expiry cannot overwrite a paid conversion", async () => {
    const { actor, id } = await fixture()
    await historical(actor)
    // Simulate the canonical paid sink replacing the projection; its own proof
    // is covered by the existing billing PostgreSQL suite.
    await pool.query(
      "UPDATE public.workspace_entitlements SET source='internal',source_reference=NULL,plan='basic',status='active',paid_activated_at=now() WHERE workspace_id=$1",
      [id]
    )
    expect(await trial.expireWorkspaceTrial(id)).toEqual({ expired: false })
    expect(
      (
        await pool.query(
          "SELECT plan,trial_redemption_id FROM public.workspace_entitlements WHERE workspace_id=$1",
          [id]
        )
      ).rows[0]
    ).toEqual({ plan: "basic", trial_redemption_id: null })
  })
})

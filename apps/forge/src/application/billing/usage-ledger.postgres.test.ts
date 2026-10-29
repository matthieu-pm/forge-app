// @vitest-environment node
import { randomUUID } from "node:crypto"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { schemaIsReady } from "../operations/readiness-schema"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import { workspaceUsagePeriod } from "./workspace-usage-period"
import type * as Ledger from "./usage-ledger.server"
import type * as Database from "@/db"
import type { Actor } from "@/application/actor"

const connection = process.env.FORGE_USAGE_TEST_DATABASE_URL
describe.skipIf(!connection)("atomic PostgreSQL usage ledger", () => {
  const marker = `usage-${randomUUID()}`,
    workspaces: Array<string> = [],
    userIds: Array<string> = []
  const cleanup: { pool?: Pool; database?: typeof Database } = {}
  let pool: Pool, ledger: typeof Ledger
  async function fixture(mode = "forge-managed") {
    const id = `${marker}-${workspaces.length}`,
      userId = `${id}-owner`,
      threadId = randomUUID(),
      connectionId = randomUUID()
    workspaces.push(id)
    userIds.push(userId)
    await pool.query(
      "INSERT INTO public.organization(id,name,slug,created_at) VALUES($1,$1,$1,$2)",
      [id, new Date(Date.now() - 120 * 86400000)]
    )
    await pool.query(
      'INSERT INTO public."user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
      [userId, `${userId}@example.test`]
    )
    await pool.query(
      "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
      [`${id}-membership`, id, userId]
    )
    await pool.query(
      "INSERT INTO public.agent_threads(id,workspace_id,created_by_user_id,runtime_kind) VALUES($1,$2,$3,'eve')",
      [threadId, id, userId]
    )
    await pool.query(
      `INSERT INTO public.model_connections(id,workspace_id,scope,provider,kind,execution_kind,locality,billing_mode,credential_owner,display_name,status,created_by_user_id)
      VALUES($1,$2,'workspace','fixture-provider','managed','forge-native','server-capable',$3,'forge-server-vault','Usage fixture','ready',$4)`,
      [connectionId, id, mode, userId]
    )
    await pool.query(
      `INSERT INTO public.model_catalog_entries(connection_id,selection_id,provider_model_id,display_name,provider_label,source_label,execution_kind)
      VALUES($1,$2,'fixture-model','Fixture model','Fixture provider','Fixture','forge-native')`,
      [connectionId, `${connectionId}:fixture-model`]
    )
    const actor: Actor = {
      userId,
      workspaceId: id,
      workspaceRole: "owner",
      authentication: { kind: "session", sessionId: "fixture-session" },
      scopes: null,
    }
    return { id, actor, threadId, connectionId }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  function command(f: Fixture, amount = 3_000_000): Ledger.AgentUsageAdmission {
    return {
      requestId: randomUUID(),
      runId: randomUUID(),
      threadId: f.threadId,
      connectionId: f.connectionId,
      modelId: "fixture-model",
      maximumCostUsdMicros: amount,
      pricingFingerprint: "a".repeat(64),
    }
  }
  async function settle(
    f: Fixture,
    reservationId: string,
    cost: number,
    eventId = randomUUID()
  ) {
    return ledger.settleAgentUsage({
      workspaceId: f.id,
      reservationId,
      eventId,
      outcome: "settled",
      providerCostUsdMicros: cost,
    })
  }
  async function paid(f: Fixture) {
    const start = new Date(Date.now() - 20 * 86400000),
      end = new Date(Date.now() + 10 * 86400000),
      subscription = randomUUID()
    await pool.query(
      `INSERT INTO public.workspace_entitlements(workspace_id,plan,status,source,source_reference,provider_environment,provider_updated_at,provider_state_hash,paid_activated_at,current_period_start,current_period_end)
      VALUES($1,'basic','active','polar',$2,'sandbox',$3,$4,$3,$3,$5)
      ON CONFLICT(workspace_id) DO UPDATE SET plan='basic',status='active',source='polar',source_reference=$2,provider_environment='sandbox',provider_updated_at=$3,provider_state_hash=$4,paid_activated_at=$3,current_period_start=$3,current_period_end=$5`,
      [f.id, subscription, start, "b".repeat(64), end]
    )
    return { start, end, subscription }
  }
  async function terminate(f: Fixture) {
    await pool.query(
      "UPDATE public.workspace_entitlements SET status='canceled',terminated_at=clock_timestamp() WHERE workspace_id=$1",
      [f.id]
    )
  }
  async function historicalReservation(
    f: Fixture,
    input: {
      kind: "trial" | "paid"
      binding: string
      start: Date
      end: Date
      amount: number
    }
  ) {
    const periodId = randomUUID(),
      runId = randomUUID(),
      window = workspaceUsagePeriod(
        f.id,
        new Date(input.start.getTime() + 1),
        input.kind === "trial"
          ? { kind: "trial", trialStartedAt: input.start }
          : {
              kind: "paid-monthly",
              currentPeriodStart: input.start,
              currentPeriodEnd: input.end,
            }
      )
    await pool.query(
      "INSERT INTO public.workspace_usage_periods(id,workspace_id,period_key,kind,binding,started_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        periodId,
        f.id,
        JSON.stringify(["forge.usage-account", input.kind, window.key]),
        input.kind,
        input.binding,
        input.start,
        input.end,
      ]
    )
    await pool.query(
      "INSERT INTO public.agent_runs(id,thread_id,initiated_by_user_id,execution_kind,requested_selection) VALUES($1,$2,$3,'forge-native','{}')",
      [runId, f.threadId, f.actor.userId]
    )
    await pool.query(
      `INSERT INTO public.workspace_usage_reservations(id,workspace_id,period_id,request_id,request_hash,operation_id,run_id,actor_user_id,provider,model_id,pricing_fingerprint,billing_mode,uses_pool,maximum_cost_usd_micros,reserved_usd_micros)
      VALUES($1,$2,$3,$4,$5,$1,$1,$6,'fixture-provider','fixture-model',$5,'forge-managed',true,$7,$7)`,
      [
        runId,
        f.id,
        periodId,
        randomUUID(),
        "a".repeat(64),
        f.actor.userId,
        input.amount,
      ]
    )
    return { periodId, runId }
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
    expect(await schemaIsReady(pool)).toBe(true)
    vi.stubEnv("DATABASE_URL", connection)
    cleanup.database = await import("@/db")
    ledger = await import("./usage-ledger.server")
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
  it("admits only one of two distinct starts competing for the final funds", async () => {
    const f = await fixture(),
      a = command(f),
      b = command(f)
    const results = await Promise.allSettled([
      ledger.admitAgentRunWithUsage(f.actor, a),
      ledger.admitAgentRunWithUsage(f.actor, b),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM public.agent_runs WHERE thread_id=$1",
          [f.threadId]
        )
      ).rows[0].n
    ).toBe(1)
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      reservedUsdMicros: 3_000_000,
      settledUsdMicros: 0,
    })
  })
  it("concurrently replays one run, reservation, event and audit", async () => {
    const f = await fixture(),
      c = command(f)
    const results = await Promise.all([
      ledger.admitAgentRunWithUsage(f.actor, c),
      ledger.admitAgentRunWithUsage(f.actor, c),
    ])
    expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    expect(new Set(results.map((r) => r.reservationId)).size).toBe(1)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM public.agent_events WHERE run_id=$1",
          [c.runId]
        )
      ).rows[0].n
    ).toBe(1)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM public.workspace_security_audit_events WHERE workspace_id=$1 AND action='usage.agent.admitted'",
          [f.id]
        )
      ).rows[0].n
    ).toBe(1)
  })
  it("conflicting bodies and cross-workspace IDs cannot mint another run", async () => {
    const f = await fixture(),
      g = await fixture(),
      c = command(f)
    await ledger.admitAgentRunWithUsage(f.actor, c)
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, { ...c, maximumCostUsdMicros: 1 })
    ).rejects.toThrow("USAGE_REQUEST_CONFLICT")
    await expect(
      ledger.admitAgentRunWithUsage(g.actor, {
        ...command(g),
        requestId: c.requestId,
      })
    ).rejects.toThrow("USAGE_REQUEST_CONFLICT")
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM public.agent_runs WHERE thread_id=$1",
          [g.threadId]
        )
      ).rows[0].n
    ).toBe(0)
  })
  it("rejects stale membership, unverified email, credential scope and client classification overrides", async () => {
    const f = await fixture(),
      c = command(f)
    await pool.query(
      'UPDATE public."user" SET email_verified=false WHERE id=$1',
      [f.actor.userId]
    )
    await expect(ledger.admitAgentRunWithUsage(f.actor, c)).rejects.toThrow(
      "USAGE_EMAIL_VERIFICATION_REQUIRED"
    )
    await pool.query(
      'UPDATE public."user" SET email_verified=true WHERE id=$1',
      [f.actor.userId]
    )
    await expect(
      ledger.admitAgentRunWithUsage({ ...f.actor, scopes: ["agents:read"] }, c)
    ).rejects.toThrow("cannot run agents")
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, {
        ...c,
        plan: "plus",
      } as Ledger.AgentUsageAdmission)
    ).rejects.toThrow()
    await pool.query("DELETE FROM public.member WHERE organization_id=$1", [
      f.id,
    ])
    await expect(ledger.admitAgentRunWithUsage(f.actor, c)).rejects.toThrow(
      "USAGE_ACTOR_REVOKED"
    )
  })
  it("rechecks live authority before returning a cached admission", async () => {
    const f = await fixture(),
      c = command(f)
    await ledger.admitAgentRunWithUsage(f.actor, c)
    await pool.query("DELETE FROM public.member WHERE organization_id=$1", [
      f.id,
    ])
    await expect(ledger.admitAgentRunWithUsage(f.actor, c)).rejects.toThrow(
      "USAGE_ACTOR_REVOKED"
    )
  })
  it("binds the model connection, catalog and thread to the caller", async () => {
    const f = await fixture(),
      g = await fixture()
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, {
        ...command(f),
        threadId: g.threadId,
      })
    ).rejects.toThrow("USAGE_THREAD_NOT_FOUND")
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, {
        ...command(f),
        connectionId: g.connectionId,
      })
    ).rejects.toThrow("USAGE_MODEL_CONNECTION_UNAVAILABLE")
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, {
        ...command(f),
        modelId: "invented",
      })
    ).rejects.toThrow("USAGE_MODEL_UNAVAILABLE")
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, command(f, 0))
    ).rejects.toThrow("USAGE_BOUNDED_PRICING_REQUIRED")
  })
  it("settles once, releases unused exposure and rejects conflicting terminal history", async () => {
    const f = await fixture(),
      c = command(f),
      eventId = randomUUID()
    await ledger.admitAgentRunWithUsage(f.actor, c)
    expect(await settle(f, c.runId, 1_000_000, eventId)).toMatchObject({
      state: "settled",
      reservedUsdMicros: 0,
      replayed: false,
    })
    expect(await settle(f, c.runId, 1_000_000, eventId)).toMatchObject({
      replayed: true,
    })
    await expect(settle(f, c.runId, 2_000_000, eventId)).rejects.toThrow(
      "USAGE_SETTLEMENT_CONFLICT"
    )
    await expect(settle(f, c.runId, 2_000_000)).rejects.toThrow(
      "USAGE_TERMINAL_RECONCILIATION_REQUIRED"
    )
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      settledUsdMicros: 1_000_000,
      reservedUsdMicros: 0,
    })
    await ledger.admitAgentRunWithUsage(f.actor, command(f, 4_000_000))
  })
  it("uncertain cancellations keep their full reservation until confirmed", async () => {
    const f = await fixture(),
      c = command(f, 5_000_000)
    await ledger.admitAgentRunWithUsage(f.actor, c)
    const input = {
      workspaceId: f.id,
      reservationId: c.runId,
      eventId: randomUUID(),
      outcome: "uncertain" as const,
      providerCostUsdMicros: 0,
    }
    expect(await ledger.settleAgentUsage(input)).toMatchObject({
      state: "uncertain",
      reservedUsdMicros: 5_000_000,
    })
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, command(f, 1))
    ).rejects.toThrow("USAGE_ALLOWANCE_EXHAUSTED")
    expect(
      await ledger.settleAgentUsage({
        ...input,
        eventId: randomUUID(),
        outcome: "confirmed-no-charge",
      })
    ).toMatchObject({ state: "released", reservedUsdMicros: 0 })
    await ledger.admitAgentRunWithUsage(f.actor, command(f, 5_000_000))
  })
  it("records overruns truthfully and blocks subsequent pool spending", async () => {
    const f = await fixture(),
      c = command(f)
    await ledger.admitAgentRunWithUsage(f.actor, c)
    expect(await settle(f, c.runId, 6_000_000)).toMatchObject({
      state: "reconciliation-required",
      settledUsdMicros: 6_000_000,
    })
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, command(f, 1))
    ).rejects.toThrow("USAGE_ALLOWANCE_EXHAUSTED")
  })
  it("does not impose run-count concurrency caps", async () => {
    const f = await fixture()
    const result = await Promise.all(
      Array.from({ length: 25 }, () =>
        ledger.admitAgentRunWithUsage(f.actor, command(f, 1000))
      )
    )
    expect(result).toHaveLength(25)
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      reservedUsdMicros: 25000,
    })
  }, 30000)
  it("keeps BYOK costs out of allowance and permits it after pool exhaustion", async () => {
    const f = await fixture(),
      c = command(f, 5_000_000)
    await ledger.admitAgentRunWithUsage(f.actor, c)
    await pool.query(
      "UPDATE public.model_connections SET billing_mode='pay-as-you-go' WHERE id=$1",
      [f.connectionId]
    )
    const byok = command(f, 9_000_000)
    await ledger.admitAgentRunWithUsage(f.actor, byok)
    await settle(f, byok.runId, 8_000_000)
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      settledUsdMicros: 0,
      reservedUsdMicros: 5_000_000,
    })
  })
  it("a first paid period gets a fresh pool independent of earlier Free spend", async () => {
    const f = await fixture(),
      free = command(f, 4_000_000)
    await ledger.admitAgentRunWithUsage(f.actor, free)
    await settle(f, free.runId, 4_000_000)
    await paid(f)
    const paidRun = await ledger.admitAgentRunWithUsage(
      f.actor,
      command(f, 5_000_000)
    )
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      periodId: paidRun.periodId,
      kind: "paid",
      settledUsdMicros: 0,
      reservedUsdMicros: 5_000_000,
    })
  })
  it("carries paid settled/reserved commitments into Free without resetting existing Free use", async () => {
    const f = await fixture(),
      free = command(f, 1_500_000)
    await ledger.admitAgentRunWithUsage(f.actor, free)
    await settle(f, free.runId, 1_500_000)
    await paid(f)
    const p = command(f, 4_000_000)
    await ledger.admitAgentRunWithUsage(f.actor, p)
    await terminate(f)
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      kind: "free",
      settledUsdMicros: 1_500_000,
      reservedUsdMicros: 4_000_000,
      carrySourceCount: 1,
    })
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, command(f, 1))
    ).rejects.toThrow("USAGE_ALLOWANCE_EXHAUSTED")
    await settle(f, p.runId, 2_000_000)
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      settledUsdMicros: 3_500_000,
      reservedUsdMicros: 0,
      carrySourceCount: 1,
    })
    await ledger.admitAgentRunWithUsage(f.actor, command(f, 1_500_000))
  })
  it("replaying downgrade materialization cannot grant or move another pool", async () => {
    const f = await fixture()
    await paid(f)
    await ledger.admitAgentRunWithUsage(f.actor, command(f, 3_000_000))
    await terminate(f)
    const first = await ledger.inspectWorkspaceUsage(f.id),
      second = await ledger.inspectWorkspaceUsage(f.id)
    expect(second).toEqual(first)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM public.workspace_usage_carryovers WHERE workspace_id=$1",
          [f.id]
        )
      ).rows[0].n
    ).toBe(1)
  })
  it("keeps in-flight exposure and settlement in its original period across renewal", async () => {
    const f = await fixture(),
      p = await paid(f)
    const old = await historicalReservation(f, {
      kind: "paid",
      binding: JSON.stringify(["polar", "sandbox", p.subscription]),
      start: new Date(p.start.getTime() - 30 * 86400000),
      end: p.start,
      amount: 5_000_000,
    })
    const current = await ledger.admitAgentRunWithUsage(
      f.actor,
      command(f, 5_000_000)
    )
    expect(current.periodId).not.toBe(old.periodId)
    await settle(f, old.runId, 4_000_000)
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      periodId: current.periodId,
      settledUsdMicros: 0,
      reservedUsdMicros: 5_000_000,
    })
    expect(
      (
        await pool.query(
          "SELECT period_id,settled_usd_micros FROM public.workspace_usage_reservations WHERE id=$1",
          [old.runId]
        )
      ).rows[0]
    ).toEqual({ period_id: old.periodId, settled_usd_micros: "4000000" })
  })
  it("trial start gets a fresh fixed pool, independent of existing Free spend and extra members", async () => {
    const f = await fixture(),
      free = command(f, 4_000_000)
    await ledger.admitAgentRunWithUsage(f.actor, free)
    await settle(f, free.runId, 4_000_000)
    const admin = `${f.id}-admin`
    userIds.push(admin)
    await pool.query(
      'INSERT INTO public."user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
      [admin, `${admin}@example.test`]
    )
    await pool.query(
      "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$1,'admin')",
      [admin, f.id]
    )
    const { startWorkspaceTrial } = await import("./workspace-trial.server")
    await startWorkspaceTrial(f.actor, {
      requestId: randomUUID(),
      plan: "plus",
    })
    await ledger.admitAgentRunWithUsage(f.actor, command(f, 5_000_000))
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      kind: "trial",
      settledUsdMicros: 0,
      reservedUsdMicros: 5_000_000,
    })
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, command(f, 1))
    ).rejects.toThrow("USAGE_ALLOWANCE_EXHAUSTED")
  })
  it("expired trial exposure carries without a cleanup worker and late settlement updates the same shadow", async () => {
    const f = await fixture(),
      trialId = randomUUID(),
      start = new Date(Date.now() - 15 * 86400000),
      end = new Date(start.getTime() + 14 * 86400000)
    await pool.query(
      "INSERT INTO public.workspace_trial_redemptions(workspace_id,id,initial_plan,actor_user_id,start_request_id,start_body_hash,started_at,expires_at) VALUES($1,$2,'plus',$3,$4,$5,$6,$7)",
      [f.id, trialId, f.actor.userId, randomUUID(), "a".repeat(64), start, end]
    )
    await pool.query(
      "INSERT INTO public.workspace_entitlements(workspace_id,plan,status,source,source_reference,trial_redemption_id,current_period_start,current_period_end) VALUES($1,'business','trialing','forge-trial',$2::text,$2::uuid,$3,$4)",
      [f.id, trialId, start, end]
    )
    const old = await historicalReservation(f, {
      kind: "trial",
      binding: trialId,
      start,
      end,
      amount: 5_000_000,
    })
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      kind: "free",
      reservedUsdMicros: 5_000_000,
      carrySourceCount: 1,
    })
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, command(f, 1))
    ).rejects.toThrow("USAGE_ALLOWANCE_EXHAUSTED")
    await settle(f, old.runId, 3_000_000)
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      settledUsdMicros: 3_000_000,
      reservedUsdMicros: 0,
      carrySourceCount: 1,
    })
    await ledger.admitAgentRunWithUsage(f.actor, command(f, 2_000_000))
  })
  it("late downgrade processing cannot move debt into a later Free anniversary", async () => {
    const f = await fixture(),
      subscription = randomUUID(),
      end = new Date(Date.now() - 35 * 86400000),
      start = new Date(end.getTime() - 30 * 86400000)
    const old = await historicalReservation(f, {
      kind: "paid",
      binding: JSON.stringify(["polar", "sandbox", subscription]),
      start,
      end,
      amount: 5_000_000,
    })
    await pool.query(
      `INSERT INTO public.workspace_entitlements(workspace_id,plan,status,source,source_reference,provider_environment,provider_updated_at,provider_state_hash,paid_activated_at,current_period_start,current_period_end)
      VALUES($1,'basic','active','polar',$2,'sandbox',$3,$4,$3,$3,$5)`,
      [f.id, subscription, start, "a".repeat(64), end]
    )
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      kind: "free",
      settledUsdMicros: 0,
      reservedUsdMicros: 0,
      carrySourceCount: 0,
    })
    await settle(f, old.runId, 5_000_000)
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      settledUsdMicros: 0,
      reservedUsdMicros: 0,
      carrySourceCount: 0,
    })
    const shadow = (
      await pool.query(
        "SELECT effective_at FROM public.workspace_usage_carryovers WHERE workspace_id=$1",
        [f.id]
      )
    ).rows[0]
    expect(shadow.effective_at.toISOString()).toBe(end.toISOString())
    await ledger.admitAgentRunWithUsage(f.actor, command(f, 5_000_000))
  })
  it("retains the original paid pool during grace rather than granting another", async () => {
    const f = await fixture()
    await paid(f)
    await ledger.admitAgentRunWithUsage(f.actor, command(f, 3_000_000))
    const before = await ledger.inspectWorkspaceUsage(f.id)
    await pool.query(
      "UPDATE public.workspace_entitlements SET status='past_due',payment_failed_at=statement_timestamp()-interval '1 day',grace_expires_at=statement_timestamp()+interval '6 days' WHERE workspace_id=$1",
      [f.id]
    )
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, command(f, 3_000_000))
    ).rejects.toThrow("USAGE_ALLOWANCE_EXHAUSTED")
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      periodId: before.periodId,
      reservedUsdMicros: 3_000_000,
    })
  })
  it("uses current active membership for paid capacity without resetting spent funds", async () => {
    const f = await fixture()
    await paid(f)
    const extra = `${f.id}-extra`
    userIds.push(extra)
    await pool.query(
      'INSERT INTO public."user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
      [extra, `${extra}@example.test`]
    )
    await pool.query(
      "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$1,'member')",
      [extra, f.id]
    )
    const c = command(f, 8_000_000)
    await ledger.admitAgentRunWithUsage(f.actor, c)
    await settle(f, c.runId, 8_000_000)
    await pool.query("DELETE FROM public.member WHERE user_id=$1", [extra])
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, command(f, 1))
    ).rejects.toThrow("USAGE_ALLOWANCE_EXHAUSTED")
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      settledUsdMicros: 8_000_000,
    })
  })
  it("rejects expired catalog entries and current guest restrictions", async () => {
    const f = await fixture()
    await pool.query(
      "UPDATE public.model_catalog_entries SET expires_at=clock_timestamp()-interval '1 second' WHERE connection_id=$1",
      [f.connectionId]
    )
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, command(f))
    ).rejects.toThrow("USAGE_MODEL_UNAVAILABLE")
    await pool.query(
      "UPDATE public.model_catalog_entries SET expires_at=NULL WHERE connection_id=$1",
      [f.connectionId]
    )
    await pool.query(
      "UPDATE public.member SET role='guest' WHERE organization_id=$1",
      [f.id]
    )
    await pool.query(
      "INSERT INTO public.workspace_security_settings(workspace_id,block_guest_agent_access) VALUES($1,true)",
      [f.id]
    )
    await expect(
      ledger.admitAgentRunWithUsage(f.actor, command(f))
    ).rejects.toThrow("USAGE_GUEST_AGENT_ACCESS_DENIED")
  })
  it("immutable payer/period/receipts survive run retention", async () => {
    const f = await fixture(),
      c = command(f)
    await ledger.admitAgentRunWithUsage(f.actor, c)
    await settle(f, c.runId, 2_000_000)
    for (const query of [
      "DELETE FROM public.workspace_usage_reservations WHERE workspace_id=$1",
      "UPDATE public.workspace_usage_reservations SET uses_pool=false WHERE workspace_id=$1",
      "UPDATE public.workspace_usage_reservations SET settled_usd_micros=0 WHERE workspace_id=$1",
      "DELETE FROM public.workspace_usage_periods WHERE workspace_id=$1",
      "UPDATE public.workspace_usage_receipts SET result='{}'::jsonb WHERE workspace_id=$1",
    ])
      await expect(pool.query(query, [f.id])).rejects.toMatchObject({
        code: "23514",
      })
    await pool.query("DELETE FROM public.agent_runs WHERE id=$1", [c.runId])
    expect(
      (
        await pool.query(
          "SELECT run_id,operation_id,settled_usd_micros FROM public.workspace_usage_reservations WHERE id=$1",
          [c.runId]
        )
      ).rows[0]
    ).toMatchObject({
      run_id: null,
      operation_id: c.runId,
      settled_usd_micros: "2000000",
    })
    expect(await ledger.inspectWorkspaceUsage(f.id)).toMatchObject({
      settledUsdMicros: 2_000_000,
    })
  })
  it("rolls back run, reservation, initial event and period if audit fails", async () => {
    const f = await fixture(),
      c = command(f),
      name = `usage_fixture_${randomUUID().replaceAll("-", "")}`
    await pool.query(
      `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${f.id}' AND NEW.action='usage.agent.admitted' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END; $$`
    )
    await pool.query(
      `CREATE TRIGGER ${name} BEFORE INSERT ON public.workspace_security_audit_events FOR EACH ROW EXECUTE FUNCTION public.${name}()`
    )
    try {
      await expect(ledger.admitAgentRunWithUsage(f.actor, c)).rejects.toThrow()
      for (const table of [
        "workspace_usage_periods",
        "workspace_usage_reservations",
      ])
        expect(
          (
            await pool.query(
              `SELECT count(*)::int n FROM public.${table} WHERE workspace_id=$1`,
              [f.id]
            )
          ).rows[0].n
        ).toBe(0)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM public.agent_runs WHERE id=$1",
            [c.runId]
          )
        ).rows[0].n
      ).toBe(0)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM public.agent_events WHERE run_id=$1",
            [c.runId]
          )
        ).rows[0].n
      ).toBe(0)
    } finally {
      await pool.query(
        `DROP TRIGGER ${name} ON public.workspace_security_audit_events`
      )
      await pool.query(`DROP FUNCTION public.${name}()`)
    }
    await ledger.admitAgentRunWithUsage(f.actor, c)
  })
})

// @vitest-environment node
import { createHash, createHmac, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import { PAYMENT_GRACE_MS, subscriptionAccess } from "./subscription-access"
import type { EnabledBillingConfig } from "./billing-config.server"
import type * as Store from "./subscription-reconciliation.server"
import type * as Webhook from "./polar-webhook.server"
import type * as Provider from "./polar-subscription-reconciliation.server"
import type * as Database from "@/db"
import type * as Security from "@/application/workspace-security/workspace-security.server"
import type * as Capacity from "./member-capacity-auth.server"

const connection = process.env.FORGE_BILLING_TEST_DATABASE_URL
describe.skipIf(!connection)(
  "PostgreSQL subscription grace and receipts",
  () => {
    const marker = `billing-grace-${randomUUID()}`
    const subscriptions = new Map<string, string>()
    const workspaces: Array<string> = [],
      users: Array<string> = []
    const cleanup: { pool?: Pool; db?: typeof Database } = {}
    let pool: Pool,
      store: typeof Store,
      webhook: typeof Webhook,
      provider: typeof Provider,
      security: typeof Security,
      capacity: typeof Capacity
    const config: EnabledBillingConfig = {
      enabled: true,
      environment: "sandbox",
      accessToken: "fixture-token",
      webhookSecret: "fixture-secret",
      appUrl: "http://localhost:3000",
      paidProducts: {
        starter: {
          usd: "00000000-0000-4000-8000-000000000001",
          eur: "00000000-0000-4000-8000-000000000002",
        },
        plus: {
          usd: "00000000-0000-4000-8000-000000000003",
          eur: "00000000-0000-4000-8000-000000000004",
        },
      },
    }
    const now = new Date(),
      activated = new Date(now.getTime() - 30 * 86400000),
      failed = new Date(now.getTime() - 86400000)

    async function workspace() {
      const id = `${marker}-${workspaces.length}`
      workspaces.push(id)
      subscriptions.set(id, randomUUID())
      await pool.query(
        "INSERT INTO public.organization(id,name,slug) VALUES($1,$1,$1)",
        [id]
      )
      return id
    }
    function snapshot(
      workspaceId: string,
      patch: Partial<Store.VerifiedSubscriptionSnapshot> = {}
    ): Store.VerifiedSubscriptionSnapshot {
      return {
        workspaceId,
        environment: "sandbox",
        subscriptionId: subscriptions.get(workspaceId)!,
        plan: "plus",
        status: "active",
        updatedAt: activated,
        currentPeriodStart: activated,
        currentPeriodEnd: new Date(now.getTime() + 30 * 86400000),
        pastDueAt: null,
        ...patch,
      }
    }
    async function apply(
      value: Store.VerifiedSubscriptionSnapshot,
      eventId = randomUUID()
    ) {
      return store.applyVerifiedSubscriptionSnapshot({
        snapshot: value,
        eventId,
        bodyHash: createHash("sha256").update(eventId).digest("hex"),
      })
    }
    async function row(workspaceId: string) {
      return cleanup.db!.db.query.workspaceEntitlements.findFirst({
        where: (t, { eq }) => eq(t.workspaceId, workspaceId),
      })
    }
    async function add(workspaceId: string) {
      const id = `${marker}-user-${users.length}`
      users.push(id)
      await pool.query(
        'INSERT INTO public."user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [id, `${id}@example.test`]
      )
      await pool.query(
        "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
        [randomUUID(), workspaceId, id]
      )
      return id
    }
    function signed(workspaceId: string, eventId: string) {
      const body = JSON.stringify({
        type: "subscription.updated",
        data: {
          id: subscriptions.get(workspaceId)!,
          customer: { external_id: `forge:workspace:${workspaceId}` },
        },
      })
      const time = Math.floor(Date.now() / 1000)
      const signature = createHmac("sha256", config.webhookSecret)
        .update(`${eventId}.${time}.${body}`)
        .digest("base64")
      return new Request("http://localhost:3000/api/billing/polar/webhook", {
        method: "POST",
        body,
        headers: {
          "webhook-id": eventId,
          "webhook-timestamp": String(time),
          "webhook-signature": `v1,${signature}`,
        },
      })
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
      const identity = await pool.query(
        "SELECT current_database() AS database,current_setting('neon.branch_id',true) AS branch"
      )
      expect(identity.rows[0]).toEqual({
        database: target.database,
        branch: target.branchId,
      })
      const migration = await readFile(
        new URL(
          "../../../drizzle/0028_subscription_binding.sql",
          import.meta.url
        ),
        "utf8"
      )
      const latest = await pool.query(
        "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1"
      )
      expect(latest.rows[0].hash).toBe(
        createHash("sha256").update(migration).digest("hex")
      )
      vi.stubEnv("DATABASE_URL", connection)
      vi.stubEnv(
        "FORGE_INVITE_LINK_SECRET",
        "billing-grace-fixture-signing-secret-only"
      )
      cleanup.db = await import("@/db")
      store = await import("./subscription-reconciliation.server")
      webhook = await import("./polar-webhook.server")
      provider = await import("./polar-subscription-reconciliation.server")
      security =
        await import("@/application/workspace-security/workspace-security.server")
      capacity = await import("./member-capacity-auth.server")
    }, 30_000)

    afterAll(async () => {
      try {
        if (cleanup.pool && workspaces.length) {
          expect(workspaces.every((id) => id.startsWith(marker))).toBe(true)
          await cleanup.pool.query(
            "DELETE FROM public.organization WHERE id=ANY($1::text[])",
            [workspaces]
          )
          await cleanup.pool.query(
            'DELETE FROM public."user" WHERE id=ANY($1::text[])',
            [users]
          )
        }
      } finally {
        if (cleanup.db) await cleanup.db.db.$client.end()
        if (cleanup.pool) await cleanup.pool.end()
        vi.unstubAllEnvs()
      }
    }, 30_000)

    it("processes a signed request through current provider state into one durable receipt and grace", async () => {
      const id = await workspace()
      await apply(snapshot(id))
      const failure = snapshot(id, {
        status: "past_due",
        updatedAt: failed,
        pastDueAt: failed,
      })
      const reconciler = new provider.PolarSubscriptionReconciler(config, {
        subscriptions: {
          get: vi.fn().mockResolvedValue({
            id: failure.subscriptionId,
            product_id: config.paidProducts.plus.usd,
            currency: "usd",
            recurring_interval: "month",
            recurring_interval_count: 1,
            status: failure.status,
            modified_at: failure.updatedAt.toISOString(),
            current_period_start: failure.currentPeriodStart.toISOString(),
            current_period_end: failure.currentPeriodEnd.toISOString(),
            past_due_at: failure.pastDueAt!.toISOString(),
            customer: { external_id: `forge:workspace:${id}` },
          }),
        },
      })
      const event = randomUUID()
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          webhook.handlePolarWebhook(signed(id, event), config, reconciler)
        )
      )
      expect(results.every((result) => result.status === 200)).toBe(true)
      const state = await row(id)
      expect(state?.paymentFailedAt).toEqual(failed)
      expect(state?.graceExpiresAt).toEqual(
        new Date(failed.getTime() + PAYMENT_GRACE_MS)
      )
      expect(subscriptionAccess(state, now)).toMatchObject({
        plan: "business",
        phase: "grace",
        allowsExistingOverage: true,
      })
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM public.billing_event_receipts WHERE workspace_id=$1",
            [id]
          )
        ).rows[0].count
      ).toBe(2)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM public.workspace_security_audit_events WHERE workspace_id=$1",
            [id]
          )
        ).rows[0].count
      ).toBe(2)
    }, 30_000)

    it("does not restart grace, clears it on recovery and ignores older failure snapshots", async () => {
      const id = await workspace(),
        active = snapshot(id)
      await apply(active)
      await apply(
        snapshot(id, {
          status: "past_due",
          updatedAt: failed,
          pastDueAt: failed,
        })
      )
      await apply(
        snapshot(id, {
          status: "past_due",
          updatedAt: now,
          pastDueAt: new Date(failed.getTime() + 3600000),
        })
      )
      expect((await row(id))?.paymentFailedAt).toEqual(failed)
      await apply(snapshot(id, { updatedAt: new Date(now.getTime() + 1) }))
      expect((await row(id))?.graceExpiresAt).toBeNull()
      expect(
        (
          await apply(
            snapshot(id, {
              status: "past_due",
              updatedAt: failed,
              pastDueAt: failed,
            })
          )
        ).outcome
      ).toBe("stale")
      expect(subscriptionAccess(await row(id), now).phase).toBe("paid")
    })

    it("does not grant grace to an unpaid first subscription", async () => {
      const id = await workspace()
      for (let i = 0; i < 5; i++) await add(id)
      await apply(
        snapshot(id, {
          status: "past_due",
          updatedAt: failed,
          pastDueAt: failed,
        })
      )
      expect((await row(id))?.paidActivatedAt).toBeNull()
      expect(subscriptionAccess(await row(id), now).plan).toBe("free")
      expect(await capacity.workspaceAuthMembershipLimit(id)).toBe(5)
      await expect(add(id)).rejects.toMatchObject({
        constraint: "workspace_free_member_limit",
      })
    })

    it("expires paid security overrides and DB admission without a webhook or sweep", async () => {
      const id = await workspace()
      const owner = await add(id)
      for (let i = 0; i < 4; i++) await add(id)
      await apply(snapshot(id))
      const oldFailure = new Date(now.getTime() - 8 * 86400000)
      await apply(
        snapshot(id, {
          status: "past_due",
          updatedAt: oldFailure,
          pastDueAt: oldFailure,
        })
      )
      await pool.query(
        "UPDATE public.workspace_entitlements SET feature_overrides=$2::jsonb WHERE workspace_id=$1",
        [id, JSON.stringify({ "restrict-invitations": true })]
      )
      expect(await capacity.workspaceAuthMembershipLimit(id)).toBe(5)
      await expect(add(id)).rejects.toMatchObject({
        constraint: "workspace_free_member_limit",
      })
      const state = await security.getWorkspaceSecuritySnapshot(
        {
          workspaceId: id,
          userId: owner,
          workspaceRole: "owner",
          scopes: null,
          authentication: { kind: "session", sessionId: "fixture" },
        },
        "http://localhost:3000"
      )
      expect(state.plan).toBe("free")
      expect(state.entitlements["restrict-invitations"]).toBe(false)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM public.member WHERE organization_id=$1",
            [id]
          )
        ).rows[0].count
      ).toBe(5)
    })

    it("rejects event-ID reuse with another body and conflicting equal-version snapshots", async () => {
      const id = await workspace(),
        eventId = randomUUID(),
        active = snapshot(id)
      await apply(active, eventId)
      await expect(
        store.applyVerifiedSubscriptionSnapshot({
          eventId,
          bodyHash: "b".repeat(64),
          snapshot: active,
        })
      ).rejects.toThrow("BILLING_EVENT_CONFLICT")
      await expect(apply({ ...active, plan: "starter" })).rejects.toThrow(
        "BILLING_VERSION_CONFLICT"
      )
      expect((await row(id))?.plan).toBe("business")
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM public.billing_event_receipts WHERE workspace_id=$1",
            [id]
          )
        ).rows[0].count
      ).toBe(1)
    })

    it("rolls back entitlement mutation and receipt if the audit write fails", async () => {
      const id = await workspace(),
        name = `billing_fixture_${randomUUID().replaceAll("-", "")}`
      // This invocation's constraint only rejects its own fixture workspace.
      await pool.query(
        `ALTER TABLE public.workspace_security_audit_events ADD CONSTRAINT ${name} CHECK(workspace_id <> '${id}') NOT VALID`
      )
      try {
        await expect(apply(snapshot(id))).rejects.toThrow()
        expect(await row(id)).toBeUndefined()
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM public.billing_event_receipts WHERE workspace_id=$1",
              [id]
            )
          ).rows[0].count
        ).toBe(0)
      } finally {
        await pool.query(
          `ALTER TABLE public.workspace_security_audit_events DROP CONSTRAINT ${name}`
        )
      }
      expect((await apply(snapshot(id))).outcome).toBe("applied")
    })
    it("rejects attaching the same provider subscription to another workspace atomically", async () => {
      const first = await workspace(),
        second = await workspace()
      const paid = snapshot(first)
      await apply(paid)
      await expect(
        apply({ ...snapshot(second), subscriptionId: paid.subscriptionId })
      ).rejects.toThrow()
      expect(await row(second)).toBeUndefined()
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM public.billing_event_receipts WHERE workspace_id=$1",
            [second]
          )
        ).rows[0].count
      ).toBe(0)
    })
    it("enforces 168 elapsed hours even when the database session crosses daylight saving", async () => {
      const id = await workspace()
      const start = new Date("2026-10-01T12:00:00Z"),
        failure = new Date("2026-10-24T12:00:00Z")
      const paid = snapshot(id, {
        updatedAt: start,
        currentPeriodStart: start,
        currentPeriodEnd: new Date("2026-11-01T12:00:00Z"),
      })
      await apply(paid)
      await apply({
        ...paid,
        status: "past_due",
        updatedAt: failure,
        pastDueAt: failure,
      })
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        await client.query("SET LOCAL TIME ZONE 'Europe/Paris'")
        await expect(
          client.query(
            "UPDATE public.workspace_entitlements SET grace_expires_at=payment_failed_at+interval '7 days' WHERE workspace_id=$1",
            [id]
          )
        ).rejects.toMatchObject({
          constraint: "workspace_entitlements_grace_check",
        })
      } finally {
        await client.query("ROLLBACK")
        client.release()
      }
      expect((await row(id))?.graceExpiresAt).toEqual(
        new Date("2026-10-31T12:00:00Z")
      )
    })
  }
)

// @vitest-environment node
import { createHash, createHmac, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import { PAYMENT_GRACE_MS, subscriptionAccess } from "./subscription-access"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { ProviderRefundOrder } from "./polar-subscription-refund.server"
import type * as Store from "./subscription-reconciliation.server"
import type * as Webhook from "./polar-webhook.server"
import type * as Provider from "./polar-subscription-reconciliation.server"
import type * as Database from "@/db"
import type * as Security from "@/application/workspace-security/workspace-security.server"
import type * as Capacity from "./member-capacity-auth.server"
import type * as Cancellation from "./polar-subscription-cancellation.server"
import type * as CancellationContext from "./subscription-cancellation-context.server"
import type { Actor } from "@/application/actor"

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
      capacity: typeof Capacity,
      cancellation: typeof Cancellation,
      cancellationContext: typeof CancellationContext
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
    function providerSubscription(
      id: string,
      paid: Store.VerifiedSubscriptionSnapshot,
      patch: Partial<Provider.ProviderSubscription> = {}
    ): Provider.ProviderSubscription {
      return {
        id: paid.subscriptionId,
        product_id: config.paidProducts.plus.usd,
        currency: "usd",
        customer: { external_id: `forge:workspace:${id}` },
        status: "active",
        recurring_interval: "month",
        recurring_interval_count: 1,
        modified_at: paid.updatedAt.toISOString(),
        current_period_start: paid.currentPeriodStart.toISOString(),
        current_period_end: paid.currentPeriodEnd.toISOString(),
        past_due_at: null,
        cancel_at_period_end: false,
        ends_at: null,
        ended_at: null,
        ...patch,
      }
    }
    function refundOrder(
      id: string,
      paid: Store.VerifiedSubscriptionSnapshot,
      orderId = randomUUID()
    ): ProviderRefundOrder {
      return {
        id: orderId,
        status: "refunded" as const,
        net_amount: 1600,
        tax_amount: 320,
        total_amount: 1920,
        refunded_amount: 1600,
        refunded_tax_amount: 320,
        applied_balance_amount: 0,
        billing_reason: "subscription_cycle" as const,
        currency: "usd",
        product_id: config.paidProducts.plus.usd,
        subscription_id: paid.subscriptionId,
        modified_at: now.toISOString(),
        customer: { external_id: `forge:workspace:${id}` },
        items: [
          {
            amount: 1600,
            tax_amount: 320,
            proration: false,
            start_timestamp: paid.currentPeriodStart.toISOString(),
            end_timestamp: paid.currentPeriodEnd.toISOString(),
          },
        ],
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
    function signed(
      workspaceId: string,
      eventId: string,
      type = "subscription.updated",
      objectId = subscriptions.get(workspaceId)!
    ) {
      const body = JSON.stringify({
        type,
        data: {
          id: objectId,
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
          "../../../drizzle/0031_subscription_termination.sql",
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
      cancellation = await import("./polar-subscription-cancellation.server")
      cancellationContext =
        await import("./subscription-cancellation-context.server")
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

    it.each(["active", "past_due", "canceled"] as const)(
      "immediately terminates signed %s access while retaining its prior clocks and members",
      async (status) => {
        const id = await workspace(),
          paid = snapshot(id)
        await apply(paid)
        if (status !== "active")
          await apply({
            ...paid,
            status,
            updatedAt: failed,
            pastDueAt: status === "past_due" ? failed : null,
            cancelAtPeriodEnd: status === "canceled",
          })
        let owner = ""
        for (let i = 0; i < 6; i++) owner = await add(id)
        await pool.query(
          "UPDATE workspace_entitlements SET feature_overrides=$2::jsonb WHERE workspace_id=$1",
          [id, JSON.stringify({ "restrict-invitations": true })]
        )
        const before = await row(id),
          eventId = randomUUID()
        const service = new provider.PolarSubscriptionReconciler(config, {
          subscriptions: {
            get: () =>
              Promise.resolve(
                providerSubscription(id, paid, {
                  status: status === "past_due" ? "unpaid" : "canceled",
                  modified_at: now.toISOString(),
                  ended_at: status === "past_due" ? null : now.toISOString(),
                })
              ),
          },
        })
        for (let retry = 0; retry < 2; retry++)
          expect(
            (
              await webhook.handlePolarWebhook(
                signed(id, eventId, "subscription.revoked"),
                config,
                service
              )
            ).status
          ).toBe(200)
        const after = await row(id)
        expect(after?.terminatedAt).toEqual(now)
        expect(after?.paymentFailedAt).toEqual(before?.paymentFailedAt)
        expect(after?.graceExpiresAt).toEqual(before?.graceExpiresAt)
        expect(after?.cancellationPeriodEnd).toEqual(
          before?.cancellationPeriodEnd
        )
        expect(after?.providerStateHash).toBe(before?.providerStateHash)
        expect(subscriptionAccess(after, now)).toMatchObject({
          plan: "free",
          allowsExistingOverage: false,
        })
        expect(await capacity.workspaceAuthMembershipLimit(id)).toBe(5)
        await expect(add(id)).rejects.toThrow(/five-member/)
        expect(
          (
            await pool.query(
              "SELECT active_member_count FROM workspace_member_capacity WHERE workspace_id=$1",
              [id]
            )
          ).rows[0].active_member_count
        ).toBe(6)
        const view = await security.getWorkspaceSecuritySnapshot(
          {
            workspaceId: id,
            userId: owner,
            workspaceRole: "owner",
            scopes: null,
            authentication: { kind: "session", sessionId: "fixture" },
          },
          "http://localhost:3000"
        )
        expect(view.plan).toBe("free")
        expect(view.entitlements["restrict-invitations"]).toBe(false)
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM workspace_security_audit_events WHERE request_id=$1 AND action='billing.subscription.terminated'",
              [eventId]
            )
          ).rows[0].count
        ).toBe(1)
      }
    )

    it("retains termination arriving before first activation and ignores later paid/grace snapshots for that ID", async () => {
      const id = await workspace(),
        paid = snapshot(id),
        terminal = {
          ...paid,
          status: "canceled" as const,
          updatedAt: now,
          terminatedAt: now,
          cancelAtPeriodEnd: false,
        }
      await apply(terminal)
      expect((await row(id))?.paidActivatedAt).toBeNull()
      for (const value of [
        paid,
        { ...paid, updatedAt: new Date(now.getTime() + 1) },
        {
          ...paid,
          status: "past_due" as const,
          updatedAt: new Date(now.getTime() + 2),
          pastDueAt: failed,
        },
      ]) {
        expect((await apply(value)).outcome).toBe("unchanged")
        expect(subscriptionAccess(await row(id), now).plan).toBe("free")
      }
      await expect(
        apply({ ...paid, subscriptionId: randomUUID() })
      ).rejects.toThrow(/SUBSCRIPTION_CONFLICT/)
    })

    it.each(["older", "equal"])(
      "accepts restrictive %s-version termination without rewriting the normal state fingerprint",
      async (order) => {
        const id = await workspace(),
          paid = snapshot(id)
        await apply({ ...paid, updatedAt: now })
        const before = await row(id),
          terminalAt = new Date(now.getTime() - 2000),
          version = new Date(now.getTime() - (order === "older" ? 1000 : 0))
        expect(
          (
            await apply({
              ...paid,
              status: "canceled",
              cancelAtPeriodEnd: false,
              updatedAt: version,
              terminatedAt: terminalAt,
            })
          ).outcome
        ).toBe("applied")
        expect((await row(id))?.providerStateHash).toBe(
          before?.providerStateHash
        )
        await Promise.all([
          apply({
            ...paid,
            updatedAt: new Date(now.getTime() + 1),
            currentPeriodStart: paid.currentPeriodEnd,
            currentPeriodEnd: new Date(
              paid.currentPeriodEnd.getTime() + 30 * 86400000
            ),
          }),
          apply({
            ...paid,
            status: "canceled",
            updatedAt: new Date(now.getTime() + 2),
            terminatedAt: now,
          }),
        ])
        expect((await row(id))?.terminatedAt).toEqual(terminalAt)
        expect(subscriptionAccess(await row(id), now).plan).toBe("free")
      }
    )

    it("promotes a cached active event to terminal state atomically and rolls back a failed audit", async () => {
      const id = await workspace(),
        paid = snapshot(id),
        eventId = randomUUID()
      let current = providerSubscription(id, paid)
      const service = new provider.PolarSubscriptionReconciler(config, {
        subscriptions: { get: () => Promise.resolve(current) },
      })
      expect(
        (await webhook.handlePolarWebhook(signed(id, eventId), config, service))
          .status
      ).toBe(200)
      current = providerSubscription(id, paid, {
        status: "unpaid",
        modified_at: now.toISOString(),
      })
      const constraint = `termination_fault_${randomUUID().replaceAll("-", "")}`
      await pool.query(
        `ALTER TABLE workspace_security_audit_events ADD CONSTRAINT ${constraint} CHECK (action <> 'billing.subscription.terminated') NOT VALID`
      )
      try {
        expect(
          (
            await webhook.handlePolarWebhook(
              signed(id, eventId),
              config,
              service
            )
          ).status
        ).toBe(503)
        expect((await row(id))?.terminatedAt).toBeNull()
      } finally {
        await pool.query(
          `ALTER TABLE workspace_security_audit_events DROP CONSTRAINT ${constraint}`
        )
      }
      expect(
        (await webhook.handlePolarWebhook(signed(id, eventId), config, service))
          .status
      ).toBe(200)
      expect(subscriptionAccess(await row(id), now).plan).toBe("free")
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM billing_event_receipts WHERE event_id=$1",
            [eventId]
          )
        ).rows[0].count
      ).toBe(1)
    })

    it("revokes a fully refunded term through a signed webhook, preserves members, and survives newer active events", async () => {
      const id = await workspace(),
        paid = snapshot(id)
      await apply(paid)
      for (let i = 0; i < 6; i++) await add(id)
      const refunds = await import("./polar-subscription-refund.server")
      const orderId = randomUUID(),
        eventId = randomUUID()
      const order = refundOrder(id, paid, orderId)
      const service = new refunds.PolarSubscriptionRefundReconciler(config, {
        orders: { get: () => Promise.resolve(order) },
      })
      for (let i = 0; i < 2; i++)
        expect(
          (
            await webhook.handlePolarWebhook(
              signed(id, eventId, "order.refunded", orderId),
              config,
              undefined,
              service
            )
          ).status
        ).toBe(200)
      // Same event ID with different signed bytes cannot consume another receipt.
      expect(
        (
          await webhook.handlePolarWebhook(
            signed(id, eventId, "order.refunded", randomUUID()),
            config,
            undefined,
            service
          )
        ).status
      ).toBe(503)
      await apply({ ...paid, updatedAt: now })
      expect(subscriptionAccess(await row(id), now).plan).toBe("free")
      expect(await capacity.workspaceAuthMembershipLimit(id)).toBe(5)
      await pool.query(
        "UPDATE workspace_entitlements SET feature_overrides=$2::jsonb WHERE workspace_id=$1",
        [id, JSON.stringify({ "restrict-invitations": true })]
      )
      const owner = (
        await pool.query(
          "SELECT user_id FROM member WHERE organization_id=$1 LIMIT 1",
          [id]
        )
      ).rows[0].user_id
      const view = await security.getWorkspaceSecuritySnapshot(
        {
          workspaceId: id,
          userId: owner,
          workspaceRole: "owner",
          scopes: null,
          authentication: { kind: "session", sessionId: "fixture" },
        },
        "http://localhost:3000"
      )
      expect(view.plan).toBe("free")
      expect(view.entitlements["restrict-invitations"]).toBe(false)
      await expect(add(id)).rejects.toThrow(/five-member/)
      expect(
        (
          await pool.query(
            "SELECT active_member_count FROM workspace_member_capacity WHERE workspace_id=$1",
            [id]
          )
        ).rows[0].active_member_count
      ).toBe(6)
      expect((await row(id))?.refundedPeriods).toHaveLength(1)
      const later = {
        ...paid,
        updatedAt: new Date(now.getTime() + 1),
        currentPeriodStart: paid.currentPeriodEnd,
        currentPeriodEnd: new Date(
          paid.currentPeriodEnd.getTime() + 30 * 86400000
        ),
      }
      await apply(later)
      expect(
        subscriptionAccess(await row(id), later.currentPeriodStart).plan
      ).toBe("business")
      await service.reconcile({
        workspaceId: id,
        orderId,
        eventId: randomUUID(),
        bodyHash: "b".repeat(64),
      })
      expect(
        subscriptionAccess(await row(id), later.currentPeriodStart).plan
      ).toBe("business")
    })

    it.each(["active", "past_due", "canceled"] as const)(
      "receipts a signed partial refund without changing %s access or its clocks",
      async (status) => {
        const id = await workspace(),
          paid = snapshot(id)
        await apply(paid)
        if (status !== "active")
          await apply({
            ...paid,
            status,
            updatedAt: failed,
            pastDueAt: status === "past_due" ? failed : null,
            cancelAtPeriodEnd: status === "canceled",
          })
        const before = await row(id),
          refundProvider = await import("./polar-subscription-refund.server")
        const order = refundOrder(id, paid)
        order.status = "partially_refunded"
        order.refunded_amount = 100
        order.refunded_tax_amount = 20
        const service = new refundProvider.PolarSubscriptionRefundReconciler(
          config,
          {
            orders: { get: () => Promise.resolve(order) },
          }
        )
        const eventId = randomUUID()
        for (let retry = 0; retry < 2; retry++)
          expect(
            (
              await webhook.handlePolarWebhook(
                signed(id, eventId, "order.refunded", order.id),
                config,
                undefined,
                service
              )
            ).status
          ).toBe(200)
        expect(await row(id)).toEqual(before)
        expect(subscriptionAccess(await row(id), now)).toEqual(
          subscriptionAccess(before, now)
        )
        expect(await capacity.workspaceAuthMembershipLimit(id)).toBe(
          Number.MAX_SAFE_INTEGER
        )
        for (let i = 0; i < 6; i++) await add(id)
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM billing_event_receipts WHERE event_id=$1",
              [eventId]
            )
          ).rows[0].count
        ).toBe(1)
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM workspace_security_audit_events WHERE request_id=$1 AND action='billing.subscription_period.partially_refunded'",
              [eventId]
            )
          ).rows[0].count
        ).toBe(1)
      }
    )

    it("promotes a replayed partial receipt after cumulative full refund and never restores access from a late partial", async () => {
      const id = await workspace(),
        paid = snapshot(id)
      await apply(paid)
      const refundProvider = await import("./polar-subscription-refund.server"),
        sink = await import("./subscription-refund.server")
      const order = refundOrder(id, paid),
        eventId = randomUUID()
      order.status = "partially_refunded"
      order.refunded_amount = 100
      order.refunded_tax_amount = 20
      const service = new refundProvider.PolarSubscriptionRefundReconciler(
        config,
        {
          orders: { get: () => Promise.resolve(order) },
        }
      )
      expect(
        (
          await webhook.handlePolarWebhook(
            signed(id, eventId, "order.refunded", order.id),
            config,
            undefined,
            service
          )
        ).status
      ).toBe(200)
      const partial = refundProvider.verifiedPolarPeriodRefund(
        config,
        id,
        order.id,
        order
      )
      order.status = "refunded"
      order.refunded_amount = order.net_amount
      order.refunded_tax_amount = order.tax_amount
      const constraint = `promotion_fault_${randomUUID().replaceAll("-", "")}`
      await pool.query(
        `ALTER TABLE workspace_security_audit_events ADD CONSTRAINT ${constraint} CHECK (action <> 'billing.subscription_period.refunded') NOT VALID`
      )
      try {
        expect(
          (
            await webhook.handlePolarWebhook(
              signed(id, eventId, "order.refunded", order.id),
              config,
              undefined,
              service
            )
          ).status
        ).toBe(503)
        expect(
          (
            await pool.query(
              "SELECT outcome FROM billing_event_receipts WHERE event_id=$1",
              [eventId]
            )
          ).rows[0].outcome
        ).toBe("unchanged")
        expect((await row(id))?.refundedPeriods).toHaveLength(0)
        expect(subscriptionAccess(await row(id), now).plan).toBe("business")
      } finally {
        await pool.query(
          `ALTER TABLE workspace_security_audit_events DROP CONSTRAINT ${constraint}`
        )
      }

      expect(
        (
          await webhook.handlePolarWebhook(
            signed(id, eventId, "order.refunded", order.id),
            config,
            undefined,
            service
          )
        ).status
      ).toBe(200)
      expect(
        (
          await pool.query(
            "SELECT outcome FROM billing_event_receipts WHERE event_id=$1",
            [eventId]
          )
        ).rows[0].outcome
      ).toBe("applied")
      const denied = await row(id)
      await sink.applyVerifiedPeriodRefund({
        eventId: randomUUID(),
        bodyHash: "f".repeat(64),
        refund: partial,
      })
      expect(await row(id)).toEqual(denied)
      expect(subscriptionAccess(await row(id), now).plan).toBe("free")
      expect((await row(id))?.refundedPeriods).toHaveLength(1)
    })

    it("does not create entitlement state for a partial refund arriving before activation", async () => {
      const id = await workspace(),
        paid = snapshot(id),
        sink = await import("./subscription-refund.server")
      await sink.applyVerifiedPeriodRefund({
        eventId: randomUUID(),
        bodyHash: "1".repeat(64),
        refund: {
          kind: "partial",
          workspaceId: id,
          environment: "sandbox",
          subscriptionId: paid.subscriptionId,
          orderId: randomUUID(),
          start: paid.currentPeriodStart.toISOString(),
          end: paid.currentPeriodEnd.toISOString(),
          refundedAt: now.toISOString(),
        },
      })
      expect(await row(id)).toBeUndefined()
      await apply(paid)
      expect(subscriptionAccess(await row(id), now).plan).toBe("business")
    })

    it("rolls back partial refund audit and receipt together without changing access", async () => {
      const id = await workspace(),
        paid = snapshot(id),
        sink = await import("./subscription-refund.server")
      await apply(paid)
      const before = await row(id),
        constraint = `partial_fault_${randomUUID().replaceAll("-", "")}`
      const input = {
        eventId: randomUUID(),
        bodyHash: "2".repeat(64),
        refund: {
          kind: "partial" as const,
          workspaceId: id,
          environment: "sandbox" as const,
          subscriptionId: paid.subscriptionId,
          orderId: randomUUID(),
          start: paid.currentPeriodStart.toISOString(),
          end: paid.currentPeriodEnd.toISOString(),
          refundedAt: now.toISOString(),
        },
      }
      await pool.query(
        `ALTER TABLE workspace_security_audit_events ADD CONSTRAINT ${constraint} CHECK (action <> 'billing.subscription_period.partially_refunded') NOT VALID`
      )
      try {
        await expect(sink.applyVerifiedPeriodRefund(input)).rejects.toThrow()
      } finally {
        await pool.query(
          `ALTER TABLE workspace_security_audit_events DROP CONSTRAINT ${constraint}`
        )
      }
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM billing_event_receipts WHERE event_id=$1",
            [input.eventId]
          )
        ).rows[0].count
      ).toBe(0)
      expect(await row(id)).toEqual(before)
      expect((await sink.applyVerifiedPeriodRefund(input)).replayed).toBe(false)
      expect(await row(id)).toEqual(before)
    })

    it("keeps a refund delivered before activation and denies overlapping replacement snapshots", async () => {
      const id = await workspace(),
        paid = snapshot(id),
        refunds = await import("./subscription-refund.server")
      const refund = {
        workspaceId: id,
        environment: "sandbox" as const,
        orderId: randomUUID(),
        subscriptionId: paid.subscriptionId,
        start: paid.currentPeriodStart.toISOString(),
        end: paid.currentPeriodEnd.toISOString(),
        refundedAt: now.toISOString(),
      }
      await refunds.applyVerifiedPeriodRefund({
        eventId: randomUUID(),
        bodyHash: "a".repeat(64),
        refund,
      })
      await apply(paid)
      expect(subscriptionAccess(await row(id), now).plan).toBe("free")
      await apply({
        ...paid,
        updatedAt: now,
        currentPeriodStart: new Date(paid.currentPeriodStart.getTime() + 1000),
      })
      expect(subscriptionAccess(await row(id), now).plan).toBe("free")
      await apply({
        ...paid,
        status: "past_due",
        updatedAt: new Date(now.getTime() + 1),
        pastDueAt: failed,
      })
      expect(subscriptionAccess(await row(id), now).plan).toBe("free")
    })

    it("does not regrant access through failed-renewal grace after the paid term was refunded", async () => {
      const id = await workspace(),
        paid = snapshot(id),
        refunds = await import("./subscription-refund.server")
      await apply(paid)
      await refunds.applyVerifiedPeriodRefund({
        eventId: randomUUID(),
        bodyHash: "e".repeat(64),
        refund: {
          workspaceId: id,
          environment: "sandbox",
          subscriptionId: paid.subscriptionId,
          orderId: randomUUID(),
          start: paid.currentPeriodStart.toISOString(),
          end: paid.currentPeriodEnd.toISOString(),
          refundedAt: now.toISOString(),
        },
      })
      const next = {
        ...paid,
        status: "past_due" as const,
        updatedAt: paid.currentPeriodEnd,
        pastDueAt: paid.currentPeriodEnd,
        currentPeriodStart: paid.currentPeriodEnd,
        currentPeriodEnd: new Date(
          paid.currentPeriodEnd.getTime() + 30 * 86400000
        ),
      }
      for (let retry = 0; retry < 2; retry++) {
        await apply({
          ...next,
          updatedAt: new Date(next.updatedAt.getTime() + retry),
        })
        expect(
          subscriptionAccess(await row(id), next.currentPeriodStart).plan
        ).toBe("free")
        expect((await row(id))?.paidActivatedAt).toBeNull()
      }
      await apply({
        ...next,
        status: "active",
        pastDueAt: null,
        updatedAt: new Date(next.updatedAt.getTime() + 2),
      })
      expect(
        subscriptionAccess(
          await row(id),
          new Date(next.currentPeriodStart.getTime() + 2)
        ).plan
      ).toBe("business")
    })

    it("serializes concurrent refunds and activation without losing either denial", async () => {
      const id = await workspace(),
        paid = snapshot(id),
        refunds = await import("./subscription-refund.server")
      const refund = {
        workspaceId: id,
        environment: "sandbox" as const,
        subscriptionId: paid.subscriptionId,
        start: paid.currentPeriodStart.toISOString(),
        end: paid.currentPeriodEnd.toISOString(),
        refundedAt: now.toISOString(),
      }
      await Promise.all([
        apply(paid),
        ...Array.from({ length: 2 }, () =>
          refunds.applyVerifiedPeriodRefund({
            eventId: randomUUID(),
            bodyHash: "d".repeat(64),
            refund: { ...refund, orderId: randomUUID() },
          })
        ),
      ])
      expect((await row(id))?.refundedPeriods).toHaveLength(2)
      expect(subscriptionAccess(await row(id), now).plan).toBe("free")
    })

    it("rolls back a refund and its receipt if audit persistence fails", async () => {
      const id = await workspace(),
        paid = snapshot(id),
        refunds = await import("./subscription-refund.server")
      await apply(paid)
      const constraint = `refund_fault_${randomUUID().replaceAll("-", "")}`
      await pool.query(
        `ALTER TABLE workspace_security_audit_events ADD CONSTRAINT ${constraint} CHECK (action <> 'billing.subscription_period.refunded') NOT VALID`
      )
      const input = {
        eventId: randomUUID(),
        bodyHash: "c".repeat(64),
        refund: {
          workspaceId: id,
          environment: "sandbox" as const,
          orderId: randomUUID(),
          subscriptionId: paid.subscriptionId,
          start: paid.currentPeriodStart.toISOString(),
          end: paid.currentPeriodEnd.toISOString(),
          refundedAt: now.toISOString(),
        },
      }
      try {
        await expect(refunds.applyVerifiedPeriodRefund(input)).rejects.toThrow()
        expect((await row(id))?.refundedPeriods).toHaveLength(0)
      } finally {
        await pool.query(
          `ALTER TABLE workspace_security_audit_events DROP CONSTRAINT ${constraint}`
        )
      }
      expect((await refunds.applyVerifiedPeriodRefund(input)).replayed).toBe(
        false
      )
      expect(subscriptionAccess(await row(id), now).plan).toBe("free")
    })

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
            cancel_at_period_end: false,
            ends_at: null,
            ended_at: null,
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
    it("schedules cancellation with live owner authority and denies replay after revocation", async () => {
      const id = await workspace(),
        owner = await add(id),
        paid = snapshot(id)
      await apply(paid)
      const actor: Actor = {
        workspaceId: id,
        userId: owner,
        workspaceRole: "owner",
        scopes: null,
        authentication: { kind: "session", sessionId: "fixture" },
      }
      let current: Provider.ProviderSubscription = {
        id: paid.subscriptionId,
        product_id: config.paidProducts.plus.usd,
        currency: "usd",
        status: "active",
        modified_at: paid.updatedAt.toISOString(),
        current_period_start: paid.currentPeriodStart.toISOString(),
        current_period_end: paid.currentPeriodEnd.toISOString(),
        recurring_interval: "month",
        recurring_interval_count: 1,
        past_due_at: null,
        cancel_at_period_end: false,
        ends_at: null,
        ended_at: null,
        customer: { external_id: `forge:workspace:${id}` },
      }
      const get = vi.fn(() => Promise.resolve(current)),
        update = vi.fn(() => {
          current = {
            ...current,
            cancel_at_period_end: true,
            ends_at: current.current_period_end,
            modified_at: now.toISOString(),
          }
          return Promise.resolve(current)
        })
      const service = new cancellation.PolarSubscriptionCancellation(
        config,
        (a) => cancellationContext.readCancellationContext(a, "sandbox"),
        { subscriptions: { get, update } }
      )
      expect((await service.schedule(actor)).status).toBe("scheduled")
      await service.schedule(actor)
      expect(update).toHaveBeenCalledTimes(1)
      expect((await row(id))?.cancellationPeriodEnd).toEqual(
        paid.currentPeriodEnd
      )
      const audit = await pool.query(
        "SELECT actor_user_id FROM public.workspace_security_audit_events WHERE workspace_id=$1 AND actor_user_id IS NOT NULL",
        [id]
      )
      expect(audit.rows.map((r) => r.actor_user_id)).toEqual([owner])
      const receipt = await pool.query(
        "SELECT event_id,body_hash FROM public.billing_event_receipts WHERE workspace_id=$1 AND event_id LIKE 'forge.cancel.%'",
        [id]
      )
      await pool.query(
        "UPDATE public.member SET role='member' WHERE organization_id=$1 AND user_id=$2",
        [id, owner]
      )
      await expect(service.schedule(actor)).rejects.toThrow("REVOKED")
      await expect(
        store.applyVerifiedSubscriptionSnapshot({
          eventId: receipt.rows[0].event_id,
          bodyHash: receipt.rows[0].body_hash,
          snapshot: { ...paid, updatedAt: now, cancelAtPeriodEnd: true },
          actor,
        })
      ).rejects.toThrow("REVOKED")
    })
    it("rechecks roles after a provider read before a cancellation write", async () => {
      const id = await workspace(),
        owner = await add(id),
        paid = snapshot(id)
      await apply(paid)
      const actor: Actor = {
        workspaceId: id,
        userId: owner,
        workspaceRole: "owner",
        scopes: null,
        authentication: { kind: "session", sessionId: "fixture" },
      }
      const update = vi.fn()
      const get = vi.fn(async () => {
        await pool.query(
          "UPDATE public.member SET role='member' WHERE organization_id=$1 AND user_id=$2",
          [id, owner]
        )
        return {
          id: paid.subscriptionId,
          product_id: config.paidProducts.plus.usd,
          currency: "usd",
          status: "active" as const,
          modified_at: paid.updatedAt.toISOString(),
          current_period_start: paid.currentPeriodStart.toISOString(),
          current_period_end: paid.currentPeriodEnd.toISOString(),
          recurring_interval: "month" as const,
          recurring_interval_count: 1,
          past_due_at: null,
          cancel_at_period_end: false,
          ends_at: null,
          ended_at: null,
          customer: { external_id: `forge:workspace:${id}` },
        }
      })
      const service = new cancellation.PolarSubscriptionCancellation(
        config,
        (a) => cancellationContext.readCancellationContext(a, "sandbox"),
        { subscriptions: { get, update } }
      )
      await expect(service.schedule(actor)).rejects.toThrow("REVOKED")
      expect(update).not.toHaveBeenCalled()
      expect((await row(id))?.cancelAtPeriodEnd).toBe(false)
    })
    it("freezes the cancellation cutoff across later periods and clears it only after confirmed uncancellation", async () => {
      const id = await workspace(),
        paid = snapshot(id)
      await apply(paid)
      await apply({ ...paid, updatedAt: failed, cancelAtPeriodEnd: true })
      const laterEnd = new Date(paid.currentPeriodEnd.getTime() + 86400000)
      await apply({
        ...paid,
        updatedAt: now,
        currentPeriodEnd: laterEnd,
        cancelAtPeriodEnd: true,
      })
      expect((await row(id))?.cancellationPeriodEnd).toEqual(
        paid.currentPeriodEnd
      )
      expect(
        subscriptionAccess(await row(id), paid.currentPeriodEnd).plan
      ).toBe("free")
      await apply({
        ...paid,
        updatedAt: new Date(now.getTime() + 1),
        currentPeriodEnd: laterEnd,
        cancelAtPeriodEnd: false,
      })
      expect((await row(id))?.cancellationPeriodEnd).toBeNull()
      expect(
        subscriptionAccess(await row(id), paid.currentPeriodEnd).plan
      ).toBe("business")
    })
    it("does not turn grace into a full unpaid period when cancellation is confirmed", async () => {
      const id = await workspace(),
        paid = snapshot(id)
      await apply(paid)
      await apply({
        ...paid,
        status: "past_due",
        updatedAt: failed,
        pastDueAt: failed,
      })
      await apply({
        ...paid,
        status: "canceled",
        updatedAt: now,
        cancelAtPeriodEnd: true,
      })
      const state = await row(id)
      expect(state?.paymentFailedAt).toEqual(failed)
      expect(
        subscriptionAccess(state, new Date(failed.getTime() + PAYMENT_GRACE_MS))
          .plan
      ).toBe("free")
      expect(state?.cancellationPeriodEnd).toEqual(paid.currentPeriodEnd)
    })
    it("keeps legacy fingerprints compatible while refusing equal-version reactivation", async () => {
      const id = await workspace(),
        paid = snapshot(id)
      await apply(paid)
      expect((await row(id))?.providerStateHash).toBe(
        createHash("sha256").update(JSON.stringify(paid)).digest("hex")
      )
      expect((await apply({ ...paid, cancelAtPeriodEnd: false })).outcome).toBe(
        "unchanged"
      )
      expect((await apply({ ...paid, cancelAtPeriodEnd: true })).outcome).toBe(
        "applied"
      )
      await expect(
        apply({ ...paid, cancelAtPeriodEnd: false })
      ).rejects.toThrow("VERSION_CONFLICT")
      const unpaid = await workspace()
      await apply(
        snapshot(unpaid, { status: "canceled", cancelAtPeriodEnd: true })
      )
      expect(subscriptionAccess(await row(unpaid), now).plan).toBe("free")
    })
  }
)

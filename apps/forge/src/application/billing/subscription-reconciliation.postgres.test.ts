// @vitest-environment node
import { createHash, createHmac, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import { PAYMENT_GRACE_MS, subscriptionAccess } from "./subscription-access"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { UpgradeOrder } from "./polar-paid-upgrade.server"
import type { PlanChangeSubscription } from "./polar-plan-change.server"
import type { RefundRenewalClient } from "./polar-upgrade-refund-renewal.server"
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
        pause_at_period_end: false,
        paused_at: null,
        resumes_at: null,
        ...patch,
      }
    }
    function upgradeOrder(
      id: string,
      paid: Store.VerifiedSubscriptionSnapshot,
      orderId: string = randomUUID()
    ): UpgradeOrder {
      return {
        id: orderId,
        subscription_id: paid.subscriptionId,
        product_id: config.paidProducts.plus.usd,
        currency: "usd",
        customer: { external_id: `forge:workspace:${id}` },
        status: "paid",
        paid: true,
        billing_reason: "subscription_update",
        net_amount: 60,
        tax_amount: 0,
        total_amount: 60,
        due_amount: 0,
        refunded_amount: 0,
        refunded_tax_amount: 0,
        created_at: now.toISOString(),
        items: [
          {
            proration: true,
            amount: 60,
            start_timestamp: now.toISOString(),
            end_timestamp: paid.currentPeriodEnd.toISOString(),
          },
        ],
      }
    }
    function refundRenewalProvider(
      id: string,
      paid: Store.VerifiedSubscriptionSnapshot
    ) {
      const current: PlanChangeSubscription = {
        ...providerSubscription(id, paid, { modified_at: now.toISOString() }),
        amount: 4800,
        seats: 3,
        pause_at_period_end: false,
        paused_at: null,
        pending_update: {
          id: randomUUID(),
          created_at: now.toISOString(),
          modified_at: null,
          applies_at: paid.currentPeriodEnd.toISOString(),
          product_id: null,
          seats: 5,
          units: null,
        },
      }
      const get = vi
        .fn<RefundRenewalClient["get"]>()
        .mockImplementation(() => Promise.resolve(structuredClone(current)))
      const update = vi
        .fn<RefundRenewalClient["update"]>()
        .mockImplementation((_id, body) => {
          if (
            !("product_id" in body) ||
            typeof body.product_id !== "string" ||
            body.proration_behavior !== "next_period"
          )
            throw new Error("fixture unexpected write")
          current.pending_update!.product_id = body.product_id
          current.modified_at = new Date(now.getTime() + 10).toISOString()
          return Promise.resolve(structuredClone(current))
        })
      return { current, get, update }
    }
    function refundOrder(
      id: string,
      paid: Store.VerifiedSubscriptionSnapshot,
      orderId: string = randomUUID()
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
    function starterBaseOrder(
      id: string,
      paid: Store.VerifiedSubscriptionSnapshot,
      orderId: string = randomUUID()
    ): UpgradeOrder {
      return {
        ...upgradeOrder(id, paid, orderId),
        product_id: config.paidProducts.starter.usd,
        billing_reason: "subscription_create",
        created_at: paid.currentPeriodStart.toISOString(),
        net_amount: 1000,
        tax_amount: 0,
        total_amount: 1000,
        items: [
          {
            amount: 1000,
            proration: false,
            start_timestamp: paid.currentPeriodStart.toISOString(),
            end_timestamp: paid.currentPeriodEnd.toISOString(),
          },
        ],
      }
    }
    function refundedUpgradeOrder(
      id: string,
      paid: Store.VerifiedSubscriptionSnapshot,
      orderId: string
    ): ProviderRefundOrder {
      return {
        ...refundOrder(id, paid, orderId),
        billing_reason: "subscription_update",
        net_amount: 60,
        tax_amount: 0,
        total_amount: 60,
        refunded_amount: 60,
        refunded_tax_amount: 0,
        items: [
          {
            amount: 60,
            tax_amount: 0,
            proration: true,
            start_timestamp: now.toISOString(),
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
        new URL("../../../drizzle/0033_unsupported_pause.sql", import.meta.url),
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

    it.each(["active", "past_due", "paused"] as const)(
      "records unsupported provider pause against %s access and fences resumed events",
      async (status) => {
        const id = await workspace(),
          paid = snapshot(id)
        await apply(paid)
        for (let n = 0; n < 6; n++) await add(id)
        if (status === "past_due")
          await apply({ ...paid, status, updatedAt: failed, pastDueAt: failed })
        let current = providerSubscription(id, paid, {
          status,
          modified_at: now.toISOString(),
          past_due_at: status === "past_due" ? failed.toISOString() : null,
          paused_at: failed.toISOString(),
          resumes_at: paid.currentPeriodEnd.toISOString(),
        })
        const get = vi.fn(() => Promise.resolve(current)),
          service = new provider.PolarSubscriptionReconciler(config, {
            subscriptions: { get },
          })
        const eventId = randomUUID()
        for (let n = 0; n < 2; n++)
          expect(
            (
              await webhook.handlePolarWebhook(
                signed(id, eventId, "subscription.paused"),
                config,
                service
              )
            ).status
          ).toBe(200)
        expect((await row(id))?.unsupportedPauseAt).toEqual(failed)
        expect(subscriptionAccess(await row(id), now)).toMatchObject({
          plan: "free",
          allowsExistingOverage: false,
        })
        expect(await capacity.workspaceAuthMembershipLimit(id)).toBe(5)
        await expect(add(id)).rejects.toThrow(/five-member/)
        const read = await import("./subscription-access-state.server")
        expect(
          (await read.readSubscriptionAccessState(id))?.unsupportedPauseAt
        ).toEqual(failed)
        current = providerSubscription(id, paid, {
          modified_at: new Date(now.getTime() + 1).toISOString(),
        })
        expect(
          (
            await webhook.handlePolarWebhook(
              signed(id, randomUUID(), "subscription.resumed"),
              config,
              service
            )
          ).status
        ).toBe(200)
        expect((await row(id))?.unsupportedPauseAt).toEqual(failed)
        expect(subscriptionAccess(await row(id), now).plan).toBe("free")
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.subscription.unsupported_pause'",
              [id]
            )
          ).rows[0].n
        ).toBe(1)
      },
      15_000
    )

    it("fences a signed resume before any pause delivery or first activation", async () => {
      const id = await workspace(),
        paid = snapshot(id, { updatedAt: now }),
        service = new provider.PolarSubscriptionReconciler(config, {
          subscriptions: {
            get: () => Promise.resolve(providerSubscription(id, paid)),
          },
        })
      expect(
        (
          await webhook.handlePolarWebhook(
            signed(id, randomUUID(), "subscription.resumed"),
            config,
            service
          )
        ).status
      ).toBe(200)
      expect((await row(id))?.paidActivatedAt).toBeNull()
      expect((await row(id))?.unsupportedPauseAt).toEqual(now)
      await apply({ ...paid, updatedAt: new Date(now.getTime() + 1) })
      expect(
        subscriptionAccess(await row(id), new Date(now.getTime() + 100)).plan
      ).toBe("free")
      expect(await capacity.workspaceAuthMembershipLimit(id)).toBe(5)
    })

    it("promotes cached pause evidence and never extends the original scheduled cutoff", async () => {
      const id = await workspace(),
        paid = snapshot(id),
        eventId = randomUUID()
      await apply(paid, eventId)
      await apply(
        { ...paid, unsupportedPauseAt: paid.currentPeriodEnd },
        eventId
      )
      expect(subscriptionAccess(await row(id), now).plan).toBe("business")
      expect(
        subscriptionAccess(await row(id), paid.currentPeriodEnd).plan
      ).toBe("free")
      const laterEnd = new Date(paid.currentPeriodEnd.getTime() + 30 * 86400000)
      await apply({
        ...paid,
        updatedAt: now,
        currentPeriodEnd: laterEnd,
        unsupportedPauseAt: laterEnd,
      })
      expect((await row(id))?.unsupportedPauseAt).toEqual(paid.currentPeriodEnd)
      await apply({
        ...paid,
        updatedAt: now,
        currentPeriodStart: paid.currentPeriodEnd,
        currentPeriodEnd: laterEnd,
      })
      expect(
        subscriptionAccess(await row(id), paid.currentPeriodEnd).plan
      ).toBe("free")
    })

    it("rolls back pause restrictions and receipts when their audit fails, then retries safely", async () => {
      const id = await workspace(),
        paid = snapshot(id),
        eventId = randomUUID()
      await apply(paid)
      const constraint = `pause_audit_${randomUUID().replaceAll("-", "")}`
      await pool.query(
        `ALTER TABLE workspace_security_audit_events ADD CONSTRAINT ${constraint} CHECK (action <> 'billing.subscription.unsupported_pause') NOT VALID`
      )
      try {
        await expect(
          apply(
            { ...paid, updatedAt: now, unsupportedPauseAt: failed },
            eventId
          )
        ).rejects.toThrow()
        expect((await row(id))?.unsupportedPauseAt).toBeNull()
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM billing_event_receipts WHERE event_id=$1",
              [eventId]
            )
          ).rows[0].n
        ).toBe(0)
      } finally {
        await pool.query(
          `ALTER TABLE workspace_security_audit_events DROP CONSTRAINT ${constraint}`
        )
      }
      await apply(
        { ...paid, updatedAt: now, unsupportedPauseAt: failed },
        eventId
      )
      expect(subscriptionAccess(await row(id), now).plan).toBe("free")
      const next = await workspace(),
        snapshotBeforeActivation = snapshot(next, {
          updatedAt: now,
          unsupportedPauseAt: failed,
        })
      await apply(snapshotBeforeActivation)
      expect((await row(next))?.paidActivatedAt).toBeNull()
      expect(subscriptionAccess(await row(next), now).plan).toBe("free")
      await apply({
        ...snapshotBeforeActivation,
        unsupportedPauseAt: null,
        updatedAt: new Date(now.getTime() + 1),
      })
      expect(
        subscriptionAccess(await row(next), new Date(now.getTime() + 100)).plan
      ).toBe("free")
    })

    it("restores the still-paid Starter term on a signed full upgrade-only refund and fences stale paid proof", async () => {
      const id = await workspace(),
        paid = snapshot(id, { plan: "starter" }),
        orderId: string = randomUUID(),
        base = starterBaseOrder(id, paid)
      await apply(paid)
      const proof = {
        orderId,
        subscriptionId: paid.subscriptionId,
        periodStart: paid.currentPeriodStart,
        periodEnd: paid.currentPeriodEnd,
        createdAt: now,
      }
      await apply({ ...paid, plan: "plus", updatedAt: now, paidUpgrade: proof })
      expect((await row(id))?.paidUpgradeOrderId).toBe(orderId)
      for (let i = 0; i < 6; i++) await add(id)
      const refunds = await import("./polar-subscription-refund.server")
      const renewal = refundRenewalProvider(id, paid)
      const service = new refunds.PolarSubscriptionRefundReconciler(config, {
        subscriptions: renewal,
        orders: {
          get: () => Promise.resolve(refundedUpgradeOrder(id, paid, orderId)),
          list: () =>
            Promise.resolve({ items: [base], pagination: { max_page: 1 } }),
        },
      })
      const eventId = randomUUID()
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
      expect(renewal.update).toHaveBeenCalledExactlyOnceWith(
        paid.subscriptionId,
        {
          product_id: config.paidProducts.starter.usd,
          proration_behavior: "next_period",
        }
      )
      expect(renewal.current.pending_update?.seats).toBe(5)
      expect((await row(id))?.plan).toBe("basic")
      expect((await row(id))?.paidUpgradeOrderId).toBeNull()
      expect(subscriptionAccess(await row(id), now).plan).toBe("basic")
      expect((await row(id))?.paidActivatedAt).toEqual(paid.updatedAt)
      expect((await row(id))?.currentPeriodEnd).toEqual(paid.currentPeriodEnd)
      await apply({
        ...paid,
        plan: "plus",
        updatedAt: new Date(now.getTime() + 1),
        paidUpgrade: proof,
      })
      expect(subscriptionAccess(await row(id), now).plan).toBe("basic")
      expect(await capacity.workspaceAuthMembershipLimit(id)).toBe(
        Number.MAX_SAFE_INTEGER
      )
      await add(id)
      expect((await row(id))?.refundedPeriods).toHaveLength(1)
      // A refund racing a previously paid order fetch must also keep the
      // command response and its confirmation audit pending, not just access.
      const command = await import("./polar-plan-change.server"),
        context = await import("./plan-change-context.server")
      const owner = (
        await pool.query(
          "SELECT user_id FROM member WHERE organization_id=$1 LIMIT 1",
          [id]
        )
      ).rows[0].user_id
      const current: PlanChangeSubscription = {
        ...providerSubscription(id, paid, {
          modified_at: new Date(now.getTime() + 1).toISOString(),
        }),
        seats: 7,
        amount: 11200,
        pause_at_period_end: false,
        paused_at: null,
        pending_update: null,
      }
      const raced = new command.PolarPlanChanger(
        config,
        // Simulate a command whose context was captured just before the refund;
        // the locked sink still fences the refunded order after network reads.
        async (actor) => ({
          ...(await context.readPlanChangeContext(actor, "sandbox")),
          refundedUpgrade: false,
        }),
        {
          subscriptions: {
            get: () => Promise.resolve(current),
            update: vi.fn(),
          },
          orders: {
            get: () => Promise.resolve(upgradeOrder(id, paid, orderId)),
            list: () =>
              Promise.resolve({
                items: [upgradeOrder(id, paid, orderId)],
                pagination: { max_page: 1 },
              }),
          },
        }
      )
      const reply = await raced.change(
        {
          workspaceId: id,
          userId: owner,
          workspaceRole: "owner",
          scopes: null,
          authentication: { kind: "session", sessionId: "fixture" },
        },
        "plus"
      )
      expect(reply.status).toBe("payment-pending")
      expect(reply.effectiveAt).toBeNull()
      expect(
        (
          await pool.query(
            "SELECT after FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.plan_change.confirmed' ORDER BY created_at DESC LIMIT 1",
            [id]
          )
        ).rows[0].after.status
      ).toBe("payment-pending")
      // Full refund of the separate base charge still ends all paid access.
      const sink = await import("./subscription-refund.server")
      await sink.applyVerifiedPeriodRefund({
        eventId: randomUUID(),
        bodyHash: "8".repeat(64),
        refund: {
          workspaceId: id,
          environment: "sandbox",
          subscriptionId: paid.subscriptionId,
          orderId: base.id,
          start: paid.currentPeriodStart.toISOString(),
          end: paid.currentPeriodEnd.toISOString(),
          refundedAt: now.toISOString(),
        },
      })
      expect(subscriptionAccess(await row(id), now).plan).toBe("free")
      await expect(add(id)).rejects.toThrow(/five-member/)
    }, 15_000)

    it("redrives Starter renewal after a lost provider response and transactional audit failure", async () => {
      const id = await workspace(),
        paid = snapshot(id, { plan: "starter" }),
        orderId = randomUUID()
      await apply(paid)
      await apply({
        ...paid,
        plan: "plus",
        updatedAt: now,
        paidUpgrade: {
          orderId,
          subscriptionId: paid.subscriptionId,
          periodStart: paid.currentPeriodStart,
          periodEnd: paid.currentPeriodEnd,
          createdAt: now,
        },
      })
      const refunds = await import("./polar-subscription-refund.server"),
        renewal = refundRenewalProvider(id, paid),
        base = starterBaseOrder(id, paid)
      const update = renewal.update.getMockImplementation()!
      renewal.update.mockImplementationOnce(async (...args) => {
        await update(...args)
        throw new Error("lost response")
      })
      const service = new refunds.PolarSubscriptionRefundReconciler(config, {
        subscriptions: renewal,
        orders: {
          get: () => Promise.resolve(refundedUpgradeOrder(id, paid, orderId)),
          list: () =>
            Promise.resolve({
              items: [base],
              pagination: { max_page: 1 },
            }),
        },
      })
      const eventId = randomUUID(),
        request = () =>
          webhook.handlePolarWebhook(
            signed(id, eventId, "order.refunded", orderId),
            config,
            undefined,
            service
          )
      expect((await request()).status).toBe(503)
      expect(subscriptionAccess(await row(id), now).plan).toBe("basic")
      const constraint = `refund_renewal_audit_${randomUUID().replaceAll("-", "")}`
      await pool.query(
        `ALTER TABLE workspace_security_audit_events ADD CONSTRAINT ${constraint} CHECK (action <> 'billing.upgrade_refund.renewal_confirmed') NOT VALID`
      )
      try {
        expect((await request()).status).toBe(503)
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM billing_event_receipts WHERE workspace_id=$1",
              [id]
            )
          ).rows[0].n
        ).toBe(3)
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.upgrade_refund.renewal_confirmed'",
              [id]
            )
          ).rows[0].n
        ).toBe(0)
      } finally {
        await pool.query(
          `ALTER TABLE workspace_security_audit_events DROP CONSTRAINT ${constraint}`
        )
      }
      expect((await request()).status).toBe(200)
      expect((await request()).status).toBe(200)
      expect(renewal.update).toHaveBeenCalledTimes(1)
      expect(renewal.current.pending_update).toMatchObject({
        product_id: config.paidProducts.starter.usd,
        seats: 5,
      })
      const audits = (
        await pool.query(
          "SELECT after FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.upgrade_refund.renewal_confirmed'",
          [id]
        )
      ).rows
      expect(audits).toHaveLength(1)
      expect(audits[0].after).toMatchObject({
        target: "starter",
        billedSeats: 3,
        renewalSeats: 5,
        effectiveAt: paid.currentPeriodEnd.toISOString(),
      })
      const later = {
        ...paid,
        updatedAt: new Date(now.getTime() + 100),
        currentPeriodStart: paid.currentPeriodEnd,
        currentPeriodEnd: new Date(
          paid.currentPeriodEnd.getTime() + 30 * 86400000
        ),
      }
      await apply(later)
      expect(
        subscriptionAccess(await row(id), later.currentPeriodStart).plan
      ).toBe("basic")
      await service.reconcile({
        workspaceId: id,
        orderId,
        eventId: randomUUID(),
        bodyHash: "a".repeat(64),
      })
      expect(renewal.update).toHaveBeenCalledTimes(1)
    }, 15_000)

    it("cannot confirm an old refund renewal over a newly paid Plus grant", async () => {
      const id = await workspace(),
        paid = snapshot(id, { plan: "starter" }),
        orderId = randomUUID()
      await apply(paid)
      const sink = await import("./subscription-refund.server"),
        renewal = await import("./polar-upgrade-refund-renewal.server")
      await sink.applyVerifiedPeriodRefund({
        eventId: randomUUID(),
        bodyHash: "4".repeat(64),
        refund: {
          kind: "full",
          scope: "upgrade",
          workspaceId: id,
          environment: "sandbox",
          subscriptionId: paid.subscriptionId,
          orderId,
          start: now.toISOString(),
          end: paid.currentPeriodEnd.toISOString(),
          refundedAt: now.toISOString(),
          starterBasis: {
            orderId: randomUUID(),
            start: paid.currentPeriodStart.toISOString(),
            end: paid.currentPeriodEnd.toISOString(),
          },
        },
      })
      const client = refundRenewalProvider(id, paid),
        original = client.update.getMockImplementation()!
      client.update.mockImplementationOnce(async (...args) => {
        const result = await original(...args)
        await apply({
          ...paid,
          plan: "plus",
          updatedAt: new Date(now.getTime() + 20),
          paidUpgrade: {
            orderId: randomUUID(),
            subscriptionId: paid.subscriptionId,
            periodStart: paid.currentPeriodStart,
            periodEnd: paid.currentPeriodEnd,
            createdAt: now,
          },
        })
        return result
      })
      const service = new renewal.PolarUpgradeRefundRenewal(config, client)
      expect(
        await service.reconcile({
          workspaceId: id,
          environment: "sandbox",
          subscriptionId: paid.subscriptionId,
          orderId,
        })
      ).toMatchObject({ status: "superseded" })
      expect(subscriptionAccess(await row(id), now).plan).toBe("business")
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.upgrade_refund.renewal_confirmed'",
            [id]
          )
        ).rows[0].n
      ).toBe(0)
      await service.reconcile({
        workspaceId: id,
        environment: "sandbox",
        subscriptionId: paid.subscriptionId,
        orderId,
      })
      expect(client.update).toHaveBeenCalledTimes(1)
    })

    it("requires a durable matching refund and binding and refuses a changed confirmation context", async () => {
      const id = await workspace(),
        paid = snapshot(id, { plan: "starter" }),
        orderId = randomUUID()
      await apply(paid)
      const repo = await import("./upgrade-refund-renewal-context.server"),
        sink = await import("./subscription-refund.server")
      const identity = {
        workspaceId: id,
        environment: "sandbox" as const,
        subscriptionId: paid.subscriptionId,
        orderId,
      }
      await expect(
        repo.readUpgradeRefundRenewalContext(identity)
      ).rejects.toThrow("VERIFIED_UPGRADE_REFUND_REQUIRED")
      await sink.applyVerifiedPeriodRefund({
        eventId: randomUUID(),
        bodyHash: "5".repeat(64),
        refund: {
          kind: "full",
          scope: "upgrade",
          ...identity,
          start: now.toISOString(),
          end: paid.currentPeriodEnd.toISOString(),
          refundedAt: now.toISOString(),
        },
      })
      const value = await repo.readUpgradeRefundRenewalContext(identity)
      expect(value.status).toBe("required")
      await expect(
        repo.readUpgradeRefundRenewalContext({
          ...identity,
          environment: "production",
        })
      ).rejects.toThrow("VERIFIED_UPGRADE_REFUND_REQUIRED")
      await expect(
        repo.confirmUpgradeRefundRenewal(identity, {
          revision: "0".repeat(64),
          effectiveAt: paid.currentPeriodEnd.toISOString(),
          providerUpdatedAt: now.toISOString(),
          currency: "usd",
          productId: config.paidProducts.starter.usd,
          billedSeats: 3,
          renewalSeats: 5,
          status: "scheduled",
        })
      ).rejects.toThrow("CONTEXT_CHANGED")
      await apply({
        ...paid,
        status: "canceled",
        updatedAt: now,
        terminatedAt: now,
      })
      expect(
        await repo.readUpgradeRefundRenewalContext(identity)
      ).toMatchObject({ status: "terminated" })
    })

    it("denies Plus while base proof is unavailable, then promotes that same refund receipt to Starter", async () => {
      const id = await workspace(),
        paid = snapshot(id, { plan: "starter" }),
        orderId: string = randomUUID(),
        base = starterBaseOrder(id, paid)
      await apply(paid)
      await apply({
        ...paid,
        plan: "plus",
        updatedAt: now,
        paidUpgrade: {
          orderId,
          subscriptionId: paid.subscriptionId,
          periodStart: paid.currentPeriodStart,
          periodEnd: paid.currentPeriodEnd,
          createdAt: now,
        },
      })
      for (let i = 0; i < 5; i++) await add(id)
      const refunds = await import("./polar-subscription-refund.server"),
        bases: Array<UpgradeOrder> = []
      const renewal = refundRenewalProvider(id, paid)
      const service = new refunds.PolarSubscriptionRefundReconciler(config, {
        subscriptions: renewal,
        orders: {
          get: () => Promise.resolve(refundedUpgradeOrder(id, paid, orderId)),
          list: () =>
            Promise.resolve({ items: bases, pagination: { max_page: 1 } }),
        },
      })
      const eventId = randomUUID()
      expect(
        (
          await webhook.handlePolarWebhook(
            signed(id, eventId, "order.refunded", orderId),
            config,
            undefined,
            service
          )
        ).status
      ).toBe(503)
      expect(subscriptionAccess(await row(id), now).plan).toBe("free")
      await expect(add(id)).rejects.toThrow(/five-member/)
      bases.push(base)
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
      expect(subscriptionAccess(await row(id), now).plan).toBe("basic")
      await add(id)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM billing_event_receipts WHERE event_id=$1",
            [eventId]
          )
        ).rows[0].count
      ).toBe(1)
    })

    it("uses a verified base invoice to restore Starter even when the upgrade refund arrives before activation", async () => {
      const id = await workspace(),
        paid = snapshot(id),
        orderId: string = randomUUID(),
        base = starterBaseOrder(id, paid),
        sink = await import("./subscription-refund.server")
      await sink.applyVerifiedPeriodRefund({
        eventId: randomUUID(),
        bodyHash: "9".repeat(64),
        refund: {
          scope: "upgrade",
          workspaceId: id,
          environment: "sandbox",
          subscriptionId: paid.subscriptionId,
          orderId,
          start: now.toISOString(),
          end: paid.currentPeriodEnd.toISOString(),
          refundedAt: now.toISOString(),
          starterBasis: {
            orderId: base.id,
            start: paid.currentPeriodStart.toISOString(),
            end: paid.currentPeriodEnd.toISOString(),
          },
        },
      })
      await apply({
        ...paid,
        status: "past_due",
        updatedAt: now,
        pastDueAt: now,
      })
      expect((await row(id))?.paidActivatedAt).toBeNull()
      expect(subscriptionAccess(await row(id), now).plan).toBe("basic")
      for (let i = 0; i < 6; i++) await add(id)
    })

    it("retains a genuinely newer paid Plus grant when an old upgrade refund or payment proof is replayed", async () => {
      const id = await workspace(),
        paid = snapshot(id, { plan: "starter" }),
        orderId: string = randomUUID(),
        nextOrder = randomUUID(),
        base = starterBaseOrder(id, paid),
        sink = await import("./subscription-refund.server")
      await apply(paid)
      const proof = {
        orderId,
        subscriptionId: paid.subscriptionId,
        periodStart: paid.currentPeriodStart,
        periodEnd: paid.currentPeriodEnd,
        createdAt: now,
      }
      await apply({ ...paid, plan: "plus", updatedAt: now, paidUpgrade: proof })
      const refund = {
        scope: "upgrade" as const,
        workspaceId: id,
        environment: "sandbox" as const,
        subscriptionId: paid.subscriptionId,
        orderId,
        start: now.toISOString(),
        end: paid.currentPeriodEnd.toISOString(),
        refundedAt: now.toISOString(),
        starterBasis: {
          orderId: base.id,
          start: paid.currentPeriodStart.toISOString(),
          end: paid.currentPeriodEnd.toISOString(),
        },
      }
      await sink.applyVerifiedPeriodRefund({
        eventId: randomUUID(),
        bodyHash: "a".repeat(64),
        refund,
      })
      await apply({
        ...paid,
        plan: "plus",
        updatedAt: new Date(now.getTime() + 1),
        paidUpgrade: { ...proof, orderId: nextOrder },
      })
      await sink.applyVerifiedPeriodRefund({
        eventId: randomUUID(),
        bodyHash: "b".repeat(64),
        refund,
      })
      await apply({
        ...paid,
        plan: "plus",
        updatedAt: new Date(now.getTime() + 2),
        paidUpgrade: proof,
      })
      expect(subscriptionAccess(await row(id), now).plan).toBe("business")
      expect((await row(id))?.paidUpgradeOrderId).toBe(nextOrder)
    })

    it("rolls back upgrade-refund fallback, history and receipt if its audit fails", async () => {
      const id = await workspace(),
        paid = snapshot(id, { plan: "starter" }),
        orderId: string = randomUUID(),
        base = starterBaseOrder(id, paid),
        sink = await import("./subscription-refund.server")
      await apply(paid)
      await apply({
        ...paid,
        plan: "plus",
        updatedAt: now,
        paidUpgrade: {
          orderId,
          subscriptionId: paid.subscriptionId,
          periodStart: paid.currentPeriodStart,
          periodEnd: paid.currentPeriodEnd,
          createdAt: now,
        },
      })
      const before = await row(id),
        input = {
          eventId: randomUUID(),
          bodyHash: "c".repeat(64),
          refund: {
            scope: "upgrade" as const,
            workspaceId: id,
            environment: "sandbox" as const,
            subscriptionId: paid.subscriptionId,
            orderId,
            start: now.toISOString(),
            end: paid.currentPeriodEnd.toISOString(),
            refundedAt: now.toISOString(),
            starterBasis: {
              orderId: base.id,
              start: paid.currentPeriodStart.toISOString(),
              end: paid.currentPeriodEnd.toISOString(),
            },
          },
        }
      const constraint = `upgrade_refund_fault_${randomUUID().replaceAll("-", "")}`
      await pool.query(
        `ALTER TABLE workspace_security_audit_events ADD CONSTRAINT ${constraint} CHECK (action <> 'billing.upgrade_charge.refunded') NOT VALID`
      )
      try {
        await expect(sink.applyVerifiedPeriodRefund(input)).rejects.toThrow()
        expect(await row(id)).toEqual(before)
      } finally {
        await pool.query(
          `ALTER TABLE workspace_security_audit_events DROP CONSTRAINT ${constraint}`
        )
      }
      expect((await sink.applyVerifiedPeriodRefund(input)).replayed).toBe(false)
      expect(subscriptionAccess(await row(id), now).plan).toBe("basic")
    })

    it("holds Starter through unpaid upgrade states and grants Plus from a signed paid order at the same provider version", async () => {
      const id = await workspace(),
        starter = snapshot(id, { plan: "starter" })
      await apply(starter)
      const before = await row(id),
        eventId = randomUUID(),
        payment = upgradeOrder(id, starter)
      let current = providerSubscription(id, starter, {
        modified_at: now.toISOString(),
      })
      const orders: Array<typeof payment> = []
      const service = new provider.PolarSubscriptionReconciler(config, {
        subscriptions: { get: () => Promise.resolve(current) },
        orders: {
          get: () => Promise.resolve(payment),
          list: () =>
            Promise.resolve({ items: orders, pagination: { max_page: 1 } }),
        },
      })
      expect(
        (await webhook.handlePolarWebhook(signed(id, eventId), config, service))
          .status
      ).toBe(200)
      const held = await row(id)
      expect(held?.plan).toBe("basic")
      expect(held?.status).toBe(before?.status)
      expect(held?.paidActivatedAt).toEqual(before?.paidActivatedAt)
      expect(held?.currentPeriodStart).toEqual(before?.currentPeriodStart)
      expect(held?.currentPeriodEnd).toEqual(before?.currentPeriodEnd)
      expect(subscriptionAccess(held, now).plan).toBe("basic")
      current = {
        ...current,
        status: "past_due",
        past_due_at: now.toISOString(),
        modified_at: new Date(now.getTime() + 1).toISOString(),
      }
      await service.reconcile({
        workspaceId: id,
        subscriptionId: starter.subscriptionId,
        eventId: randomUUID(),
        bodyHash: "4".repeat(64),
      })
      expect((await row(id))?.graceExpiresAt).toBeNull()
      expect(subscriptionAccess(await row(id), now).plan).toBe("basic")
      current = {
        ...current,
        status: "active",
        past_due_at: null,
        modified_at: new Date(now.getTime() + 2).toISOString(),
      }
      const activeEvent = randomUUID()
      await webhook.handlePolarWebhook(signed(id, activeEvent), config, service)
      orders.push(payment)
      current = {
        ...current,
        status: "canceled",
        cancel_at_period_end: true,
        modified_at: new Date(now.getTime() + 3).toISOString(),
      }
      expect(
        (
          await webhook.handlePolarWebhook(
            signed(id, randomUUID(), "order.paid", payment.id),
            config,
            service
          )
        ).status
      ).toBe(200)
      expect(subscriptionAccess(await row(id), now).plan).toBe("business")
      expect((await row(id))?.paidActivatedAt).toEqual(before?.paidActivatedAt)
      expect((await row(id))?.currentPeriodEnd).toEqual(
        before?.currentPeriodEnd
      )
      expect((await row(id))?.graceExpiresAt).toBeNull()
    })

    it("promotes a cached unpaid-upgrade receipt when a re-fetch proves payment without another subscription event", async () => {
      const id = await workspace(),
        starter = snapshot(id, { plan: "starter" }),
        payment = upgradeOrder(id, starter)
      await apply(starter)
      const orders: Array<typeof payment> = [],
        eventId = randomUUID()
      const service = new provider.PolarSubscriptionReconciler(config, {
        subscriptions: {
          get: () =>
            Promise.resolve(
              providerSubscription(id, starter, {
                modified_at: now.toISOString(),
              })
            ),
        },
        orders: {
          get: () => Promise.resolve(payment),
          list: () =>
            Promise.resolve({ items: orders, pagination: { max_page: 1 } }),
        },
      })
      await webhook.handlePolarWebhook(signed(id, eventId), config, service)
      expect((await row(id))?.plan).toBe("basic")
      orders.push(payment)
      for (let retry = 0; retry < 2; retry++)
        expect(
          (
            await webhook.handlePolarWebhook(
              signed(id, eventId),
              config,
              service
            )
          ).status
        ).toBe(200)
      expect((await row(id))?.plan).toBe("business")
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM billing_event_receipts WHERE event_id=$1",
            [eventId]
          )
        ).rows[0].count
      ).toBe(1)
    })

    it("does not shorten prior grace or extend a paid period for an unpaid upgrade", async () => {
      const id = await workspace(),
        starter = snapshot(id, { plan: "starter" })
      await apply(starter)
      await apply({
        ...starter,
        status: "past_due",
        pastDueAt: failed,
        updatedAt: failed,
      })
      const before = await row(id)
      await apply({
        ...starter,
        plan: "plus",
        updatedAt: now,
        status: "past_due",
        pastDueAt: now,
      })
      expect((await row(id))?.plan).toBe("basic")
      expect((await row(id))?.graceExpiresAt).toEqual(before?.graceExpiresAt)
      expect((await row(id))?.paymentFailedAt).toEqual(before?.paymentFailedAt)
      expect(
        subscriptionAccess(await row(id), before!.graceExpiresAt!).plan
      ).toBe("free")
    })

    it("defers an early downgrade, then applies Starter only at a new authoritative period", async () => {
      const id = await workspace(),
        paid = snapshot(id)
      await apply(paid)
      await apply({ ...paid, plan: "starter", updatedAt: now })
      expect(subscriptionAccess(await row(id), now).plan).toBe("business")
      const next = {
        ...paid,
        plan: "starter" as const,
        updatedAt: new Date(now.getTime() + 1),
        currentPeriodStart: paid.currentPeriodEnd,
        currentPeriodEnd: new Date(
          paid.currentPeriodEnd.getTime() + 30 * 86400000
        ),
      }
      await apply(next)
      expect(
        subscriptionAccess(await row(id), next.currentPeriodStart).plan
      ).toBe("basic")
    })

    it("rejects invalid order identity and ignores stale paid-upgrade proof", async () => {
      const id = await workspace(),
        starter = snapshot(id, { plan: "starter" }),
        payment = upgradeOrder(id, starter)
      await apply(starter)
      const service = new provider.PolarSubscriptionReconciler(config, {
        subscriptions: {
          get: () => Promise.resolve(providerSubscription(id, starter)),
        },
        orders: {
          get: () =>
            Promise.resolve({
              ...payment,
              customer: { external_id: "forge:workspace:foreign" },
            }),
          list: () =>
            Promise.resolve({ items: [payment], pagination: { max_page: 1 } }),
        },
      })
      expect(
        (
          await webhook.handlePolarWebhook(
            signed(id, randomUUID(), "order.paid", payment.id),
            config,
            service
          )
        ).status
      ).toBe(503)
      await apply({ ...starter, updatedAt: now })
      expect(
        (
          await apply({
            ...starter,
            plan: "plus",
            paidUpgrade: {
              orderId: payment.id,
              subscriptionId: starter.subscriptionId,
              periodStart: starter.currentPeriodStart,
              periodEnd: starter.currentPeriodEnd,
              createdAt: now,
            },
          })
        ).outcome
      ).toBe("stale")
      expect((await row(id))?.plan).toBe("basic")
    })

    it("recovers plan-command audit failure without invoicing twice, with live owner and member resolution", async () => {
      const id = await workspace(),
        starter = snapshot(id, { plan: "starter" }),
        owner = await add(id)
      await apply(starter)
      for (let i = 0; i < 4; i++) await add(id)
      const command = await import("./polar-plan-change.server"),
        context = await import("./plan-change-context.server"),
        payment = upgradeOrder(id, starter)
      const actor: Actor = {
        workspaceId: id,
        userId: owner,
        workspaceRole: "owner",
        scopes: null,
        authentication: { kind: "session", sessionId: "fixture" },
      }
      const current: PlanChangeSubscription = {
        ...providerSubscription(id, starter, {
          product_id: config.paidProducts.starter.usd,
        }),
        seats: 3,
        amount: 3000,
        paused_at: null,
        pause_at_period_end: false,
        pending_update: null,
      }
      const update = vi
        .fn<
          NonNullable<
            ConstructorParameters<typeof command.PolarPlanChanger>[2]
          >["subscriptions"]["update"]
        >()
        .mockImplementation((_id, body) => {
          if ("product_id" in body) {
            current.product_id = body.product_id!
            current.amount = 4800
            current.pending_update = null
          }
          if ("seats" in body)
            current.pending_update = {
              id: randomUUID(),
              created_at: now.toISOString(),
              modified_at: null,
              applies_at: starter.currentPeriodEnd.toISOString(),
              product_id: null,
              seats: body.seats,
              units: null,
            }
          current.modified_at = now.toISOString()
          return Promise.resolve(structuredClone(current))
        })
      const service = new command.PolarPlanChanger(
        config,
        (a) => context.readPlanChangeContext(a, "sandbox"),
        {
          subscriptions: {
            get: () => Promise.resolve(structuredClone(current)),
            update,
          },
          orders: {
            get: () => Promise.resolve(payment),
            list: () =>
              Promise.resolve({
                items: [payment],
                pagination: { max_page: 1 },
              }),
          },
        }
      )
      const constraint = `plan_fault_${randomUUID().replaceAll("-", "")}`
      await pool.query(
        `ALTER TABLE workspace_security_audit_events ADD CONSTRAINT ${constraint} CHECK (action <> 'billing.plan_change.confirmed') NOT VALID`
      )
      try {
        await expect(service.change(actor, "plus")).rejects.toThrow()
        expect((await row(id))?.plan).toBe("basic")
      } finally {
        await pool.query(
          `ALTER TABLE workspace_security_audit_events DROP CONSTRAINT ${constraint}`
        )
      }
      expect((await service.change(actor, "plus")).status).toBe("unchanged")
      expect((await row(id))?.plan).toBe("business")
      expect(current.pending_update?.seats).toBe(5)
      expect(
        update.mock.calls.filter((call) => "product_id" in call[1])
      ).toHaveLength(1)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM workspace_security_audit_events WHERE workspace_id=$1 AND action='billing.plan_change.confirmed'",
            [id]
          )
        ).rows[0].count
      ).toBe(1)
    })

    it("rechecks live membership after the provider read before a plan charge", async () => {
      const id = await workspace(),
        starter = snapshot(id, { plan: "starter" }),
        owner = await add(id)
      await apply(starter)
      const command = await import("./polar-plan-change.server"),
        context = await import("./plan-change-context.server"),
        update = vi.fn()
      const current: PlanChangeSubscription = {
        ...providerSubscription(id, starter, {
          product_id: config.paidProducts.starter.usd,
        }),
        seats: 1,
        amount: 1000,
        paused_at: null,
        pause_at_period_end: false,
        pending_update: null,
      }
      const service = new command.PolarPlanChanger(
        config,
        (a) => context.readPlanChangeContext(a, "sandbox"),
        {
          subscriptions: {
            get: async () => {
              await pool.query(
                "UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2",
                [id, owner]
              )
              return current
            },
            update,
          },
          orders: { get: vi.fn(), list: vi.fn() },
        }
      )
      await expect(
        service.change(
          {
            workspaceId: id,
            userId: owner,
            workspaceRole: "owner",
            scopes: null,
            authentication: { kind: "session", sessionId: "fixture" },
          },
          "plus"
        )
      ).rejects.toThrow("REVOKED")
      expect(update).not.toHaveBeenCalled()
    })

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
      const orderId: string = randomUUID(),
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
            pause_at_period_end: false,
            paused_at: null,
            resumes_at: null,
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
        pause_at_period_end: false,
        paused_at: null,
        resumes_at: null,
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
          pause_at_period_end: false,
          paused_at: null,
          resumes_at: null,
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

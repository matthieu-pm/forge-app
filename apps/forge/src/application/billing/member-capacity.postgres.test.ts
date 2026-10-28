// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
import { parse } from "dotenv"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type * as AuthModule from "@/lib/auth"
import type * as JoinModule from "@/application/workspace-security/workspace-join.server"
import type * as TokenModule from "@/application/workspace-security/invite-link-token.server"
import type * as DatabaseModule from "@/db"

// Explicit opt-in only. Use a fresh schema-only Neon branch, never the app URL.
const testUrl = process.env.FORGE_TEST_DATABASE_URL
const branchId = process.env.FORGE_TEST_NEON_BRANCH_ID

describe.skipIf(!testUrl)(
  "atomic PostgreSQL workspace membership capacity",
  () => {
    const marker = `member-cap-test-${randomUUID()}`
    const workspaces: Array<string> = []
    const userIds: Array<string> = []
    const password = `Fixture-${randomUUID()}`
    let passwordHash: string
    let pool: Pool
    let app: typeof AuthModule
    let joins: typeof JoinModule
    let tokens: typeof TokenModule
    let appDb: typeof DatabaseModule
    const cleanup: { pool?: Pool; database?: typeof DatabaseModule } = {}
    let oldFree: string
    let oldPaid: string
    let reusingVerifiedMigration = false

    async function user() {
      const id = `${marker}-u-${userIds.length}`
      userIds.push(id)
      await pool.query(
        `INSERT INTO public."user" (id, name, email, email_verified) VALUES ($1, 'Capacity fixture', $2, true)`,
        [id, `${id}@example.test`]
      )
      await pool.query(
        `INSERT INTO public.account (id, account_id, provider_id, user_id, password) VALUES ($1, $2, 'credential', $2, $3)`,
        [`${id}-account`, id, passwordHash]
      )
      return id
    }

    async function add(workspaceId: string, userId: string, role = "member") {
      return pool.query(
        `INSERT INTO public.member (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4) RETURNING id`,
        [randomUUID(), workspaceId, userId, role]
      )
    }

    async function workspace(size: number, paid = false) {
      const id = `${marker}-w-${workspaces.length}`
      workspaces.push(id)
      await pool.query(
        `INSERT INTO public.organization (id, name, slug) VALUES ($1, 'Capacity fixture', $1)`,
        [id]
      )
      if (paid)
        await pool.query(
          `INSERT INTO public.workspace_entitlements (workspace_id, plan, status) VALUES ($1, 'basic', 'active')`,
          [id]
        )
      const members = []
      for (let index = 0; index < size; index++) {
        const idOfUser = await user()
        await add(
          id,
          idOfUser,
          index === 0 ? "owner" : index === 1 ? "admin" : "member"
        )
        members.push(idOfUser)
      }
      return { id, members }
    }

    async function count(id: string) {
      const result = await pool.query<{ actual: number; tracked: number }>(
        `SELECT (SELECT count(*)::int FROM public.member WHERE organization_id = $1) AS actual,
         (SELECT active_member_count FROM public.workspace_member_capacity WHERE workspace_id = $1) AS tracked`,
        [id]
      )
      return result.rows[0]
    }

    async function login(userId: string) {
      const response = await app.handleAuthRequest(
        new Request("http://localhost:3099/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3099",
          },
          body: JSON.stringify({ email: `${userId}@example.test`, password }),
        })
      )
      expect(response.status, await response.clone().text()).toBe(200)
      return response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ")
    }

    async function invitation(
      workspaceId: string,
      invitee: string,
      inviter: string
    ) {
      const id = randomUUID()
      await pool.query(
        `INSERT INTO public.invitation (id, organization_id, email, role, status, expires_at, inviter_id)
       VALUES ($1, $2, $3, 'member', 'pending', now() + interval '1 day', $4)`,
        [id, workspaceId, `${invitee}@example.test`, inviter]
      )
      return id
    }

    async function accept(id: string, cookie: string) {
      return app.handleAuthRequest(
        new Request(
          "http://localhost:3099/api/auth/organization/accept-invitation",
          {
            method: "POST",
            headers: {
              cookie,
              origin: "http://localhost:3099",
              "content-type": "application/json",
            },
            body: JSON.stringify({ invitationId: id }),
          }
        )
      )
    }

    beforeAll(async () => {
      expect(branchId, "Explicit isolated branch ID is required.").toMatch(
        /^br-/
      )
      const url = new URL(testUrl!)
      expect(url.hostname).toBe(process.env.FORGE_TEST_DATABASE_HOST)
      expect(url.hostname).not.toContain("-pooler")
      // Reject the configured application host even if its database is empty.
      // Read credentials only for comparison; never log or overwrite them.
      const configuredUrls = [
        process.env.DATABASE_URL,
        process.env.DATABASE_URL_UNPOOLED,
      ]
      for (const name of [".env", ".env.local"]) {
        try {
          const values = parse(
            await readFile(new URL(`../../../../../${name}`, import.meta.url))
          )
          configuredUrls.push(values.DATABASE_URL, values.DATABASE_URL_UNPOOLED)
        } catch (error) {
          if (!(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          ))
            throw error
        }
      }
      for (const configured of configuredUrls) {
        if (configured)
          expect(url.hostname).not.toBe(
            new URL(configured).hostname.replace("-pooler.", ".")
          )
      }
      neonConfig.webSocketConstructor = WebSocket
      pool = new Pool({ connectionString: testUrl, max: 8 })
      cleanup.pool = pool
      const result = await pool.query<{
        branch: string
        users: number
        workspaces: number
        existing: string | null
      }>(
        `SELECT current_setting('neon.branch_id', true) AS branch,
         (SELECT count(*)::int FROM public."user") AS users,
         (SELECT count(*)::int FROM public.organization) AS workspaces,
         to_regclass('public.workspace_member_capacity')::text AS existing`
      )
      const installed = result.rows[0].existing !== null
      expect(result.rows[0]).toEqual({
        branch: branchId,
        users: 0,
        workspaces: 0,
        existing: installed ? "workspace_member_capacity" : null,
      })
      const migration = await readFile(
        new URL(
          "../../../drizzle/0026_workspace_member_capacity.sql",
          import.meta.url
        ),
        "utf8"
      )
      const graceMigration = await readFile(
        new URL(
          "../../../drizzle/0027_subscription_grace.sql",
          import.meta.url
        ),
        "utf8"
      )
      const bindingMigration = await readFile(
        new URL(
          "../../../drizzle/0028_subscription_binding.sql",
          import.meta.url
        ),
        "utf8"
      )
      const cancellationMigration = await readFile(
        new URL(
          "../../../drizzle/0029_subscription_cancellation.sql",
          import.meta.url
        ),
        "utf8"
      )
      const refundMigration = await readFile(
        new URL(
          "../../../drizzle/0030_subscription_refunds.sql",
          import.meta.url
        ),
        "utf8"
      )
      const terminationMigration = await readFile(
        new URL(
          "../../../drizzle/0031_subscription_termination.sql",
          import.meta.url
        ),
        "utf8"
      )
      if (installed) {
        // Reuse only an empty, explicitly selected test branch with exactly the
        // checked-in trigger bodies. Do not drop/reset any database objects.
        expect(process.env.FORGE_TEST_REUSE_MEMBER_CAPACITY).toBe("1")
        const latestDefinitions = new Map<string, RegExpMatchArray>()
        for (const match of (
          migration +
          graceMigration +
          cancellationMigration +
          refundMigration +
          terminationMigration
        ).matchAll(
          /CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/g
        ))
          latestDefinitions.set(match[1], match)
        const definitions = [...latestDefinitions.values()]
        expect(definitions).toHaveLength(2)
        const actual = await pool.query<{ proname: string; prosrc: string }>(
          `SELECT p.proname,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[])`,
          [definitions.map((match) => match[1])]
        )
        for (const match of definitions)
          expect(
            actual.rows.find((row) => row.proname === match[1])?.prosrc
          ).toBe(match[2])
        const state = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM public.workspace_member_capacity`
        )
        expect(state.rows[0].count).toBe(0)
        const privileges = await pool.query<{ public_execute: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='public' AND p.proname='forge_adjust_workspace_member_capacity' AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute`
        )
        expect(privileges.rows[0].public_execute).toBe(false)
        reusingVerifiedMigration = true
      }
      passwordHash = await hashPassword(password)
      // Legacy over-capacity records precede the migration; no data is evicted.
      oldFree = (await workspace(6, reusingVerifiedMigration)).id
      if (reusingVerifiedMigration)
        await pool.query(
          `UPDATE public.workspace_entitlements SET plan='free' WHERE workspace_id=$1`,
          [oldFree]
        )
      oldPaid = (await workspace(6, true)).id
      if (!reusingVerifiedMigration) {
        const client = await pool.connect()
        try {
          await client.query("BEGIN")
          for (const statement of migration.split("--> statement-breakpoint"))
            if (statement.trim()) await client.query(statement)
          for (const statement of graceMigration.split(
            "--> statement-breakpoint"
          ))
            if (statement.trim()) await client.query(statement)
          for (const extra of [
            bindingMigration,
            cancellationMigration,
            refundMigration,
            terminationMigration,
          ]) {
            for (const statement of extra.split("--> statement-breakpoint"))
              if (statement.trim()) await client.query(statement)
          }
          await client.query("COMMIT")
        } catch (error) {
          await client.query("ROLLBACK")
          throw error
        } finally {
          client.release()
        }
      }
      vi.stubEnv("DATABASE_URL", testUrl)
      vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3099")
      vi.stubEnv(
        "BETTER_AUTH_SECRET",
        "member-capacity-integration-secret-not-a-production-secret"
      )
      app = await import("@/lib/auth")
      joins =
        await import("@/application/workspace-security/workspace-join.server")
      tokens =
        await import("@/application/workspace-security/invite-link-token.server")
      appDb = await import("@/db")
      cleanup.database = appDb
    }, 60_000)

    afterAll(async () => {
      if (cleanup.pool && workspaces.length) {
        // Delete only this test's UUID-prefixed fixtures on the verified test branch.
        expect(workspaces.every((id) => id.startsWith(marker))).toBe(true)
        await cleanup.pool.query(
          `DELETE FROM public.organization WHERE id = ANY($1::text[])`,
          [workspaces]
        )
        await cleanup.pool.query(
          `DELETE FROM public."user" WHERE id = ANY($1::text[])`,
          [userIds]
        )
      }
      if (cleanup.database) await cleanup.database.db.$client.end()
      if (cleanup.pool) await cleanup.pool.end()
      vi.unstubAllEnvs()
    }, 30_000)

    it("backfills all existing members and preserves grandfathered access and retries", async () => {
      expect(await count(oldFree)).toEqual({ actual: 6, tracked: 6 })
      expect(await count(oldPaid)).toEqual({ actual: 6, tracked: 6 })
      await expect(add(oldFree, await user())).rejects.toMatchObject({
        code: "23514",
        constraint: "workspace_free_member_limit",
      })
      const existing = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM public.member WHERE organization_id = $1 LIMIT 1`,
        [oldFree]
      )
      await pool.query(
        `INSERT INTO public.member (id, organization_id, user_id, role) VALUES ($1,$2,$3,'member') ON CONFLICT DO NOTHING`,
        [randomUUID(), oldFree, existing.rows[0].user_id]
      )
      await pool.query(
        `UPDATE public.member SET role = 'admin' WHERE organization_id = $1`,
        [oldFree]
      )
      expect(await count(oldFree)).toEqual({ actual: 6, tracked: 6 })
    })

    it("creates a verified owner's workspace and initial capacity through the real auth handler", async () => {
      const owner = await user()
      const cookie = await login(owner)
      const slug = `${marker}-auth-created`
      const response = await app.handleAuthRequest(
        new Request("http://localhost:3099/api/auth/organization/create", {
          method: "POST",
          headers: {
            cookie,
            origin: "http://localhost:3099",
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Capacity fixture", slug }),
        })
      )
      expect(response.status, await response.clone().text()).toBe(200)
      const body = z.object({ id: z.string() }).parse(await response.json())
      try {
        expect(await count(body.id)).toEqual({ actual: 1, tracked: 1 })
        const role = await pool.query<{ role: string }>(
          `SELECT role FROM public.member WHERE organization_id=$1 AND user_id=$2`,
          [body.id, owner]
        )
        expect(role.rows[0].role).toBe("owner")
      } finally {
        // This organization has an SDK-generated ID; match its unique test slug too.
        await pool.query(
          `DELETE FROM public.organization WHERE id=$1 AND slug=$2`,
          [body.id, slug]
        )
      }
    }, 30_000)

    it("allows exactly the fifth member and excludes pending invitations", async () => {
      const w = await workspace(4)
      await invitation(w.id, await user(), w.members[0])
      await invitation(w.id, await user(), w.members[0])
      expect(await count(w.id)).toEqual({ actual: 4, tracked: 4 })
      await add(w.id, await user())
      await expect(add(w.id, await user())).rejects.toMatchObject({
        constraint: "workspace_free_member_limit",
      })
      expect(await count(w.id)).toEqual({ actual: 5, tracked: 5 })
    })

    it("serializes two independent connections competing for the last Free slot", async () => {
      const w = await workspace(4)
      const a = await user(),
        b = await user()
      const outcomes = await Promise.allSettled([add(w.id, a), add(w.id, b)])
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled")
      ).toHaveLength(1)
      expect(
        outcomes.filter((outcome) => outcome.status === "rejected")
      ).toHaveLength(1)
      expect(await count(w.id)).toEqual({ actual: 5, tracked: 5 })
    })

    it("rolls back an over-capacity batch import without partial members or quota", async () => {
      const w = await workspace(4)
      const a = await user(),
        b = await user()
      await expect(
        pool.query(
          `INSERT INTO public.member (id,organization_id,user_id,role) VALUES ($1,$2,$3,'member'),($4,$2,$5,'member')`,
          [randomUUID(), w.id, a, randomUUID(), b]
        )
      ).rejects.toMatchObject({ constraint: "workspace_free_member_limit" })
      expect(await count(w.id)).toEqual({ actual: 4, tracked: 4 })
    })

    it("restores capacity on deletion, preserves it on rollback and atomically moves members", async () => {
      const source = await workspace(1),
        destination = await workspace(5)
      await expect(
        pool.query(
          `UPDATE public.member SET organization_id = $1 WHERE organization_id = $2`,
          [destination.id, source.id]
        )
      ).rejects.toMatchObject({ constraint: "workspace_free_member_limit" })
      expect(await count(source.id)).toEqual({ actual: 1, tracked: 1 })
      await pool.query(
        `DELETE FROM public.member WHERE organization_id = $1 AND user_id = $2`,
        [destination.id, destination.members[4]]
      )
      await pool.query(
        `UPDATE public.member SET organization_id = $1 WHERE organization_id = $2`,
        [destination.id, source.id]
      )
      expect(await count(source.id)).toEqual({ actual: 0, tracked: 0 })
      expect(await count(destination.id)).toEqual({ actual: 5, tracked: 5 })
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        await client.query(
          `DELETE FROM public.member WHERE organization_id = $1`,
          [destination.id]
        )
        await client.query("ROLLBACK")
      } finally {
        client.release()
      }
      expect(await count(destination.id)).toEqual({ actual: 5, tracked: 5 })
    })

    it("keeps paid capacity and blocks new admissions after downgrade without evicting members", async () => {
      const w = await workspace(6, true)
      await add(w.id, await user())
      await pool.query(
        `UPDATE public.workspace_entitlements SET plan='free' WHERE workspace_id=$1`,
        [w.id]
      )
      const ownerCookie = await login(w.members[0])
      const retained = await app.auth.api.getFullOrganization({
        headers: new Headers({ cookie: ownerCookie }),
        query: { organizationId: w.id },
      })
      expect(retained?.members).toHaveLength(7)
      await expect(add(w.id, await user())).rejects.toMatchObject({
        constraint: "workspace_free_member_limit",
      })
      expect(await count(w.id)).toEqual({ actual: 7, tracked: 7 })
      await pool.query(
        `DELETE FROM public.member WHERE organization_id=$1 AND user_id=ANY($2::text[])`,
        [w.id, [w.members[5], w.members[4]]]
      )
      expect(await count(w.id)).toEqual({ actual: 5, tracked: 5 })
      await expect(add(w.id, await user())).rejects.toMatchObject({
        constraint: "workspace_free_member_limit",
      })
      await pool.query(
        `DELETE FROM public.member WHERE organization_id=$1 AND user_id=$2`,
        [w.id, w.members[3]]
      )
      await add(w.id, await user())
      expect(await count(w.id)).toEqual({ actual: 5, tracked: 5 })
    })

    it("applies plan preflight and the invariant to server-side admin additions", async () => {
      const free = await workspace(4),
        paid = await workspace(5, true)
      const freeCookie = await login(free.members[0])
      await app.auth.api.addMember({
        headers: new Headers({ cookie: freeCookie }),
        body: { organizationId: free.id, userId: await user(), role: "member" },
      })
      await expect(
        app.auth.api.addMember({
          headers: new Headers({ cookie: freeCookie }),
          body: {
            organizationId: free.id,
            userId: await user(),
            role: "member",
          },
        })
      ).rejects.toMatchObject({ status: "FORBIDDEN" })
      const paidCookie = await login(paid.members[0])
      await app.auth.api.addMember({
        headers: new Headers({ cookie: paidCookie }),
        body: { organizationId: paid.id, userId: await user(), role: "member" },
      })
      expect(await count(free.id)).toEqual({ actual: 5, tracked: 5 })
      expect(await count(paid.id)).toEqual({ actual: 6, tracked: 6 })
    }, 30_000)

    it("refuses invitation tampering across users/workspaces without quota effects", async () => {
      const first = await workspace(1),
        other = await workspace(1)
      const invitee = await user(),
        intruder = await user()
      const id = await invitation(other.id, invitee, other.members[0])
      const response = await accept(id, await login(intruder))
      expect(response.ok).toBe(false)
      expect(await count(first.id)).toEqual({ actual: 1, tracked: 1 })
      expect(await count(other.id)).toEqual({ actual: 1, tracked: 1 })
      const rows = await pool.query<{ status: string }>(
        `SELECT status FROM public.invitation WHERE id=$1`,
        [id]
      )
      expect(rows.rows[0].status).toBe("pending")
    }, 30_000)

    it("enforces accepted invitations through the real auth handler without consuming a refused invite", async () => {
      const w = await workspace(4)
      const a = await user(),
        b = await user()
      const ia = await invitation(w.id, a, w.members[0]),
        ib = await invitation(w.id, b, w.members[0])
      const [ca, cb] = await Promise.all([login(a), login(b)])
      const results = await Promise.all([accept(ia, ca), accept(ib, cb)])
      expect(results.filter((response) => response.ok)).toHaveLength(1)
      const refused = results.find((response) => !response.ok)!
      expect([403, 409]).toContain(refused.status)
      expect(await count(w.id)).toEqual({ actual: 5, tracked: 5 })
      const invites = await pool.query<{ status: string }>(
        `SELECT status FROM public.invitation WHERE id=ANY($1::text[])`,
        [[ia, ib]]
      )
      expect(invites.rows.map((row) => row.status).sort()).toEqual([
        "accepted",
        "pending",
      ])
    }, 30_000)

    it("keeps auth admission and existing access correct during and after payment grace", async () => {
      const w = await workspace(5, true)
      const activated = new Date(Date.now() - 60 * 86400000)
      const failed = new Date(Date.now() - 3600000)
      const expires = new Date(failed.getTime() + 7 * 86400000)
      await pool.query(
        `UPDATE public.workspace_entitlements SET source='polar',source_reference=$2,provider_environment='sandbox',provider_updated_at=now(),provider_state_hash=$3,status='past_due',paid_activated_at=$4,payment_failed_at=$5,grace_expires_at=$6 WHERE workspace_id=$1`,
        [w.id, randomUUID(), "a".repeat(64), activated, failed, expires]
      )
      const sixth = await user(),
        cookie = await login(sixth)
      const invite = await invitation(w.id, sixth, w.members[0])
      expect((await accept(invite, cookie)).ok).toBe(true)
      expect(await count(w.id)).toEqual({ actual: 6, tracked: 6 })
      const expiredFailure = new Date(Date.now() - 8 * 86400000)
      await pool.query(
        `UPDATE public.workspace_entitlements SET payment_failed_at=$2,grace_expires_at=$3 WHERE workspace_id=$1`,
        [
          w.id,
          expiredFailure,
          new Date(expiredFailure.getTime() + 7 * 86400000),
        ]
      )
      const denied = await user(),
        deniedInvite = await invitation(w.id, denied, w.members[0])
      expect((await accept(deniedInvite, await login(denied))).ok).toBe(false)
      expect(await count(w.id)).toEqual({ actual: 6, tracked: 6 })
      const stillAuthorized = await app.auth.api.getFullOrganization({
        headers: new Headers({ cookie }),
        query: { organizationId: w.id },
      })
      expect(stillAuthorized?.id).toBe(w.id)
      expect(
        (
          await pool.query("SELECT status FROM public.invitation WHERE id=$1", [
            deniedInvite,
          ])
        ).rows[0].status
      ).toBe("pending")
    }, 30_000)

    it("preserves existing members and refuses new joins after scheduled cancellation ends", async () => {
      const w = await workspace(5, true),
        sixth = await user(),
        cookie = await login(sixth)
      const start = new Date(Date.now() - 30 * 86400000),
        end = new Date(Date.now() + 3600000)
      await pool.query(
        `UPDATE public.workspace_entitlements SET source='polar',source_reference=$2,provider_environment='sandbox',provider_updated_at=now(),provider_state_hash=$3,paid_activated_at=$4,current_period_start=$4,current_period_end=$5,cancel_at_period_end=true,cancellation_period_end=$5 WHERE workspace_id=$1`,
        [w.id, randomUUID(), "a".repeat(64), start, end]
      )
      expect(
        (await accept(await invitation(w.id, sixth, w.members[0]), cookie)).ok
      ).toBe(true)
      const ended = new Date(Date.now() - 60000)
      await pool.query(
        `UPDATE public.workspace_entitlements SET status='canceled',current_period_end=$2,cancellation_period_end=$2 WHERE workspace_id=$1`,
        [w.id, ended]
      )
      const seventh = await user(),
        pending = await invitation(w.id, seventh, w.members[0])
      expect((await accept(pending, await login(seventh))).ok).toBe(false)
      expect(await count(w.id)).toEqual({ actual: 6, tracked: 6 })
      expect(
        (
          await app.auth.api.getFullOrganization({
            headers: new Headers({ cookie }),
            query: { organizationId: w.id },
          })
        )?.id
      ).toBe(w.id)
      expect(
        (
          await pool.query("SELECT status FROM public.invitation WHERE id=$1", [
            pending,
          ])
        ).rows[0].status
      ).toBe("pending")
    }, 30_000)

    it("preserves existing member sessions and pending invites after a full period refund", async () => {
      const w = await workspace(6, true),
        subscriptionId = randomUUID()
      const start = new Date(Date.now() - 86400000),
        end = new Date(Date.now() + 30 * 86400000)
      await pool.query(
        `UPDATE workspace_entitlements SET source='polar',source_reference=$2,provider_environment='sandbox',provider_updated_at=now(),provider_state_hash=$3,paid_activated_at=$4,current_period_start=$4,current_period_end=$5 WHERE workspace_id=$1`,
        [w.id, subscriptionId, "a".repeat(64), start, end]
      )
      const cookie = await login(w.members[5]),
        next = await user(),
        pending = await invitation(w.id, next, w.members[0])
      const { applyVerifiedPeriodRefund } =
        await import("./subscription-refund.server")
      await applyVerifiedPeriodRefund({
        eventId: randomUUID(),
        bodyHash: "b".repeat(64),
        refund: {
          workspaceId: w.id,
          environment: "sandbox",
          orderId: randomUUID(),
          subscriptionId,
          start: start.toISOString(),
          end: end.toISOString(),
          refundedAt: new Date().toISOString(),
        },
      })
      expect((await accept(pending, await login(next))).ok).toBe(false)
      expect(await count(w.id)).toEqual({ actual: 6, tracked: 6 })
      expect(
        (
          await app.auth.api.getFullOrganization({
            headers: new Headers({ cookie }),
            query: { organizationId: w.id },
          })
        )?.id
      ).toBe(w.id)
      expect(
        (
          await pool.query("SELECT status FROM invitation WHERE id=$1", [
            pending,
          ])
        ).rows[0].status
      ).toBe("pending")
    }, 30_000)

    it("keeps member sessions while blocking new joins immediately after provider termination", async () => {
      const w = await workspace(6, true),
        subscriptionId = randomUUID(),
        start = new Date(Date.now() - 86400000),
        end = new Date(Date.now() + 30 * 86400000),
        terminatedAt = new Date()
      await pool.query(
        `UPDATE workspace_entitlements SET source='polar',source_reference=$2,provider_environment='sandbox',provider_updated_at=now(),provider_state_hash=$3,paid_activated_at=$4,current_period_start=$4,current_period_end=$5 WHERE workspace_id=$1`,
        [w.id, subscriptionId, "a".repeat(64), start, end]
      )
      const cookie = await login(w.members[5]),
        next = await user(),
        pending = await invitation(w.id, next, w.members[0])
      const { applyVerifiedSubscriptionSnapshot } =
        await import("./subscription-reconciliation.server")
      await applyVerifiedSubscriptionSnapshot({
        eventId: randomUUID(),
        bodyHash: "c".repeat(64),
        snapshot: {
          workspaceId: w.id,
          environment: "sandbox",
          subscriptionId,
          plan: "starter",
          status: "canceled",
          terminatedAt,
          updatedAt: terminatedAt,
          currentPeriodStart: start,
          currentPeriodEnd: end,
          pastDueAt: null,
          cancelAtPeriodEnd: false,
        },
      })
      expect((await accept(pending, await login(next))).ok).toBe(false)
      expect(await count(w.id)).toEqual({ actual: 6, tracked: 6 })
      expect(
        (
          await app.auth.api.getFullOrganization({
            headers: new Headers({ cookie }),
            query: { organizationId: w.id },
          })
        )?.id
      ).toBe(w.id)
      expect(
        (
          await pool.query("SELECT status FROM invitation WHERE id=$1", [
            pending,
          ])
        ).rows[0].status
      ).toBe("pending")
    }, 30_000)

    it("covers invite-link/domain joins and returns an actionable capacity error", async () => {
      const w = await workspace(4)
      await pool.query(
        `INSERT INTO public.workspace_security_settings (workspace_id) VALUES ($1)`,
        [w.id]
      )
      const token = await tokens.signWorkspaceInviteLink({
        workspaceId: w.id,
        generation: 1,
      })
      const joined = await user()
      await joins.joinWorkspaceWithInvite({ token, userId: joined })
      await joins.joinWorkspaceWithInvite({ token, userId: joined })
      await expect(
        joins.joinWorkspaceWithInvite({ token, userId: await user() })
      ).rejects.toMatchObject({ code: "MEMBER_LIMIT" })
      await pool.query(
        `INSERT INTO public.workspace_approved_domains (workspace_id,domain,source,verified_at,added_by_user_id) VALUES ($1,'example.test','manual',now(),$2)`,
        [w.id, w.members[0]]
      )
      const denied = await user()
      await expect(
        joins.joinWorkspaceWithApprovedDomain({
          workspaceId: w.id,
          userId: denied,
          email: `${denied}@example.test`,
          emailVerified: true,
        })
      ).rejects.toMatchObject({ code: "MEMBER_LIMIT" })
      expect(await count(w.id)).toEqual({ actual: 5, tracked: 5 })
      const audit = await pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM public.workspace_security_audit_events WHERE workspace_id=$1`,
        [w.id]
      )
      expect(audit.rows[0].total).toBe(2)
    }, 30_000)
  }
)

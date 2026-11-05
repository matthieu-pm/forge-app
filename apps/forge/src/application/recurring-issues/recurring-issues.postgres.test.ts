// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { Pool } from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { jobStore } from "../jobs/job-store"
import { runNextJob } from "../jobs/job-runner"
import type * as RecurringService from "./recurring-issues.server"
import type * as RecurringJobs from "./recurring-jobs.server"
import type { RecurringIssueDraft } from "@/lib/recurring-issue-contract"
import type { Actor } from "../actor"
import { addCycleDays, cycleToday } from "@/lib/cycle-calendar"
import { occurrenceAt } from "@/lib/recurrence-calendar"
import { emptyRecurringIssue } from "@/lib/recurring-issue-contract"

vi.mock("@tanstack/react-start/server-only", () => ({}))
const state = vi.hoisted(() => ({ pool: null as Pool | null }))
vi.mock("@/db", async () => {
  const tables = {
    ...(await import("@/db/schema")),
    ...(await import("@/db/auth-schema")),
    ...(await import("@/db/planning-schema")),
    ...(await import("@/db/jobs-schema")),
    ...(await import("@/db/loops-schema")),
    ...(await import("@/db/resources-schema")),
    ...(await import("@/db/sla-schema")),
    ...(await import("@/db/recurring-schema")),
  }
  return {
    ...tables,
    schema: tables,
    db: drizzle(state.pool!, { schema: tables }),
    databaseClient: state.pool,
  }
})
const connection = process.env.FORGE_RECURRING_TEST_DATABASE_URL

describe.skipIf(!connection)(
  "FOR-68 canonical recurring occurrence acceptance",
  () => {
    let pool: Pool, service: typeof RecurringService, jobs: typeof RecurringJobs
    const marker = `for68-${randomUUID()}`,
      workspaceId = marker,
      teamId = randomUUID(),
      ownerId = `${marker}-owner`,
      adminId = `${marker}-admin`
    let owner: Actor, admin: Actor
    beforeAll(async () => {
      const url = new URL(connection!)
      if (
        url.hostname !== "127.0.0.1" ||
        url.port !== "56468" ||
        url.pathname !== "/for68_recurring_test"
      )
        throw new Error("Dedicated local FOR-68 database required")
      pool = new Pool({ connectionString: connection, max: 10 })
      state.pool = pool
      expect(
        (await pool.query("select current_database() name")).rows[0].name
      ).toBe("for68_recurring_test")
      if (
        !(
          await pool.query(
            "select to_regclass('recurring_issue_occurrences') present"
          )
        ).rows[0].present
      ) {
        for (const file of readdirSync("drizzle")
          .filter((f) => f.endsWith(".sql"))
          .sort())
          await pool.query(readFileSync(`drizzle/${file}`, "utf8"))
      }
      vi.stubEnv(
        "FORGE_FEATURE_ROLLOUTS",
        JSON.stringify({
          recurringIssues: { mode: "enabled", workspaceIds: [workspaceId] },
        })
      )
      await pool.query(
        "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
        [workspaceId]
      )
      const actors: Array<Actor> = []
      for (const userId of [ownerId, adminId]) {
        await pool.query(
          'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
          [userId, `${userId}@example.test`]
        )
        await pool.query(
          "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",
          [randomUUID(), workspaceId, userId]
        )
        const sessionId = randomUUID()
        await pool.query(
          "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
          [sessionId, userId, workspaceId]
        )
        actors.push({
          userId,
          workspaceId,
          workspaceRole: "admin",
          authentication: { kind: "session", sessionId },
          scopes: null,
        })
      }
      ;[owner, admin] = actors
      await pool.query(
        "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Recurring','recurring','REC','workspace','emoji','🔥','#94a3b8','Europe/Paris',$3)",
        [teamId, workspaceId, ownerId]
      )
      service = await import("./recurring-issues.server")
      jobs = await import("./recurring-jobs.server")
    }, 60000)
    afterAll(async () => {
      if (!pool) return
      await pool.query(
        "DELETE FROM background_job_steps WHERE job_id IN (SELECT id FROM background_jobs WHERE input->>'workspaceId'=$1)",
        [workspaceId]
      )
      await pool.query(
        "DELETE FROM background_jobs WHERE input->>'workspaceId'=$1",
        [workspaceId]
      )
      await pool.query("DELETE FROM organization WHERE id=$1", [workspaceId])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [
        [ownerId, adminId],
      ])
      await pool.end()
      vi.unstubAllEnvs()
    })
    const draft = () => ({
      ...emptyRecurringIssue(teamId, "Europe/Paris"),
      title: "Recurring review",
      firstDue: "2026-03-22",
      unit: "day" as const,
    })
    const create = async (payload: RecurringIssueDraft = draft()) => {
      const result = await service.saveRecurringIssue(owner, {
        commandKey: randomUUID(),
        slug: "recurring",
        payload,
      })
      // Rewind only this fixture's activation to model downtime after an earlier start.
      await pool.query(
        "DELETE FROM recurring_issue_events WHERE workspace_id=$1 AND schedule_id=$2 AND reason='before-activation'",
        [workspaceId, result.id]
      )
      await pool.query(
        "UPDATE team_recurring_issues SET skipped_count=0,activated_at=$2 WHERE id=$1",
        [result.id, occurrenceAt(payload, 0)]
      )
      return result
    }
    const row = async (id: string) =>
      (await service.loadRecurringIssues(admin, "recurring")).find(
        (r) => r.id === id
      )!
    async function edit(
      id: string,
      patch: Record<string, unknown> = {},
      actor = owner
    ) {
      const saved = await row(id)
      return service.saveRecurringIssue(actor, {
        commandKey: randomUUID(),
        slug: "recurring",
        id,
        updatedAt: saved.updatedAt,
        payload: saved.payload,
        ...patch,
      })
    }
    async function due(id: string, firstDue = "2026-03-22") {
      await pool.query(
        "UPDATE team_recurring_issues SET payload=jsonb_set(payload,'{firstDue}',to_jsonb($2::text)),next_index=1,next_at='2026-03-23T08:00Z' WHERE id=$1",
        [id, firstDue]
      )
    }
    it("creates the first issue immediately and duplicate saves return one schedule and issue", async () => {
      const input = {
        commandKey: randomUUID(),
        id: undefined,
        updatedAt: undefined,
        slug: "recurring",
        payload: { ...draft(), firstDue: "2027-01-31" },
      }
      const [a, b] = await Promise.all([
        service.saveRecurringIssue(owner, input),
        service.saveRecurringIssue(owner, input),
      ])
      expect(a.id).toBe(b.id)
      const occurrences = (
        await pool.query(
          "SELECT o.*,i.properties FROM recurring_issue_occurrences o JOIN issues i ON i.id=o.issue_id WHERE schedule_id=$1",
          [a.id]
        )
      ).rows
      expect(occurrences).toHaveLength(1)
      expect(occurrences[0].properties.dueDate).toBe("2027-01-31")
      expect((await row(a.id)).nextAt).toBe("2027-02-01T08:00:00.000Z")
    })
    it("AT-01/AT-02: overlapping dispatchers/workers create only the latest eligible occurrence once and explain skipped dates", async () => {
      const { id } = await create()
      await due(id)
      const store = jobStore(pool)
      await Promise.all([
        jobs.dispatchRecurringOccurrences(pool, store),
        jobs.dispatchRecurringOccurrences(pool, store),
      ])
      const pending = (
        await pool.query(
          "SELECT * FROM recurring_issue_occurrences WHERE schedule_id=$1 AND state='pending'",
          [id]
        )
      ).rows
      expect(pending).toHaveLength(1)
      const results = await Promise.all([
        runNextJob(
          store,
          jobs.RECURRING_JOB_KIND,
          jobs.recurringIssueJob,
          pending[0].job_id
        ),
        runNextJob(
          store,
          jobs.RECURRING_JOB_KIND,
          jobs.recurringIssueJob,
          pending[0].job_id
        ),
      ])
      expect(results.map((r) => r.state).sort()).toEqual(["completed", "idle"])
      expect(
        (
          await pool.query(
            "SELECT * FROM recurring_issue_occurrences WHERE schedule_id=$1 AND state='created'",
            [id]
          )
        ).rows
      ).toHaveLength(2)
      expect((await row(id)).skippedCount).toBeGreaterThan(6)
      expect(
        (
          await pool.query(
            "SELECT * FROM recurring_issue_events WHERE schedule_id=$1 AND reason='downtime-latest-only'",
            [id]
          )
        ).rows
      ).toHaveLength(1)
    })
    it.each([
      ["2026-03-28", "2026-03-29T01:30:00.000Z"],
      ["2026-10-24", "2026-10-25T00:30:00.000Z"],
    ])(
      "AT-01: duplicate workers preserve the Paris DST interpretation from %s",
      async (firstDue, expected) => {
        const { id } = await create({
          ...draft(),
          firstDue,
          generationTime: "02:30",
        })
        const { db, teamRecurringIssues } = await import("@/db")
        const { eq } = await import("drizzle-orm")
        const { reserveOccurrence } = await import("./occurrences.server")
        const occurrence = await db.transaction(async (tx) =>
          reserveOccurrence(
            tx,
            (
              await tx
                .select()
                .from(teamRecurringIssues)
                .where(eq(teamRecurringIssues.id, id))
            )[0],
            1
          )
        )
        expect(occurrence.scheduledAt.toISOString()).toBe(expected)
        const store = jobStore(pool)
        await jobs.dispatchRecurringOccurrences(pool, store)
        const jobId = (
          await pool.query(
            "SELECT job_id FROM recurring_issue_occurrences WHERE id=$1",
            [occurrence.id]
          )
        ).rows[0].job_id
        await Promise.all([
          runNextJob(
            store,
            jobs.RECURRING_JOB_KIND,
            jobs.recurringIssueJob,
            jobId
          ),
          runNextJob(
            store,
            jobs.RECURRING_JOB_KIND,
            jobs.recurringIssueJob,
            jobId
          ),
        ])
        expect(
          (
            await pool.query(
              "SELECT o.state,i.properties->>'dueDate' due_date FROM recurring_issue_occurrences o JOIN issues i ON i.id=o.issue_id WHERE o.id=$1",
              [occurrence.id]
            )
          ).rows
        ).toEqual([{ state: "created", due_date: expected.slice(0, 10) }])
      }
    )
    it("rolls back an interrupted SQL effect and safely retries the same occurrence", async () => {
      const { id } = await create({ ...draft(), title: "Crash recovery" })
      await due(id)
      const store = jobStore(pool)
      await jobs.dispatchRecurringOccurrences(pool, store)
      const occurrence = (
        await pool.query(
          "SELECT * FROM recurring_issue_occurrences WHERE schedule_id=$1 AND state='pending'",
          [id]
        )
      ).rows[0]
      const before = (
        await pool.query(
          "SELECT count(*) n FROM issues WHERE workspace_id=$1",
          [workspaceId]
        )
      ).rows[0].n
      await pool.query(
        `CREATE FUNCTION for68_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title='Crash recovery' THEN RAISE EXCEPTION 'fixture interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER for68_fault AFTER INSERT ON issues FOR EACH ROW EXECUTE FUNCTION for68_fault()`
      )
      try {
        expect(
          (
            await runNextJob(
              store,
              jobs.RECURRING_JOB_KIND,
              jobs.recurringIssueJob,
              occurrence.job_id
            )
          ).state
        ).toBe("retry")
        expect(
          (
            await pool.query(
              "SELECT count(*) n FROM issues WHERE workspace_id=$1",
              [workspaceId]
            )
          ).rows[0].n
        ).toBe(before)
        expect(
          (
            await pool.query(
              "SELECT state FROM recurring_issue_occurrences WHERE id=$1",
              [occurrence.id]
            )
          ).rows[0].state
        ).toBe("pending")
      } finally {
        await pool.query(
          "DROP TRIGGER for68_fault ON issues; DROP FUNCTION for68_fault()"
        )
      }
      await pool.query(
        "UPDATE background_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [occurrence.job_id]
      )
      expect(
        (
          await runNextJob(
            store,
            jobs.RECURRING_JOB_KIND,
            jobs.recurringIssueJob,
            occurrence.job_id
          )
        ).state
      ).toBe("completed")
      expect(
        (
          await pool.query(
            "SELECT count(*) n FROM issues WHERE workspace_id=$1",
            [workspaceId]
          )
        ).rows[0].n
      ).toBe(String(Number(before) + 1))
    })
    it("freezes selected template content across edits and duplicate retry after a committed checkpoint", async () => {
      const { id } = await create()
      await due(id)
      const store = jobStore(pool)
      await jobs.dispatchRecurringOccurrences(pool, store)
      const occurrence = (
        await pool.query(
          "SELECT * FROM recurring_issue_occurrences WHERE schedule_id=$1 AND state='pending'",
          [id]
        )
      ).rows[0]
      const saved = await row(id)
      await edit(id, {
        payload: { ...saved.payload, title: "Future revision" },
      })
      const lease = await store.claim(
        jobs.RECURRING_JOB_KIND,
        occurrence.job_id
      )
      await jobs.recurringIssueJob(store, lease!)
      await jobs.recurringIssueJob(store, lease!)
      await store.complete(lease!)
      const result = (
        await pool.query(
          "SELECT i.title FROM issues i JOIN recurring_issue_occurrences o ON o.issue_id=i.id WHERE o.id=$1",
          [occurrence.id]
        )
      ).rows[0]
      expect(result.title).toBe("Recurring review")
    })
    it("skips disabled work and does not backfill when re-enabled", async () => {
      const { id } = await create()
      await due(id)
      const store = jobStore(pool)
      await jobs.dispatchRecurringOccurrences(pool, store)
      await edit(id, { enabled: false })
      await jobs.runRecurringJobs(pool, store)
      expect(
        (
          await pool.query(
            "SELECT * FROM recurring_issue_occurrences WHERE schedule_id=$1 AND state='pending'",
            [id]
          )
        ).rows
      ).toHaveLength(0)
      await edit(id, { enabled: true })
      await jobs.runRecurringJobs(pool, store)
      expect(
        (
          await pool.query(
            "SELECT * FROM recurring_issue_occurrences WHERE schedule_id=$1 AND state='created'",
            [id]
          )
        ).rows
      ).toHaveLength(1)
    })
    it("pauses after owner revocation and allows explicit admin ownership without replaying skipped work", async () => {
      const { id } = await create()
      await due(id)
      const store = jobStore(pool)
      await jobs.dispatchRecurringOccurrences(pool, store)
      await pool.query(
        "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
        [workspaceId, ownerId]
      )
      try {
        await jobs.runRecurringJobs(pool, store)
        expect(await row(id)).toMatchObject({
          state: "paused",
          lastReason: "owner-access-lost",
        })
        await edit(id, { enabled: true, takeOwnership: true }, admin)
        expect(await row(id)).toMatchObject({
          state: "active",
          ownerId: adminId,
        })
      } finally {
        await pool.query(
          "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",
          [randomUUID(), workspaceId, ownerId]
        )
      }
    })
    it("keeps legacy definitions inactive until explicit activation", async () => {
      const id = randomUUID()
      await pool.query(
        "INSERT INTO team_recurring_issues(id,workspace_id,team_id,created_by_user_id,payload) VALUES($1,$2,$3,$4,$5)",
        [id, workspaceId, teamId, ownerId, draft()]
      )
      await jobs.runRecurringJobs(pool, jobStore(pool))
      expect((await row(id)).state).toBe("inactive")
      await edit(id)
      expect((await row(id)).state).toBe("disabled")
      await edit(id, { enabled: true })
      expect(
        (
          await pool.query(
            "SELECT * FROM recurring_issue_occurrences WHERE schedule_id=$1 AND state='created'",
            [id]
          )
        ).rows
      ).toHaveLength(1)
    })
    it("preserves independent nested issue fields through canonical commands", async () => {
      const payload = draft()
      payload.subIssues = [
        {
          id: "child",
          title: "Follow up",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Nested detail" }],
              },
            ],
          },
          properties: {
            ...payload.properties,
            status: "Todo",
            priority: "High",
            assignee: adminId,
          },
        },
      ]
      const { id } = await create(payload)
      const generated = (
        await pool.query(
          "SELECT i.id,i.status_id,i.assignee_id,i.properties,i.parent_id FROM issues i WHERE i.workspace_id=$1 AND (i.id IN (SELECT issue_id FROM recurring_issue_occurrences WHERE schedule_id=$2) OR i.parent_id IN (SELECT issue_id FROM recurring_issue_occurrences WHERE schedule_id=$2)) ORDER BY i.number",
          [workspaceId, id]
        )
      ).rows
      expect(generated).toHaveLength(2)
      expect(generated[1]).toMatchObject({
        parent_id: generated[0].id,
        status_id: "todo",
        assignee_id: adminId,
        properties: { description: "Nested detail", priority: "High" },
      })
    })
    it("rolls back parent and nested work on invalid references and protects stale edits", async () => {
      const payload = draft()
      payload.subIssues = [
        {
          id: "child",
          title: "Invalid child",
          content: null,
          properties: { ...payload.properties, assignee: "not-a-member" },
        },
      ]
      const before = (
        await pool.query(
          "SELECT count(*) n FROM issues WHERE workspace_id=$1",
          [workspaceId]
        )
      ).rows[0].n
      await expect(create(payload)).rejects.toThrow()
      expect(
        (
          await pool.query(
            "SELECT count(*) n FROM issues WHERE workspace_id=$1",
            [workspaceId]
          )
        ).rows[0].n
      ).toBe(before)
      const { id } = await create()
      const saved = await row(id)
      await edit(id)
      await expect(
        service.saveRecurringIssue(owner, {
          commandKey: randomUUID(),
          slug: "recurring",
          id,
          updatedAt: saved.updatedAt,
          payload: saved.payload,
        })
      ).rejects.toThrow(/another window/)
    })
    it("reschedules temporal edits from their new future anchor without another immediate issue", async () => {
      const { id } = await create()
      const saved = await row(id)
      await edit(id, {
        payload: {
          ...saved.payload,
          firstDue: "2030-01-01",
          generationTime: "02:30",
        },
      })
      expect((await row(id)).nextAt).toBe("2030-01-01T01:30:00.000Z")
      expect(
        (
          await pool.query(
            "SELECT count(*) n FROM recurring_issue_occurrences WHERE schedule_id=$1 AND state='created'",
            [id]
          )
        ).rows[0].n
      ).toBe("1")
    })
    it("does not advertise an already-created future date after a time edit", async () => {
      const { id } = await create({ ...draft(), firstDue: "2030-01-01" })
      const saved = await row(id)
      await edit(id, { payload: { ...saved.payload, generationTime: "02:30" } })
      expect((await row(id)).nextAt).toBe("2030-01-02T01:30:00.000Z")
    })
    it("does not resurrect a disabled date after moving its local time later", async () => {
      const now = new Date(
        (await pool.query("SELECT clock_timestamp() AS now")).rows[0].now
      )
      const timezone = now.getUTCHours() < 12 ? "UTC" : "Etc/GMT+12"
      const today = cycleToday(timezone, now)
      const payload = {
        ...draft(),
        firstDue: addCycleDays(today, -2),
        timezone,
        generationTime: "00:00",
      }
      const { id } = await create(payload)
      await pool.query(
        "UPDATE team_recurring_issues SET state='disabled',next_index=2,next_at=NULL WHERE id=$1",
        [id]
      )
      await edit(id, { enabled: true })
      await edit(id, { payload: { ...payload, generationTime: "23:00" } })
      expect((await row(id)).nextAt).toBe(
        occurrenceAt({ ...payload, generationTime: "23:00" }, 3).toISOString()
      )
    })
    it("keeps skipped ranges precise and immutable and rejects direct reservation of their dates", async () => {
      const payload = {
        ...draft(),
        firstDue: "2030-01-31",
        unit: "month" as const,
      }
      const { id } = await create(payload)
      const { db, teamRecurringIssues } = await import("@/db")
      const { eq } = await import("drizzle-orm")
      const { recordSkipped, dateWasSkipped, reserveOccurrence } =
        await import("./occurrences.server")
      await db.transaction(async (tx) => {
        const [schedule] = await tx
          .select()
          .from(teamRecurringIssues)
          .where(eq(teamRecurringIssues.id, id))
        await recordSkipped(tx, schedule, "disabled-period", 1, 2)
        expect(await dateWasSkipped(tx, id, "2030-02-28")).toBe(true)
        expect(await dateWasSkipped(tx, id, "2030-03-31")).toBe(true)
        expect(await dateWasSkipped(tx, id, "2030-03-28")).toBe(false)
        expect((await reserveOccurrence(tx, schedule, 1)).state).toBe("skipped")
      })
      await expect(
        pool.query(
          "UPDATE recurring_issue_events SET calendar=calendar||'{\"interval\":2}'::jsonb WHERE schedule_id=$1 AND reason='disabled-period'",
          [id]
        )
      ).rejects.toThrow()
    })
    it("does not let a disabled workspace consume the bounded dispatch batch", async () => {
      const foreignWorkspace = `${marker}-disabled`,
        foreignTeam = randomUUID()
      await pool.query(
        "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
        [foreignWorkspace]
      )
      try {
        await pool.query(
          "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Disabled','disabled','OFF','workspace','emoji','🔥','#94a3b8','Europe/Paris',$3)",
          [foreignTeam, foreignWorkspace, ownerId]
        )
        const payload = {
          ...draft(),
          properties: { ...draft().properties, teamIds: [foreignTeam] },
        }
        await pool.query(
          "INSERT INTO team_recurring_issues(workspace_id,team_id,created_by_user_id,payload,state,next_at) SELECT $1,$2,$3,$4,'active','2000-01-01' FROM generate_series(1,101)",
          [foreignWorkspace, foreignTeam, ownerId, payload]
        )
        const { id } = await create()
        await due(id)
        await jobs.runRecurringJobs(pool, jobStore(pool))
        expect(
          (
            await pool.query(
              "SELECT count(*) n FROM recurring_issue_occurrences WHERE schedule_id=$1 AND state='created'",
              [id]
            )
          ).rows[0].n
        ).toBe("2")
        expect(
          (
            await pool.query(
              "SELECT count(*) n FROM recurring_issue_occurrences WHERE workspace_id=$1",
              [foreignWorkspace]
            )
          ).rows[0].n
        ).toBe("0")
      } finally {
        await pool.query("DELETE FROM organization WHERE id=$1", [
          foreignWorkspace,
        ])
      }
    })
    it("gates execution and prevents deleted schedules from producing pending work", async () => {
      const { id } = await create()
      await due(id)
      const store = jobStore(pool)
      await jobs.dispatchRecurringOccurrences(pool, store)
      vi.stubEnv("FORGE_FEATURE_ROLLOUTS", "{}")
      expect(await jobs.dispatchRecurringOccurrences(pool, store)).toBe(0)
      vi.stubEnv(
        "FORGE_FEATURE_ROLLOUTS",
        JSON.stringify({
          recurringIssues: { mode: "enabled", workspaceIds: [workspaceId] },
        })
      )
      const saved = await row(id)
      await service.deleteRecurringIssue(owner, {
        slug: "recurring",
        id,
        updatedAt: saved.updatedAt,
      })
      await jobs.runRecurringJobs(pool, store)
      expect(
        (
          await pool.query(
            "SELECT * FROM recurring_issue_occurrences WHERE schedule_id=$1 AND state='created'",
            [id]
          )
        ).rows
      ).toHaveLength(1)
    })
  }
)

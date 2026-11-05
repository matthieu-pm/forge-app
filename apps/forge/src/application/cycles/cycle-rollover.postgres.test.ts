// @vitest-environment node
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { Pool } from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { jobStore } from "../jobs/job-store"
import { runNextJob } from "../jobs/job-runner"
import { blankIssueDraft } from "../../lib/issue-record-contract"
import {
  initialTeamCycles,
  teamCyclesStorageKey,
} from "../../lib/team-cycles-contract"
import {
  CYCLE_ROLLOVER_KIND,
  cycleRollover,
  dispatchCycleRollovers,
} from "./cycle-rollover"
import type { Actor } from "../actor"
import type * as Cycles from "./cycles.server"
import type * as IssueQuery from "../issues/query-issues.server"
import type * as History from "../issues/issue-history.server"
import type * as Editing from "../issues/edit-issues.server"
import type * as ProductState from "../product-state/product-state.server"

vi.mock("@tanstack/react-start/server-only", () => ({}))
const connection = process.env.FORGE_ROLLOVER_TEST_DATABASE_URL

describe.skipIf(!connection)("FOR-69 PostgreSQL acceptance", () => {
  let pool: Pool
  let store: ReturnType<typeof jobStore>
  let cycles: typeof Cycles,
    query: typeof IssueQuery,
    history: typeof History,
    editing: typeof Editing,
    productState: typeof ProductState
  const workspaces: Array<string> = [],
    users: Array<string> = []
  beforeAll(async () => {
    const url = new URL(connection!)
    if (
      url.hostname !== "127.0.0.1" ||
      url.port !== "56469" ||
      url.pathname !== "/for69_cycles_test"
    )
      throw new Error("Dedicated local FOR-69 database required")
    pool = new Pool({ connectionString: connection, max: 12 })
    expect(
      (await pool.query("SELECT current_database() name")).rows[0].name
    ).toBe("for69_cycles_test")
    if (
      !(await pool.query("SELECT to_regclass('background_jobs') present"))
        .rows[0].present
    ) {
      for (const file of readdirSync("drizzle")
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        try {
          const migration = readFileSync(`drizzle/${file}`, "utf8")
          if (file === "0078_cycle_rollover.sql") {
            const rehearsal = await pool.connect()
            try {
              await rehearsal.query("BEGIN")
              await rehearsal.query(migration)
              expect(
                (
                  await rehearsal.query(
                    "SELECT count(*)::int n FROM pg_constraint WHERE contype='p' AND conrelid=ANY(ARRAY['cycle_rollover_teams'::regclass,'cycle_closures'::regclass,'cycle_membership_history'::regclass])"
                  )
                ).rows[0].n
              ).toBe(3)
              await rehearsal.query("ROLLBACK")
              expect(
                (
                  await rehearsal.query(
                    "SELECT to_regclass('cycle_closures') AS present"
                  )
                ).rows[0].present
              ).toBeNull()
            } finally {
              rehearsal.release()
            }
          }
          await pool.query(migration)
        } catch (e) {
          throw new Error(`Migration ${file} failed`, { cause: e })
        }
      }
    }
    store = jobStore(pool)
    vi.doMock("@/db", async () => {
      const parts = await Promise.all([
        import("@/db/schema"),
        import("@/db/auth-schema"),
        import("@/db/planning-schema"),
        import("@/db/jobs-schema"),
        import("@/db/loops-schema"),
        import("@/db/resources-schema"),
        import("@/db/sla-schema"),
      ])
      const schema = Object.assign({}, ...parts)
      return {
        ...schema,
        schema,
        db: drizzle(pool, { schema }),
        databaseClient: pool,
      }
    })
    cycles = await import("./cycles.server")
    query = await import("../issues/query-issues.server")
    history = await import("../issues/issue-history.server")
    editing = await import("../issues/edit-issues.server")
    productState = await import("../product-state/product-state.server")
  }, 30000)
  afterAll(async () => {
    if (!pool) return
    const ids = (
      await pool.query(
        "SELECT id FROM background_jobs WHERE kind=$1 AND input->>'workspaceId'=ANY($2)",
        [CYCLE_ROLLOVER_KIND, workspaces]
      )
    ).rows.map((r) => r.id)
    await pool.query(
      "DELETE FROM background_job_steps WHERE job_id=ANY($1::uuid[])",
      [ids]
    )
    await pool.query(
      "DELETE FROM background_job_recoveries WHERE job_id=ANY($1::uuid[])",
      [ids]
    )
    await pool.query("DELETE FROM background_jobs WHERE id=ANY($1::uuid[])", [
      ids,
    ])
    await pool.query("DELETE FROM cycle_closures WHERE workspace_id=ANY($1)", [
      workspaces,
    ])
    await pool.query("DELETE FROM organization WHERE id=ANY($1)", [workspaces])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM cycle_rollover_teams WHERE workspace_id=ANY($1)",
          [workspaces]
        )
      ).rows[0].n
    ).toBe(0)
    await pool.end()
    vi.unstubAllEnvs()
    vi.doUnmock("@/db")
  })
  function gate(enabled = true) {
    vi.stubEnv(
      "FORGE_FEATURE_ROLLOUTS",
      JSON.stringify({
        cycleRollover: {
          mode: "enabled",
          workspaceIds: enabled ? [...workspaces] : [],
        },
      })
    )
  }
  async function fixture({
    carryover = true,
    enrollment = "2020-01-01",
    timezone = "Europe/Paris",
  } = {}) {
    const workspaceId = `for69-${randomUUID()}`,
      userId = `for69-${randomUUID()}`,
      teamId = randomUUID(),
      sessionId = randomUUID()
    workspaces.push(workspaceId)
    users.push(userId)
    await pool.query(
      "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
      [workspaceId]
    )
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
      [userId, `${userId}@example.test`]
    )
    await pool.query(
      "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')",
      [randomUUID(), workspaceId, userId]
    )
    await pool.query(
      "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
      [sessionId, userId, workspaceId]
    )
    await pool.query(
      "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1::uuid,$2,'Rollover',$1::text,'CYC','workspace','emoji','🔥','#94a3b8',$3,$4)",
      [teamId, workspaceId, timezone, userId]
    )
    const settings = {
      ...initialTeamCycles(),
      enabled: true,
      carryover,
      timezone,
      cooldown: 2,
    }
    await pool.query(
      "INSERT INTO product_state(workspace_id,owner_id,team_id,key,encoded_value) VALUES($1,'workspace',$2,$3,$4)",
      [
        workspaceId,
        teamId,
        teamCyclesStorageKey(teamId),
        JSON.stringify(JSON.stringify(settings)),
      ]
    )
    if (enrollment)
      await pool.query(
        "INSERT INTO cycle_rollover_teams(workspace_id,team_id,enabled_at) VALUES($1,$2,$3)",
        [workspaceId, teamId, enrollment]
      )
    gate()
    const actor: Actor = {
      workspaceId,
      userId,
      workspaceRole: "admin",
      scopes: null,
      authentication: { kind: "session", sessionId },
    }
    const f = {
      workspaceId,
      teamId,
      actor,
      sessionId,
      settings,
      old: "",
      next: "",
    }
    f.old = await window(f, "2025-03-17", "2025-03-30", timezone)
    f.next = await window(f, "2099-04-01", "2099-04-14", timezone)
    return f
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function window(
    f: { workspaceId: string; teamId: string },
    start: string,
    end: string,
    timezone: string
  ) {
    return (
      await pool.query(
        "INSERT INTO issue_cycles(workspace_id,team_id,start_date,end_date,timezone) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [f.workspaceId, f.teamId, start, end, timezone]
      )
    ).rows[0].id as string
  }
  let issueNumber = 1
  async function issue(f: Fixture, status = "todo", cycleId = f.old) {
    const draft = {
      ...blankIssueDraft(status),
      title: "Rollover acceptance",
      cycle: cycleId,
    }
    return (
      await pool.query(
        "INSERT INTO issues(workspace_id,team_id,number,title,status_id,cycle_id,properties) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,revision",
        [
          f.workspaceId,
          f.teamId,
          issueNumber++,
          draft.title,
          status,
          cycleId,
          draft,
        ]
      )
    ).rows[0]
  }
  async function run(f: Fixture) {
    await dispatchCycleRollovers(pool, store)
    const id = (
      await pool.query(
        "SELECT id FROM background_jobs WHERE kind=$1 AND identity=$2",
        [CYCLE_ROLLOVER_KIND, f.old]
      )
    ).rows[0]?.id
    expect(id).toBeTruthy()
    return {
      id,
      result: await runNextJob(store, CYCLE_ROLLOVER_KIND, cycleRollover, id),
    }
  }
  it("AT-01: duplicate rollover keeps canonical identity, closing membership, progress, audit and one carryover", async () => {
    const f = await fixture(),
      done = await issue(f, "done"),
      pending = await issue(f)
    const { id, result } = await run(f)
    expect(result.state).toBe("completed")
    expect(
      (await runNextJob(store, CYCLE_ROLLOVER_KIND, cycleRollover, id)).state
    ).toBe("idle")
    expect(
      (
        await pool.query(
          "SELECT id,cycle_id,revision,properties->>'cycle' AS property FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id",
          [[done.id, pending.id]]
        )
      ).rows
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: done.id,
          cycle_id: f.old,
          revision: done.revision,
        }),
        expect.objectContaining({
          id: pending.id,
          cycle_id: f.next,
          property: f.next,
          revision: pending.revision + 1,
        }),
      ])
    )
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(2)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM cycle_membership_history WHERE cycle_id=$1",
          [f.old]
        )
      ).rows[0].n
    ).toBe(2)
    const snapshot = await cycles.readTeamCycles(f.actor, f.teamId)
    expect(snapshot.cycles.find((c) => c.id === f.old)).toMatchObject({
      state: "Closed",
      issueCount: 2,
      completedCount: 1,
      closure: { carriedCount: 1 },
    })
    await pool.query("UPDATE issues SET status_id='done' WHERE id=$1", [
      pending.id,
    ])
    expect(
      (await cycles.readTeamCycles(f.actor, f.teamId)).cycles.find(
        (c) => c.id === f.old
      )?.completedCount
    ).toBe(1)
    const page = await query.queryCanonicalIssues(f.actor, {
      teamIds: [f.teamId],
      cycle: f.old,
      limit: 1,
    })
    expect(page.total).toBe(2)
    expect(page.nextCursor).toBeTruthy()
    const second = await query.queryCanonicalIssues(f.actor, {
      teamIds: [f.teamId],
      cycle: f.old,
      limit: 1,
      cursor: page.nextCursor!,
    })
    expect(
      new Set([...page.records, ...second.records].map((r) => r.issue.id))
    ).toEqual(new Set([done.id, pending.id]))
    const events = await history.queryIssueHistory(f.actor, {
      issueId: pending.id,
    })
    expect(events.entries).toContainEqual(
      expect.objectContaining({
        topic: "issue.cycle.carried",
        origin: "system",
        actor: {
          userId: "system:cycle-rollover",
          name: "Forge cycles",
          kind: "system",
        },
        changes: [{ field: "cycle", from: f.old, to: f.next }],
      })
    )
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE workspace_id=$1 AND operation='cycles.close@1'",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(1)
  })
  it("AT-02: delayed processing respects newer completion, cancellation, manual membership and unrelated edits", async () => {
    const f = await fixture(),
      completed = await issue(f),
      canceled = await issue(f),
      moved = await issue(f),
      renamed = await issue(f),
      duplicate = await issue(f, "duplicate")
    await dispatchCycleRollovers(pool, store)
    await pool.query("UPDATE issues SET status_id='done' WHERE id=$1", [
      completed.id,
    ])
    await pool.query("UPDATE issues SET status_id='canceled' WHERE id=$1", [
      canceled.id,
    ])
    await pool.query("UPDATE issues SET cycle_id=$2 WHERE id=$1", [
      moved.id,
      f.next,
    ])
    await pool.query(
      "UPDATE issues SET title='Newer title',properties=properties||'{\"description\":\"Newer description\"}'::jsonb WHERE id=$1",
      [renamed.id]
    )
    expect((await run(f)).result.state).toBe("completed")
    const rows = (
      await pool.query(
        "SELECT id,cycle_id,title,properties FROM issues WHERE workspace_id=$1",
        [f.workspaceId]
      )
    ).rows
    for (const id of [completed.id, canceled.id, duplicate.id])
      expect(rows.find((r) => r.id === id).cycle_id).toBe(f.old)
    expect(rows.find((r) => r.id === moved.id).cycle_id).toBe(f.next)
    expect(rows.find((r) => r.id === renamed.id)).toMatchObject({
      cycle_id: f.next,
      title: "Newer title",
      properties: { description: "Newer description" },
    })
    expect(
      (
        await pool.query(
          "SELECT issue_id FROM cycle_membership_history WHERE cycle_id=$1 AND carried",
          [f.old]
        )
      ).rows.map((r) => r.issue_id)
    ).toEqual([renamed.id])
    expect(
      (
        await pool.query(
          "SELECT issue_id FROM cycle_membership_history WHERE cycle_id=$1",
          [f.old]
        )
      ).rows.map((r) => r.issue_id)
    ).not.toContain(moved.id)
    const stale = await editing.editCanonicalIssues(f.actor, {
      teamId: f.teamId,
      commandKey: randomUUID(),
      edits: [
        {
          issueId: renamed.id,
          expectedRevision: renamed.revision,
          changes: { title: "Stale overwrite" },
        },
      ],
    })
    expect(stale.status).toBe("conflict")
    expect(
      (await pool.query("SELECT title FROM issues WHERE id=$1", [renamed.id]))
        .rows[0].title
    ).toBe("Newer title")
  })
  for (const phase of ["before-commit", "after-commit"])
    it(`AT-02: SIGKILL ${phase} resumes to one consistent closure`, async () => {
      const f = await fixture(),
        pending = await issue(f)
      await dispatchCycleRollovers(pool, store)
      const id = (
        await pool.query(
          "SELECT id FROM background_jobs WHERE identity=$1 AND kind=$2",
          [f.old, CYCLE_ROLLOVER_KIND]
        )
      ).rows[0].id
      const child = spawn(
        "bun",
        ["scripts/cycle-rollover-acceptance-worker.ts", id, phase],
        {
          env: { ...process.env, FORGE_ROLLOVER_TEST_DATABASE_URL: connection },
          stdio: ["ignore", "pipe", "pipe"],
        }
      )
      const exited = new Promise<void>((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", () => resolve())
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Worker boundary timeout")),
            10000
          )
          child.stdout.on("data", (data) => {
            if (String(data).includes("ready")) {
              clearTimeout(timeout)
              resolve()
            }
          })
          child.once("exit", () => {
            clearTimeout(timeout)
            reject(new Error("Worker exited before boundary"))
          })
        })
        expect(
          (
            await pool.query(
              "SELECT count(*)::int n FROM cycle_closures WHERE cycle_id=$1",
              [f.old]
            )
          ).rows[0].n
        ).toBe(phase === "after-commit" ? 1 : 0)
      } finally {
        child.kill("SIGKILL")
        await exited
      }
      await pool.query(
        "UPDATE background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id]
      )
      await store.reap()
      await pool.query(
        "UPDATE background_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id]
      )
      expect(
        (await runNextJob(store, CYCLE_ROLLOVER_KIND, cycleRollover, id)).state
      ).toBe("completed")
      expect(
        (
          await pool.query("SELECT revision,cycle_id FROM issues WHERE id=$1", [
            pending.id,
          ])
        ).rows[0]
      ).toEqual({ revision: pending.revision + 1, cycle_id: f.next })
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM command_outbox_events WHERE workspace_id=$1 AND topic='issue.cycle.carried'",
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(1)
    })
  it("first enrollment excludes ended cycles and closing is timezone-aware across DST", async () => {
    const f = await fixture({ enrollment: "" })
    await issue(f)
    await dispatchCycleRollovers(pool, store)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM background_jobs WHERE identity=$1 AND kind=$2",
          [f.old, CYCLE_ROLLOVER_KIND]
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT * FROM cycle_rollover_teams WHERE team_id=$1",
          [f.teamId]
        )
      ).rows
    ).toHaveLength(1)
    const boundaries = (
      await pool.query(
        "SELECT ((end_date::date+1)::timestamp AT TIME ZONE timezone) AS due FROM issue_cycles WHERE id=$1",
        [f.old]
      )
    ).rows[0].due
    expect(new Date(boundaries).toISOString()).toBe("2025-03-30T22:00:00.000Z")
    const snapshot = await cycles.readTeamCycles(f.actor, f.teamId)
    expect(snapshot.cycles.find((c) => c.id === f.old)).toMatchObject({
      state: "Past",
      issueCount: 1,
    })
  })
  it("carryover off freezes history without moving issues, and a closed cycle rejects new membership", async () => {
    const f = await fixture({ carryover: false }),
      pending = await issue(f)
    expect((await run(f)).result.state).toBe("completed")
    expect(
      (
        await pool.query("SELECT cycle_id,revision FROM issues WHERE id=$1", [
          pending.id,
        ])
      ).rows[0]
    ).toEqual({ cycle_id: f.old, revision: pending.revision })
    await expect(issue(f)).rejects.toMatchObject({
      constraint: "issues_cycle_closed",
    })
    await expect(
      pool.query(
        "UPDATE cycle_membership_history SET status_group='completed' WHERE cycle_id=$1",
        [f.old]
      )
    ).rejects.toThrow(/immutable/)
  })
  it("workspace gate stops deferred processing and rejects forged carryover settings", async () => {
    const f = await fixture(),
      pending = await issue(f)
    await dispatchCycleRollovers(pool, store)
    gate(false)
    const id = (
      await pool.query(
        "SELECT id FROM background_jobs WHERE identity=$1 AND kind=$2",
        [f.old, CYCLE_ROLLOVER_KIND]
      )
    ).rows[0].id
    expect(
      (await runNextJob(store, CYCLE_ROLLOVER_KIND, cycleRollover, id)).state
    ).toBe("deferred")
    expect(
      (
        await pool.query("SELECT cycle_id FROM issues WHERE id=$1", [
          pending.id,
        ])
      ).rows[0].cycle_id
    ).toBe(f.old)
    await expect(
      productState.saveProductState(f.actor, {
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        key: teamCyclesStorageKey(f.teamId),
        expectedRevision: 0,
        commandKey: randomUUID(),
        value: JSON.stringify({ ...f.settings, carryover: false }),
      })
    ).rejects.toThrow(/unavailable/)
    gate()
    await pool.query(
      "UPDATE background_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [id]
    )
    expect(
      (await runNextJob(store, CYCLE_ROLLOVER_KIND, cycleRollover, id)).state
    ).toBe("completed")
  })
  it("concurrent workers share one closure and a missing future window is created without missed historical cycles", async () => {
    const f = await fixture(),
      pending = await issue(f)
    await pool.query("DELETE FROM issue_cycles WHERE id=$1", [f.next])
    await dispatchCycleRollovers(pool, store)
    const id = (
      await pool.query(
        "SELECT id FROM background_jobs WHERE identity=$1 AND kind=$2",
        [f.old, CYCLE_ROLLOVER_KIND]
      )
    ).rows[0].id
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runNextJob(store, CYCLE_ROLLOVER_KIND, cycleRollover, id)
      )
    )
    expect(results.filter((r) => r.state === "completed")).toHaveLength(1)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM cycle_closures WHERE cycle_id=$1",
          [f.old]
        )
      ).rows[0].n
    ).toBe(1)
    const target = (
      await pool.query(
        "SELECT c.start_date,c.end_date FROM issue_cycles c JOIN issues i ON i.cycle_id=c.id WHERE i.id=$1",
        [pending.id]
      )
    ).rows[0]
    expect(target.start_date > new Date().toISOString().slice(0, 10)).toBe(true)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issue_cycles WHERE team_id=$1",
          [f.teamId]
        )
      ).rows[0].n
    ).toBe(2)
  })
  it("historical membership and totals recheck live private-team access and revoked workspace membership", async () => {
    const f = await fixture(),
      pending = await issue(f)
    expect((await run(f)).result.state).toBe("completed")
    const privateTeam = randomUUID()
    await pool.query(
      "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1::uuid,$2,'Private',$1::text,'PRIVATE','private','emoji','X','#94a3b8','UTC',$3)",
      [privateTeam, f.workspaceId, f.actor.userId]
    )
    await pool.query("UPDATE issues SET team_id=$2,cycle_id=NULL WHERE id=$1", [
      pending.id,
      privateTeam,
    ])
    await pool.query(
      "UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, f.actor.userId]
    )
    const visible = await cycles.readTeamCycles(f.actor, f.teamId)
    expect(visible.cycles.find((c) => c.id === f.old)).toMatchObject({
      state: "Closed",
      issueCount: 0,
      completedCount: 0,
      closure: { carriedCount: 0 },
    })
    expect(
      (
        await query.queryCanonicalIssues(f.actor, {
          teamIds: [f.teamId],
          cycle: f.old,
        })
      ).total
    ).toBe(0)
    await expect(
      history.queryIssueHistory(f.actor, { issueId: pending.id })
    ).rejects.toThrow()
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, f.actor.userId]
    )
    await expect(cycles.readTeamCycles(f.actor, f.teamId)).rejects.toThrow()
  })
  it("admin carryover policy saves through the canonical command and ordinary members cannot change it", async () => {
    const f = await fixture(),
      pending = await issue(f)
    const input = {
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      key: teamCyclesStorageKey(f.teamId),
      expectedRevision: 0,
      commandKey: randomUUID(),
      value: JSON.stringify({ ...f.settings, carryover: false }),
    }
    await pool.query(
      "UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, f.actor.userId]
    )
    await expect(
      productState.saveProductState(f.actor, input)
    ).rejects.toThrow()
    await pool.query(
      "UPDATE member SET role='admin' WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, f.actor.userId]
    )
    await productState.saveProductState(f.actor, input)
    expect(
      (await cycles.readTeamCycles(f.actor, f.teamId)).settings.carryover
    ).toBe(false)
    expect((await run(f)).result.state).toBe("completed")
    expect(
      (
        await pool.query("SELECT cycle_id FROM issues WHERE id=$1", [
          pending.id,
        ])
      ).rows[0].cycle_id
    ).toBe(f.old)
  })
  it("rejects cross-tenant closing relationships and defers premature closure without moving work", async () => {
    const f = await fixture(),
      foreign = await fixture()
    await expect(
      pool.query(
        "INSERT INTO cycle_closures(workspace_id,team_id,cycle_id,target_cycle_id,carryover) VALUES($1,$2,$3,$4,true)",
        [f.workspaceId, f.teamId, f.old, foreign.next]
      )
    ).rejects.toMatchObject({ constraint: "cycle_closure_target_fk" })
    const pending = await issue(f, "todo", f.next)
    const id = await store.enqueue({
      kind: CYCLE_ROLLOVER_KIND,
      scope: f.teamId,
      identity: f.next,
      scheduledAt: new Date("2000-01-01"),
      input: { workspaceId: f.workspaceId, teamId: f.teamId, cycleId: f.next },
    })
    expect(
      (await runNextJob(store, CYCLE_ROLLOVER_KIND, cycleRollover, id)).state
    ).toBe("deferred")
    expect(
      (
        await pool.query("SELECT cycle_id FROM issues WHERE id=$1", [
          pending.id,
        ])
      ).rows[0].cycle_id
    ).toBe(f.next)
  })
  for (const enabled of [true, false])
    it(`preserves an opted-out carryover policy when an older client saves schedule changes with gate ${enabled}`, async () => {
      const f = await fixture({ carryover: false })
      gate(enabled)
      const { carryover: _carryover, ...legacy } = f.settings
      const input = {
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        key: teamCyclesStorageKey(f.teamId),
        expectedRevision: 0,
        commandKey: randomUUID(),
        value: JSON.stringify({ ...legacy, duration: 3 }),
      }
      await productState.saveProductState(f.actor, input)
      expect(
        (await cycles.readTeamCycles(f.actor, f.teamId)).settings
      ).toMatchObject({ duration: 3, carryover: false })
      const replay = await productState.saveProductState(f.actor, input)
      expect(replay.replayed).toBe(true)
      expect(
        (await cycles.readTeamCycles(f.actor, f.teamId)).settings.carryover
      ).toBe(false)
    })
})

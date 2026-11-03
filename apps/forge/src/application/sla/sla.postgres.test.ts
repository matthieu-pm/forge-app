// @vitest-environment node
import { spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { jobStore } from "../jobs/job-store"
import { runNextJob } from "../jobs/job-runner"
import { slaGate } from "./sla-gate"
import { SLA_JOB_KIND, dispatchSlaIntents, slaBreachJob } from "./sla-jobs"
import type * as SlaPolicyService from "./sla-policy.server"
import type * as IssuesService from "../issues/issues.server"
import type * as EditingService from "../issues/edit-issues.server"
import type * as LifecycleService from "../issues/issue-lifecycle.server"
import type * as HistoryService from "../issues/issue-history.server"
import type { Actor } from "@/application/actor"
import type { SharedSlaPolicy, SharedSlaRule } from "@/lib/shared-sla-contract"
import type { IssueChanges } from "@/lib/canonical-issue-edit-contract"
import { blankIssueDraft } from "@/lib/issue-record-contract"

vi.mock("@tanstack/react-start/server-only", () => ({}))
const connection = process.env.FORGE_SLA_TEST_DATABASE_URL
describe.skipIf(!connection)("FOR-125 PostgreSQL acceptance", () => {
  let pool: Pool
  let policy: typeof SlaPolicyService
  let issues: typeof IssuesService
  let editing: typeof EditingService
  let lifecycle: typeof LifecycleService
  let history: typeof HistoryService
  const workspaces: Array<string> = [],
    users: Array<string> = []
  let number = 10000
  beforeAll(async () => {
    const url = new URL(connection!)
    if (
      url.hostname !== "127.0.0.1" ||
      url.port !== "56525" ||
      url.pathname !== "/for125_sla_test"
    )
      throw new Error("Dedicated local FOR-125 database required")
    pool = new Pool({ connectionString: connection, max: 12 })
    expect(
      (await pool.query("SELECT current_database() name")).rows[0].name
    ).toBe("for125_sla_test")
    vi.doMock("@/db", async () => {
      const parts = await Promise.all([
        import("@/db/schema"),
        import("@/db/auth-schema"),
        import("@/db/planning-schema"),
        import("@/db/loops-schema"),
        import("@/db/resources-schema"),
        import("@/db/jobs-schema"),
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
    policy = await import("./sla-policy.server")
    issues = await import("../issues/issues.server")
    editing = await import("../issues/edit-issues.server")
    lifecycle = await import("../issues/issue-lifecycle.server")
    history = await import("../issues/issue-history.server")
  })
  afterAll(async () => {
    if (!pool) return
    const jobs = (
      await pool.query(
        "SELECT id FROM background_jobs WHERE kind=$1 AND input->>'workspaceId'=ANY($2)",
        [SLA_JOB_KIND, workspaces]
      )
    ).rows.map((r) => r.id)
    await pool.query(
      "DELETE FROM background_job_steps WHERE job_id=ANY($1::uuid[])",
      [jobs]
    )
    await pool.query(
      "DELETE FROM background_job_recoveries WHERE job_id=ANY($1::uuid[])",
      [jobs]
    )
    await pool.query("DELETE FROM background_jobs WHERE id=ANY($1::uuid[])", [
      jobs,
    ])
    await pool.query("DELETE FROM organization WHERE id=ANY($1)", [workspaces])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issue_slas WHERE workspace_id=ANY($1)",
          [workspaces]
        )
      ).rows[0].n
    ).toBe(0)
    await pool.end()
    vi.unstubAllEnvs()
    vi.doUnmock("@/db")
  })
  function apply(
    priority = "Urgent",
    duration: { value: number; unit: "hour" | "business-day" } = {
      value: 1,
      unit: "hour",
    }
  ): Extract<SharedSlaRule, { action: "apply" }> {
    return {
      id: randomUUID(),
      enabled: true,
      action: "apply",
      filters: { priorities: [priority as "Urgent"] },
      duration,
      startMode: "ruleMatch",
    }
  }
  async function fixture(rules: Array<SharedSlaRule> = [apply()]) {
    const workspaceId = `for125-${randomUUID()}`,
      userId = `for125-${randomUUID()}`,
      memberId = `for125-${randomUUID()}`,
      teamId = randomUUID()
    workspaces.push(workspaceId)
    users.push(userId, memberId)
    await pool.query(
      "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
      [workspaceId]
    )
    const actors: Array<Actor> = []
    for (const [index, id] of [userId, memberId].entries()) {
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [id, `${id}@example.test`]
      )
      await pool.query(
        "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)",
        [randomUUID(), workspaceId, id, index ? "member" : "admin"]
      )
      const session = randomUUID()
      await pool.query(
        "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
        [session, id, workspaceId]
      )
      actors.push({
        userId: id,
        workspaceId,
        workspaceRole: "admin",
        scopes: null,
        authentication: { kind: "session", sessionId: session },
      })
    }
    await pool.query(
      "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1::uuid,$2,$1::text,$1::text,'SLA','workspace','emoji','🔥','#94a3b8','Europe/Paris',$3)",
      [teamId, workspaceId, userId]
    )
    vi.stubEnv(
      "FORGE_FEATURE_ROLLOUTS",
      JSON.stringify({
        sla: { mode: "enabled", workspaceIds: [...workspaces] },
      })
    )
    const f = {
      workspaceId,
      teamId,
      actor: actors[0],
      member: actors[1],
      rules,
    }
    await save(f, { enabled: true, workWeek: "mon-fri", rules })
    return f
  }
  const identity = (actor: Actor) => ({
    workspaceId: actor.workspaceId,
    sessionId:
      actor.authentication.kind === "session"
        ? actor.authentication.sessionId
        : "",
  })
  async function save(f: { actor: Actor }, values: SharedSlaPolicy) {
    const before = await policy.readSlaPolicy(f.actor, identity(f.actor))
    return policy.saveSlaPolicy(f.actor, {
      ...identity(f.actor),
      commandKey: randomUUID(),
      expectedRevision: before.revision,
      values,
    })
  }
  async function create(
    f: { actor: Actor; teamId: string },
    extra: Partial<ReturnType<typeof blankIssueDraft>> = {}
  ) {
    const result = await issues.createCanonicalIssue(f.actor, {
      teamId: f.teamId,
      commandKey: randomUUID(),
      draft: {
        ...blankIssueDraft("todo"),
        title: "SLA fixture",
        priority: "Urgent",
        ...extra,
      },
    })
    return result.value.issueId
  }
  async function edit(
    f: { actor: Actor; teamId: string },
    issueId: string,
    changes: IssueChanges
  ) {
    const row = (
      await pool.query("SELECT revision FROM issues WHERE id=$1", [issueId])
    ).rows[0]
    return editing.editCanonicalIssues(f.actor, {
      teamId: f.teamId,
      commandKey: randomUUID(),
      edits: [{ issueId, expectedRevision: row.revision, changes }],
    })
  }
  const generations = async (id: string) =>
    (
      await pool.query(
        "SELECT * FROM issue_slas WHERE issue_id=$1 ORDER BY generation",
        [id]
      )
    ).rows
  const breaches = async (id: string) =>
    (
      await pool.query(
        "SELECT * FROM issue_sla_events WHERE issue_id=$1 AND kind='breached'",
        [id]
      )
    ).rows
  async function overdueFixture(
    f: Awaited<ReturnType<typeof fixture>>,
    future = false
  ) {
    const issueId = randomUUID(),
      id = randomUUID(),
      rule = f.rules[0]
    // Trusted fixture construction uses the same persisted inputs as the trigger,
    // without a client clock override or changing production SQL functions.
    await pool.query(
      "INSERT INTO issues(id,workspace_id,team_id,number,title,status_id,properties) VALUES($1,$2,$3,$4,'Worker fixture','todo',$5)",
      [
        issueId,
        f.workspaceId,
        f.teamId,
        ++number,
        {
          ...blankIssueDraft("todo"),
          title: "Worker fixture",
          priority: "Urgent",
        },
      ]
    )
    await pool.query(
      `INSERT INTO issue_slas(id,workspace_id,issue_id,generation,rule_id,policy_revision,snapshot,anchor_at,deadline_at,high_risk_at,moderate_risk_at,gate_identity)
      VALUES($1,$2,$3,1,$4,1,$5,clock_timestamp()-interval '2 hours',clock_timestamp()+$6::interval,clock_timestamp()-interval '25 hours',clock_timestamp()-interval '8 days',$7)`,
      [
        id,
        f.workspaceId,
        issueId,
        rule.id,
        { rule, timezone: "Europe/Paris", workWeek: "mon-fri" },
        future ? "150 milliseconds" : "-1 hour",
        slaGate(f.workspaceId).identity,
      ]
    )
    await pool.query(
      "INSERT INTO issue_sla_windows(commitment_id) VALUES($1)",
      [id]
    )
    await pool.query(
      "INSERT INTO issue_sla_intents(commitment_id) VALUES($1)",
      [id]
    )
    return { issueId, id }
  }
  async function run(id: string) {
    const store = jobStore(pool)
    await dispatchSlaIntents(pool, store)
    const job = (
      await pool.query(
        "SELECT job_id FROM issue_sla_intents WHERE commitment_id=$1",
        [id]
      )
    ).rows[0].job_id
    await pool.query(
      "UPDATE background_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [job]
    )
    return {
      job,
      result: await runNextJob(store, SLA_JOB_KIND, slaBreachJob, job),
    }
  }
  it("AT-01a/b/c/d, AT-02b/c: real calendar arithmetic across work weeks, DST gaps and overlaps, independent of host timezone", async () => {
    for (const [anchor, count, unit, week, zone, expected] of [
      [
        "2027-03-26T08:00:00Z",
        1,
        "business-day",
        "mon-fri",
        "Europe/Paris",
        "2027-03-29T07:00:00.000Z",
      ],
      [
        "2027-03-26T08:00:00Z",
        24,
        "hour",
        "mon-fri",
        "Europe/Paris",
        "2027-03-27T08:00:00.000Z",
      ],
      [
        "2027-10-29T07:00:00Z",
        1,
        "business-day",
        "mon-fri",
        "Europe/Paris",
        "2027-11-01T08:00:00.000Z",
      ],
      [
        "2027-11-04T14:00:00Z",
        1,
        "business-day",
        "sun-thu",
        "UTC",
        "2027-11-07T14:00:00.000Z",
      ],
      [
        "2027-03-25T01:30:00Z",
        1,
        "business-day",
        "sun-thu",
        "Europe/Paris",
        "2027-03-28T01:30:00.000Z",
      ],
      [
        "2027-10-28T00:30:00Z",
        1,
        "business-day",
        "sun-thu",
        "Europe/Paris",
        "2027-10-31T00:30:00.000Z",
      ],
      [
        "2027-03-26T01:30:00Z",
        1,
        "business-day",
        "mon-fri",
        "Europe/Paris",
        "2027-03-29T00:30:00.000Z",
      ],
    ]) {
      const r = await pool.query(
        "SELECT forge_sla_shift($1::timestamptz,$2::int,$3,$4,$5) deadline",
        [anchor, count, unit, week, zone]
      )
      expect(r.rows[0].deadline.toISOString()).toBe(expected)
    }
  })
  it("AT-01/02a: live admin authority, canonical member issue creation, deadline/intent/history atomicity and exact policy replay", async () => {
    const f = await fixture()
    const input = {
      ...identity(f.actor),
      commandKey: randomUUID(),
      expectedRevision: 1,
      values: { enabled: true, workWeek: "mon-fri" as const, rules: f.rules },
    }
    await expect(
      policy.saveSlaPolicy(f.member, { ...input, ...identity(f.member) })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    const [first, second] = await Promise.all([
      policy.saveSlaPolicy(f.actor, input),
      policy.saveSlaPolicy(f.actor, input),
    ])
    expect(first.snapshot.revision).toBe(2)
    expect(second.snapshot.revision).toBe(2)
    expect(
      (
        await policy.saveSlaPolicy(f.actor, {
          ...input,
          commandKey: randomUUID(),
        })
      ).status
    ).toBe("conflict")
    const id = await create(
      { ...f, actor: f.member },
      { dueDate: "2027-02-01" }
    )
    const g = (await generations(id))[0]
    expect(
      new Date(g.deadline_at).getTime() - new Date(g.anchor_at).getTime()
    ).toBe(3600000)
    expect(
      (
        await pool.query(
          "SELECT properties->>'dueDate' due,revision FROM issues WHERE id=$1",
          [id]
        )
      ).rows[0]
    ).toEqual({ due: "", revision: 0 })
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issue_sla_intents WHERE commitment_id=$1",
          [g.id]
        )
      ).rows[0].n
    ).toBe(1)
    const page = await history.queryIssueHistory(f.member, { issueId: id })
    expect(
      page.entries.some(
        (e) =>
          e.topic === "issue.sla.applied" &&
          e.actor.kind === "system" &&
          e.changes.some((c) => c.field === "dueDate")
      )
    ).toBe(true)
  })
  it("AT-01e/i/j, AT-02g: ordered rules, frozen snapshots, no reset/pause, supersession and explicit date removal", async () => {
    const urgent = apply(),
      high = apply("High")
    const f = await fixture([
      urgent,
      high,
      {
        id: randomUUID(),
        enabled: true,
        action: "remove",
        filters: { priorities: ["Low"] },
      },
    ])
    const id = await create(f),
      original = (await generations(id))[0]
    await edit(f, id, { title: "No timer reset" })
    await save(f, {
      enabled: true,
      workWeek: "sun-thu",
      rules: [
        {
          ...urgent,
          action: "apply",
          duration: { unit: "hour", value: 3 },
          startMode: "issueCreation",
        },
        high,
      ],
    })
    await edit(f, id, { status: "in-progress" })
    expect((await generations(id))[0].deadline_at).toEqual(original.deadline_at)
    await edit(f, id, { priority: "High" })
    const next = await generations(id)
    expect(next).toHaveLength(2)
    expect(next[0].state).toBe("superseded")
    expect(next[1].rule_id).toBe(high.id)
    await edit(f, id, { dueDate: "2027-01-01" })
    expect((await generations(id)).at(-1)?.state).toBe("removed")
    expect(
      (
        await pool.query(
          "SELECT properties->>'dueDate' due FROM issues WHERE id=$1",
          [id]
        )
      ).rows[0].due
    ).toBe("2027-01-01")
  })
  it("AT-01g: concurrent claims, checkpoint replay and stale-worker fencing produce one breach", async () => {
    const f = await fixture(),
      g = await overdueFixture(f),
      store = jobStore(pool)
    await dispatchSlaIntents(pool, store)
    const job = (
      await pool.query(
        "SELECT job_id FROM issue_sla_intents WHERE commitment_id=$1",
        [g.id]
      )
    ).rows[0].job_id
    const leases = await Promise.all(
      Array.from({ length: 5 }, () => store.claim(SLA_JOB_KIND, job))
    )
    expect(leases.filter(Boolean)).toHaveLength(1)
    const old = leases.find(Boolean)!
    await slaBreachJob(store, old)
    await pool.query(
      "UPDATE background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [job]
    )
    await store.reap()
    await expect(slaBreachJob(store, old)).rejects.toMatchObject({
      code: "LEASE_LOST",
    })
    await run(g.id)
    expect(await breaches(g.issueId)).toHaveLength(1)
    expect(
      (
        await history.queryIssueHistory(f.actor, { issueId: g.issueId })
      ).entries.filter((e) => e.topic === "issue.sla.breached")
    ).toHaveLength(1)
  })
  it("AT-01j3: overdue obligation survives disable, cancellation, deferred workers and reenablement", async () => {
    const f = await fixture(),
      g = await overdueFixture(f)
    await save(f, { enabled: false, workWeek: "mon-fri", rules: f.rules })
    await edit(f, g.issueId, { status: "canceled" })
    const deferred = await run(g.id)
    expect(deferred.result.state).toBe("deferred")
    expect(await breaches(g.issueId)).toHaveLength(0)
    const job = (
      await pool.query("SELECT attempts FROM background_jobs WHERE id=$1", [
        deferred.job,
      ])
    ).rows[0]
    expect(job.attempts).toBe(0)
    await save(f, { enabled: true, workWeek: "mon-fri", rules: f.rules })
    expect((await run(g.id)).result.state).toBe("completed")
    expect(await breaches(g.issueId)).toHaveLength(1)
  })
  it("AT-01j4: crossing only while disabled creates no breach for a closed generation; retained open work breaches on reenablement", async () => {
    const f = await fixture(),
      closed = await overdueFixture(f, true),
      open = await overdueFixture(f, true)
    await save(f, { enabled: false, workWeek: "mon-fri", rules: f.rules })
    await new Promise((resolve) => setTimeout(resolve, 250))
    await edit(f, closed.issueId, { status: "canceled" })
    await save(f, { enabled: true, workWeek: "mon-fri", rules: f.rules })
    await run(closed.id)
    await run(open.id)
    expect(await breaches(closed.issueId)).toHaveLength(0)
    expect(await breaches(open.issueId)).toHaveLength(1)
  })
  it("AT-02e: unavailable feature keeps work recoverable and requires explicit reconciliation of unknown past availability", async () => {
    const f = await fixture(),
      g = await overdueFixture(f)
    vi.stubEnv("FORGE_FEATURE_ROLLOUTS", "{}")
    expect((await run(g.id)).result.state).toBe("deferred")
    expect(await breaches(g.issueId)).toHaveLength(0)
    vi.stubEnv(
      "FORGE_FEATURE_ROLLOUTS",
      JSON.stringify({ sla: { mode: "enabled", workspaceIds: workspaces } })
    )
    const pending = await policy.readSlaPolicy(f.actor, identity(f.actor))
    expect(pending.reconciliation.map((x) => x.id)).toContain(g.id)
    await policy.reconcileSlaGate(f.actor, {
      ...identity(f.actor),
      commandKey: randomUUID(),
      commitmentId: g.id,
      decision: "breach-owed",
      evidence: "Verified fixture release interval",
    })
    await run(g.id)
    expect(await breaches(g.issueId)).toHaveLength(1)
  })
  it("AT-01g: independent process death before and after the real breach checkpoint remains exactly once", async () => {
    const f = await fixture(),
      store = jobStore(pool)
    for (const phase of ["before-commit", "after-commit"]) {
      const g = await overdueFixture(f)
      await dispatchSlaIntents(pool, store)
      const job = (
        await pool.query(
          "SELECT job_id FROM issue_sla_intents WHERE commitment_id=$1",
          [g.id]
        )
      ).rows[0].job_id
      const child = spawn(
        "bun",
        ["scripts/sla-acceptance-worker.ts", job, phase],
        { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] }
      )
      let output = ""
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(new Error(`Worker never reached checkpoint: ${output}`)),
            15000
          )
          child.stdout.on("data", (data) => {
            output += data.toString()
            if (output.includes("ready")) {
              clearTimeout(timer)
              resolve()
            }
          })
          child.stderr.on("data", (data) => {
            output += data.toString()
          })
          child.once("exit", (code) => {
            clearTimeout(timer)
            reject(new Error(`Worker exited ${code}: ${output}`))
          })
        })
        const exited = once(child, "exit")
        child.kill("SIGKILL")
        await exited
      } finally {
        child.kill("SIGKILL")
      }
      expect(await breaches(g.issueId)).toHaveLength(
        phase === "before-commit" ? 0 : 1
      )
      await pool.query(
        "UPDATE background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [job]
      )
      await store.reap()
      await run(g.id)
      expect(await breaches(g.issueId)).toHaveLength(1)
      expect(
        (
          await pool.query("SELECT state FROM background_jobs WHERE id=$1", [
            job,
          ])
        ).rows[0].state
      ).toBe("completed")
    }
  }, 35000)
  it("AT-01f/k: creation anchor, recent and 30-day reopens keep the agreed duration and calendar", async () => {
    const f = await fixture([{ ...apply(), startMode: "issueCreation" }])
    const id = await create(f, { priority: "Low" })
    await pool.query(
      "UPDATE issues SET created_at=clock_timestamp()-interval '3 hours' WHERE id=$1",
      [id]
    )
    await edit(f, id, { priority: "Urgent" })
    const original = (await generations(id))[0]
    expect(new Date(original.deadline_at).getTime()).toBeLessThan(Date.now())
    expect(await breaches(id)).toHaveLength(1)
    await edit(f, id, { status: "done" })
    await pool.query(
      "UPDATE issue_slas SET completed_at=clock_timestamp()-interval '29 days' WHERE id=$1",
      [original.id]
    )
    await edit(f, id, { status: "todo" })
    expect(await generations(id)).toHaveLength(1)
    expect((await generations(id))[0].deadline_at).toEqual(original.deadline_at)
    await edit(f, id, { status: "done" })
    await pool.query(
      "UPDATE issue_slas SET completed_at=clock_timestamp()-interval '720 hours' WHERE id=$1",
      [original.id]
    )
    await edit(f, id, { status: "todo" })
    const next = (await generations(id))[1]
    expect(next.snapshot).toEqual(original.snapshot)
    expect(
      new Date(next.deadline_at).getTime() - new Date(next.anchor_at).getTime()
    ).toBe(3600000)
    expect(new Date(next.anchor_at).getTime()).toBeGreaterThan(
      Date.now() - 5000
    )
  })
  it("AT-01j/j2: late lifecycle transitions settle owed breaches once; suspension and restore preserve deadlines", async () => {
    const f = await fixture([
      apply(),
      {
        id: randomUUID(),
        enabled: true,
        action: "remove",
        filters: { priorities: ["Low"] },
      },
    ])
    for (const action of [
      "remove",
      "supersede",
      "cancel",
      "archive",
      "delete",
    ] as const) {
      const g = await overdueFixture(f)
      if (action === "remove") await edit(f, g.issueId, { priority: "Low" })
      else if (action === "supersede") {
        await save(f, {
          enabled: true,
          workWeek: "mon-fri",
          rules: [apply("High"), ...f.rules],
        })
        await edit(f, g.issueId, { priority: "High" })
      } else if (action === "cancel")
        await edit(f, g.issueId, { status: "canceled" })
      else {
        await lifecycle.changeIssueLifecycle(f.actor, {
          commandKey: randomUUID(),
          teamId: f.teamId,
          issueId: g.issueId,
          expectedRevision: 0,
          action,
        })
        const before = (await generations(g.issueId))[0]
        expect(
          (
            await pool.query(
              "SELECT count(*)::int n FROM issue_sla_windows WHERE commitment_id=$1 AND closed_at IS NULL",
              [g.id]
            )
          ).rows[0].n
        ).toBe(0)
        await lifecycle.changeIssueLifecycle(f.actor, {
          commandKey: randomUUID(),
          teamId: f.teamId,
          issueId: g.issueId,
          expectedRevision: 1,
          action: action === "archive" ? "unarchive" : "restore",
        })
        expect((await generations(g.issueId))[0].deadline_at).toEqual(
          before.deadline_at
        )
      }
      await run(g.id)
      expect(await breaches(g.issueId)).toHaveLength(1)
    }
    const notDue = await create(f)
    await edit(f, notDue, { priority: "Low" })
    const removed = (await generations(notDue))[0]
    await run(removed.id)
    expect(await breaches(notDue)).toHaveLength(0)
  })
  it("AT-02a/d: revoked admin, tenant references and malformed values fail without receipts or policy effects", async () => {
    const f = await fixture(),
      foreign = await fixture()
    const before = await policy.readSlaPolicy(f.actor, identity(f.actor))
    const command = {
      ...identity(f.actor),
      commandKey: randomUUID(),
      expectedRevision: before.revision,
      values: {
        ...before.values,
        rules: [{ ...apply(), filters: { teamIds: [foreign.teamId] } }],
      },
    }
    await expect(policy.saveSlaPolicy(f.actor, command)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    for (const value of [0, -1, 1.5, 8761])
      await expect(
        policy.saveSlaPolicy(f.actor, {
          ...command,
          values: {
            ...before.values,
            rules: [{ ...apply(), duration: { unit: "hour", value } }],
          },
        })
      ).rejects.toThrow()
    await pool.query(
      "UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, f.actor.userId]
    )
    await expect(
      policy.saveSlaPolicy(f.actor, { ...command, values: before.values })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE workspace_id=$1 AND command_key=$2",
          [f.workspaceId, command.commandKey]
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT revision FROM sla_policies WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].revision
    ).toBe(before.revision)
    await expect(
      pool.query(
        "SELECT forge_sla_shift(clock_timestamp(),1,'business-day','mon-fri','Invalid/Zone')"
      )
    ).rejects.toThrow()
  })
  it("AT-02b/e: team timezone edits freeze existing calendar; imported inserts wait for a qualifying edit; purging cascades SLA data", async () => {
    const f = await fixture(),
      id = await create(f)
    const original = (await generations(id))[0]
    await pool.query(
      "UPDATE teams SET timezone='Pacific/Auckland' WHERE id=$1",
      [f.teamId]
    )
    await edit(f, id, { title: "Calendar remains frozen" })
    expect((await generations(id))[0].snapshot).toEqual(original.snapshot)
    const imported = randomUUID()
    await pool.query(
      "INSERT INTO issues(id,workspace_id,team_id,number,title,status_id,legacy_id,properties) VALUES($1,$2,$3,$4,'Imported','todo',$5,$6)",
      [
        imported,
        f.workspaceId,
        f.teamId,
        ++number,
        randomUUID(),
        { ...blankIssueDraft("todo"), title: "Imported", priority: "Urgent" },
      ]
    )
    expect(await generations(imported)).toHaveLength(0)
    await edit(f, imported, { priority: "High" })
    await edit(f, imported, { priority: "Urgent" })
    expect((await generations(imported))[0].snapshot.timezone).toBe(
      "Pacific/Auckland"
    )
    await pool.query(
      "UPDATE issues SET purged_at=clock_timestamp() WHERE id=$1",
      [imported]
    )
    expect(await generations(imported)).toHaveLength(0)
  })
  it("AT-01/02: command failure rolls back the issue, SLA, intent and system history together", async () => {
    const f = await fixture()
    const { executeCommand } =
      await import("../commands/execute-command.server")
    const { sql } = await import("drizzle-orm")
    const id = randomUUID(),
      commandKey = randomUUID()
    await expect(
      executeCommand({
        actor: f.actor,
        commandKey,
        operation: "sla.fixture.rollback",
        input: {},
        status: 200,
        parse: (v) => v,
        authorize: async () => {},
        run: async (tx) => {
          await tx.execute(sql`INSERT INTO issues(id,workspace_id,team_id,number,title,status_id,properties)
          VALUES(${id}::uuid,${f.workspaceId},${f.teamId}::uuid,${++number},'Rollback fixture','todo',${JSON.stringify({ ...blankIssueDraft("todo"), title: "Rollback fixture", priority: "Urgent" })}::jsonb)`)
          throw new Error("Intentional post-trigger command failure")
        },
      })
    ).rejects.toThrow("Intentional post-trigger")
    expect(
      (await pool.query("SELECT count(*)::int n FROM issues WHERE id=$1", [id]))
        .rows[0].n
    ).toBe(0)
    expect(await generations(id)).toHaveLength(0)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issue_sla_events WHERE issue_id=$1",
          [id]
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE command_key=$1",
          [commandKey]
        )
      ).rows[0].n
    ).toBe(0)
  })
  it("AT-01e: first match, AND filters, snapshot risk, and concurrent qualifying edits never double-apply", async () => {
    const first = apply("Urgent", { unit: "hour", value: 500 }),
      second = apply()
    const f = await fixture([first, second])
    const id = await create(f)
    expect((await generations(id))[0].rule_id).toBe(first.id)
    expect(
      (
        await pool.query("SELECT forge_sla_snapshot($1)->>'status' status", [
          id,
        ])
      ).rows[0].status
    ).toBe("low-risk")
    await save(f, {
      enabled: true,
      workWeek: "mon-fri",
      rules: [second, first],
    })
    expect((await generations(await create(f)))[0].rule_id).toBe(second.id)
    const unmatched = await create(f, { priority: "Low" })
    const commands = Array.from({ length: 2 }, () =>
      editing.editCanonicalIssues(f.actor, {
        teamId: f.teamId,
        commandKey: randomUUID(),
        edits: [
          {
            issueId: unmatched,
            expectedRevision: 0,
            changes: { priority: "Urgent" },
          },
        ],
      })
    )
    const results = await Promise.all(commands)
    expect(results.filter((r) => r.status === "conflict")).toHaveLength(1)
    expect(await generations(unmatched)).toHaveLength(1)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issue_sla_events WHERE issue_id=$1 AND kind='applied'",
          [unmatched]
        )
      ).rows[0].n
    ).toBe(1)
  })
  it("AT-01h: PostgreSQL microsecond precision at the exact completion boundary", async () => {
    const f = await fixture(),
      g = await overdueFixture(f)
    await pool.query(
      "UPDATE issue_slas SET state='completed',completed_at=deadline_at-interval '1 microsecond' WHERE id=$1",
      [g.id]
    )
    expect(
      (
        await pool.query("SELECT forge_sla_snapshot($1)->>'status' status", [
          g.issueId,
        ])
      ).rows[0].status
    ).toBe("achieved")
    await pool.query(
      "UPDATE issue_slas SET completed_at=deadline_at WHERE id=$1",
      [g.id]
    )
    expect(
      (
        await pool.query("SELECT forge_sla_snapshot($1)->>'status' status", [
          g.issueId,
        ])
      ).rows[0].status
    ).toBe("failed")
  })
})

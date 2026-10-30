// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import type { IssueRelationshipKind } from "@/lib/issue-relationship-contract"
import type { IssueChanges } from "@/lib/canonical-issue-edit-contract"
import type * as QueryService from "./query-issues.server"
import type * as Editing from "./edit-issues.server"
import type { Actor } from "@/application/actor"
import type * as Service from "./issues.server"
import type * as ProductService from "../product-state/product-state.server"
import type * as Database from "@/db"
import { blankIssueDraft } from "@/lib/issue-record-contract"

const autoAssignmentFile =
  process.env.FORGE_ISSUE_LIFECYCLE_TEST_DATABASE_FILE ??
  process.env.FORGE_ISSUE_RELATIONSHIP_TEST_DATABASE_FILE ??
  process.env.FORGE_ISSUE_QUERY_TEST_DATABASE_FILE ??
  process.env.FORGE_AUTO_ASSIGNMENT_TEST_DATABASE_FILE
const file = autoAssignmentFile ?? process.env.FORGE_ISSUE_TEST_DATABASE_FILE

describe.skipIf(!file)("FOR-41 real PostgreSQL acceptance", () => {
  const marker = `for41-${randomUUID()}`
  const users = [`${marker}-admin`, `${marker}-member`]
  const workspaces: Array<string> = []
  const credentials: Array<string> = []
  let queryIssues: typeof QueryService.queryCanonicalIssues
  let editing: typeof Editing
  let pool: Pool,
    service: typeof Service,
    product: typeof ProductService,
    database: typeof Database
  async function fixture(plan = "free") {
    const workspaceId = `${marker}-${workspaces.length}`,
      teamId = randomUUID(),
      secondTeam = randomUUID()
    workspaces.push(workspaceId)
    await pool.query(
      "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
      [workspaceId]
    )
    if (plan !== "free")
      await pool.query(
        "INSERT INTO workspace_entitlements(workspace_id,plan,status,source) VALUES($1,$2,'active','internal')",
        [workspaceId, plan]
      )
    const actors: Array<Actor> = []
    for (const [i, userId] of users.entries()) {
      await pool.query(
        "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)",
        [randomUUID(), workspaceId, userId, i === 0 ? "admin" : "member"]
      )
      const sessionId = randomUUID()
      await pool.query(
        "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
        [sessionId, userId, workspaceId]
      )
      actors.push({
        userId,
        workspaceId,
        workspaceRole: "owner",
        authentication: { kind: "session", sessionId },
        scopes: null,
      })
    }
    for (const id of [teamId, secondTeam])
      await pool.query(
        "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,$3,$3,$4,'workspace','emoji','🔥','#94a3b8','Europe/Paris',$5)",
        [id, workspaceId, id, id.slice(0, 5).toUpperCase(), users[0]]
      )
    return { workspaceId, teamId, secondTeam, actors }
  }
  const draft = (title = "Shared acceptance issue") => ({
    ...blankIssueDraft("todo"),
    title,
  })
  const command = (teamId: string, title?: string) => ({
    teamId,
    commandKey: randomUUID(),
    draft: draft(title),
  })
  async function seed(
    workspaceId: string,
    teamId: string,
    count: number,
    archived = 0
  ) {
    await pool.query(
      "INSERT INTO issues(workspace_id,team_id,number,title,archived_at) SELECT $1,$2,n,'Fixture '||n,CASE WHEN n>$3 THEN now() ELSE NULL END FROM generate_series(1,$3::int+$4::int) n",
      [workspaceId, teamId, count, archived]
    )
  }
  beforeAll(async () => {
    const { connection, applicationConnection } = JSON.parse(
      readFileSync(file!, "utf8")
    )
    const environment = autoAssignmentFile
      ? "auto-assignment-acceptance"
      : "issue-creation-acceptance"
    const target = { environment, ...DATABASE_TARGETS[environment] } as const
    assertMigrationTarget(connection, target)
    assertMigrationTarget(
      applicationConnection.replace("-pooler.", "."),
      target
    )
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: connection, max: 8 })
    const identity = (
      await pool.query(
        "SELECT current_database() db,current_setting('neon.branch_id',true) branch"
      )
    ).rows[0]
    expect(identity).toEqual({ db: target.database, branch: target.branchId })
    vi.stubEnv("DATABASE_URL", applicationConnection)
    vi.stubEnv("FORGE_SERVICE_ENVIRONMENT", "development")
    vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", "true")
    database = await import("@/db")
    service = await import("./issues.server")
    queryIssues = (await import("./query-issues.server")).queryCanonicalIssues
    editing = await import("./edit-issues.server")
    product = await import("../product-state/product-state.server")
    for (const userId of users)
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [userId, `${userId}@example.test`]
      )
  }, 30000)
  beforeEach(async () => {
    await pool.query("DELETE FROM account_preferences WHERE user_id=ANY($1)", [
      users,
    ])
  })
  async function preference(
    userId: string,
    value: unknown = true,
    version = 1
  ) {
    await pool.query(
      "INSERT INTO account_preferences(user_id,version,values) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET version=EXCLUDED.version,values=EXCLUDED.values",
      [userId, version, { "general.autoAssignToSelf": value }]
    )
  }
  async function credentialActor(
    f: Awaited<ReturnType<typeof fixture>>,
    kind: "session" | "apiKey" | "agent"
  ): Promise<Actor> {
    const owner = f.actors[1]
    if (kind === "session") return owner
    if (kind === "apiKey") {
      const id = randomUUID()
      credentials.push(id)
      await pool.query(
        "INSERT INTO apikey(id,config_id,reference_id,key,permissions,metadata) VALUES($1,'forge-api',$2,$1,$3,$4)",
        [
          id,
          owner.userId,
          JSON.stringify({ issues: ["read", "write"] }),
          JSON.stringify({ workspaceId: f.workspaceId }),
        ]
      )
      return {
        ...owner,
        authentication: { kind, credentialId: id },
        scopes: ["issues:read", "issues:write"],
      }
    }
    const threadId = randomUUID(),
      runId = randomUUID()
    await pool.query(
      "INSERT INTO agent_threads(id,workspace_id,created_by_user_id) VALUES($1,$2,$3)",
      [threadId, f.workspaceId, owner.userId]
    )
    await pool.query(
      "INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'running','forge-native','{}')",
      [runId, threadId, owner.userId]
    )
    return {
      ...owner,
      authentication: { kind, runId, tokenId: randomUUID() },
      scopes: ["issues:read", "issues:write"],
    }
  }
  const assignment = (actor: Actor) => [
    {
      author: actor.userId,
      field: "assignee",
      to: actor.userId,
      text: `assigned to ${actor.userId}`,
    },
  ]
  afterAll(async () => {
    if (pool) {
      await pool.query(
        "DROP TRIGGER IF EXISTS for41_reject_audit ON command_audit_events"
      )
      await pool.query("DROP FUNCTION IF EXISTS for41_reject_audit()")
      await pool.query("DELETE FROM apikey WHERE id=ANY($1)", [credentials])
      for (const id of workspaces)
        await pool.query("DELETE FROM organization WHERE id=$1", [id])
      for (const id of users)
        await pool.query('DELETE FROM "user" WHERE id=$1', [id])
      expect(
        (
          await pool.query(
            `SELECT
        (SELECT count(*)::int FROM "user" WHERE id=ANY($1)) users,
        (SELECT count(*)::int FROM organization WHERE id=ANY($2)) workspaces,
        (SELECT count(*)::int FROM issues WHERE workspace_id=ANY($2)) issues,
        (SELECT count(*)::int FROM account_preferences WHERE user_id=ANY($1)) preferences,
        (SELECT count(*)::int FROM command_receipts WHERE workspace_id=ANY($2)) receipts,
        (SELECT count(*)::int FROM command_audit_events WHERE workspace_id=ANY($2)) audit,
        (SELECT count(*)::int FROM command_outbox_events WHERE workspace_id=ANY($2)) outbox`,
            [users, workspaces]
          )
        ).rows[0]
      ).toEqual({
        users: 0,
        workspaces: 0,
        issues: 0,
        preferences: 0,
        receipts: 0,
        audit: 0,
        outbox: 0,
      })
      await pool.end()
    }
    await database?.databaseClient.end()
    vi.unstubAllEnvs()
  }, 30000)
  it("AC-01: independent users reload the identical canonical UUID and team number", async () => {
    const f = await fixture(),
      created = await service.createCanonicalIssue(
        f.actors[0],
        command(f.teamId)
      )
    const other = await service.readCanonicalIssues(f.actors[1])
    expect(other.records.map((r) => r.issue)).toEqual([created.issue])
    expect(created.issue.number).toBe(1)
  })
  it("AC-02: racing distinct creates allocate unique numbers, replay creates one receipt/event", async () => {
    const f = await fixture(),
      input = command(f.teamId)
    const results = await Promise.all([
      service.createCanonicalIssue(f.actors[0], input),
      service.createCanonicalIssue(f.actors[0], input),
      service.createCanonicalIssue(f.actors[1], command(f.teamId)),
    ])
    expect(results[0].issue.id).toBe(results[1].issue.id)
    expect(new Set(results.map((r) => r.issue.number)).size).toBe(2)
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
          "SELECT count(*)::int n FROM command_receipts WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(2)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_outbox_events WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(2)
  }, 30000)
  it("AC-03: cross-team concurrent writers at 249 stop at 250, archived rows excluded, winner replays", async () => {
    const f = await fixture()
    await seed(f.workspaceId, f.teamId, 249, 7)
    const a = command(f.teamId),
      b = command(f.secondTeam)
    const results = await Promise.allSettled([
      service.createCanonicalIssue(f.actors[0], a),
      service.createCanonicalIssue(f.actors[1], b),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const index = results.findIndex((r) => r.status === "fulfilled")
    const replay = await service.createCanonicalIssue(
      f.actors[index],
      index === 0 ? a : b
    )
    expect(replay.replayed).toBe(true)
    const counts = (
      await pool.query(
        "SELECT count(*) FILTER(WHERE archived_at IS NULL)::int active,count(*)::int total FROM issues WHERE workspace_id=$1",
        [f.workspaceId]
      )
    ).rows[0]
    expect(counts).toEqual({ active: 250, total: 257 })
    for (const table of [
      "command_receipts",
      "command_audit_events",
      "command_outbox_events",
    ])
      expect(
        (
          await pool.query(
            `SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1`,
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(1)
  }, 30000)
  it("rejects a forged client plan and permits a trusted paid entitlement beyond 250", async () => {
    const f = await fixture("business")
    await seed(f.workspaceId, f.teamId, 251)
    expect(
      (await service.createCanonicalIssue(f.actors[0], command(f.teamId))).issue
        .number
    ).toBe(252)
    await expect(
      service.createCanonicalIssue(f.actors[0], {
        ...command(f.teamId),
        plan: "plus",
      } as never)
    ).rejects.toThrow()
  }, 30000)
  it("rolls back a parent, child, imported project, receipt, audit and event together at capacity", async () => {
    const f = await fixture()
    await seed(f.workspaceId, f.teamId, 249)
    const project = {
      id: randomUUID(),
      name: "Atomic project",
      status: "Backlog" as const,
      teamIds: [f.teamId],
      health: "On track" as const,
    }
    await expect(
      service.createCanonicalIssue(f.actors[0], {
        ...command(f.teamId),
        draft: { ...draft(), project: project.id, subIssues: ["Child"] },
        projectImport: project,
      })
    ).rejects.toThrow()
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(249)
    for (const table of [
      "projects",
      "command_receipts",
      "command_audit_events",
      "command_outbox_events",
    ])
      expect(
        (
          await pool.query(
            `SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1`,
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(0)
  }, 30000)
  it("applies server auto-assignment only to omitted assignment and preserves explicit null", async () => {
    const f = await fixture()
    await pool.query(
      "INSERT INTO account_preferences(user_id,version,values) VALUES($1,1,$2) ON CONFLICT(user_id) DO UPDATE SET values=EXCLUDED.values",
      [users[0], { "general.autoAssignToSelf": true }]
    )
    const input = command(f.teamId),
      first = await service.createCanonicalIssue(f.actors[0], input)
    expect(first.issue.assignee).toBe(users[0])
    expect(first.issue.activity).toMatchObject(assignment(f.actors[0]))
    expect(
      (
        await service.createCanonicalIssue(f.actors[0], {
          ...command(f.teamId),
          assigneeId: null,
        })
      ).issue.assignee
    ).toBe("")
    expect(
      (
        await service.createCanonicalIssue(f.actors[0], {
          ...command(f.teamId),
          assigneeId: users[1],
        })
      ).issue.assignee
    ).toBe(users[1])
    await pool.query(
      "UPDATE account_preferences SET values='{}' WHERE user_id=$1",
      [users[0]]
    )
    expect(
      (await service.createCanonicalIssue(f.actors[0], input)).issue.assignee
    ).toBe(users[0])
  }, 30000)
  it.each(["session", "apiKey", "agent"] as const)(
    "FOR-138 AT-01/03: %s uses its verified owner, commits child history once and replays after preference changes",
    async (kind) => {
      const f = await fixture(),
        actor = await credentialActor(f, kind)
      await preference(actor.userId)
      const input = {
        ...command(f.teamId),
        draft: { ...draft(), subIssues: ["Child"] },
      }
      const [first, retry] = await Promise.all([
        service.createCanonicalIssue(actor, input),
        service.createCanonicalIssue(actor, input),
      ])
      expect(first.value).toEqual(retry.value)
      for (const row of first.records) {
        expect(row.issue.assignee).toBe(actor.userId)
        expect(row.issue.creator).toBe(actor.userId)
        expect(row.issue.activity).toMatchObject(assignment(actor))
        expect(row.issue.activity).toHaveLength(1)
      }
      await preference(actor.userId, false)
      const replay = await service.createCanonicalIssue(actor, input)
      expect(replay.replayed).toBe(true)
      expect(replay.records).toEqual(first.records)
      const counts = (
        await pool.query(
          "SELECT (SELECT count(*)::int FROM issues WHERE workspace_id=$1) issues,(SELECT count(*)::int FROM command_receipts WHERE workspace_id=$1) receipts,(SELECT count(*)::int FROM command_audit_events WHERE workspace_id=$1 AND actor_user_id=$2) audit,(SELECT count(*)::int FROM command_outbox_events WHERE workspace_id=$1) outbox",
          [f.workspaceId, actor.userId]
        )
      ).rows[0]
      expect(counts).toEqual({ issues: 2, receipts: 1, audit: 1, outbox: 2 })
      expect(
        (await service.createCanonicalIssue(actor, command(f.teamId))).issue
          .assignee
      ).toBe("")
    },
    30000
  )
  it.each(["session", "apiKey", "agent"] as const)(
    "FOR-138 AT-02: %s preserves explicit null, draft-unassigned and explicit other owner",
    async (kind) => {
      const f = await fixture(),
        actor = await credentialActor(f, kind)
      await preference(actor.userId)
      for (const patch of [
        { assigneeId: null },
        { draft: { ...draft(), assignee: "" } },
        { assigneeId: users[0] },
        { draft: { ...draft(), assignee: users[0] } },
        { assigneeId: null, draft: { ...draft(), assignee: users[0] } },
      ]) {
        const created = await service.createCanonicalIssue(actor, {
          ...command(f.teamId),
          ...patch,
        })
        const expected =
          "assigneeId" in patch
            ? (patch.assigneeId ?? "")
            : patch.draft.assignee
        expect(created.issue.assignee).toBe(expected)
        expect(created.issue.activity).toHaveLength(expected ? 1 : 0)
      }
    },
    30000
  )
  it.each([
    [false, 1],
    ["true", 1],
    [null, 1],
    [true, 2],
  ])(
    "FOR-138 AT-02: preference %s at version %s safely disables automation",
    async (value, version) => {
      const f = await fixture()
      await preference(users[0], value, version)
      const result = await service.createCanonicalIssue(
        f.actors[0],
        command(f.teamId)
      )
      expect(result.issue.assignee).toBe("")
      expect(result.issue.activity).toEqual([])
    },
    30000
  )
  it("FOR-138 AT-02: absent preference and disabled sync leave omitted assignment empty", async () => {
    const f = await fixture()
    expect(
      (await service.createCanonicalIssue(f.actors[0], command(f.teamId))).issue
        .assignee
    ).toBe("")
    await preference(users[0])
    vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", "false")
    try {
      const result = await service.createCanonicalIssue(f.actors[0], {
        ...command(f.teamId),
        draft: { ...draft(), subIssues: ["Child"] },
      })
      expect(
        result.records.every(
          (r) => !r.issue.assignee && r.issue.activity.length === 0
        )
      ).toBe(true)
      expect(
        (
          await service.createCanonicalIssue(f.actors[0], {
            ...command(f.teamId),
            assigneeId: users[1],
          })
        ).issue.assignee
      ).toBe(users[1])
    } finally {
      vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", "true")
    }
  }, 30000)
  it.each(["session", "apiKey", "agent"] as const)(
    "FOR-138 AT-03: %s loses private-team and workspace authority on fresh requests and replay",
    async (kind) => {
      const f = await fixture(),
        actor = await credentialActor(f, kind)
      await preference(actor.userId)
      await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
        f.teamId,
      ])
      await pool.query(
        "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member')",
        [randomUUID(), f.workspaceId, f.teamId, actor.userId]
      )
      const input = command(f.teamId)
      expect(
        (await service.createCanonicalIssue(actor, input)).issue.assignee
      ).toBe(actor.userId)
      await pool.query("DELETE FROM team_members WHERE team_id=$1", [f.teamId])
      await expect(
        service.createCanonicalIssue(actor, command(f.teamId))
      ).rejects.toThrow()
      await expect(service.createCanonicalIssue(actor, input)).rejects.toThrow()
      await pool.query("UPDATE teams SET visibility='workspace' WHERE id=$1", [
        f.teamId,
      ])
      await pool.query(
        "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
        [f.workspaceId, actor.userId]
      )
      await expect(service.createCanonicalIssue(actor, input)).rejects.toThrow()
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(1)
    },
    30000
  )
  it.each(["apiKey", "agent"] as const)(
    "FOR-138 AT-02/03: %s cannot forge an owner or bypass scopes/revocation",
    async (kind) => {
      const f = await fixture(),
        actor = await credentialActor(f, kind)
      await preference(users[0])
      await preference(actor.userId)
      await expect(
        service.createCanonicalIssue(
          { ...actor, userId: users[0] },
          command(f.teamId)
        )
      ).rejects.toThrow()
      await expect(
        service.createCanonicalIssue(
          { ...actor, scopes: ["issues:read"] },
          command(f.teamId)
        )
      ).rejects.toThrow()
      const input = command(f.teamId)
      await service.createCanonicalIssue(actor, input)
      if (actor.authentication.kind === "apiKey")
        await pool.query("UPDATE apikey SET enabled=false WHERE id=$1", [
          actor.authentication.credentialId,
        ])
      else if (actor.authentication.kind === "agent")
        await pool.query(
          "UPDATE agent_runs SET state='cancelled' WHERE id=$1",
          [actor.authentication.runId]
        )
      await expect(service.createCanonicalIssue(actor, input)).rejects.toThrow()
      await expect(
        service.createCanonicalIssue(actor, command(f.teamId))
      ).rejects.toThrow()
    },
    30000
  )
  it("FOR-138: adding a child during edit assigns only the new child with attributable history", async () => {
    const f = await fixture()
    const parent = await service.createCanonicalIssue(f.actors[0], {
      ...command(f.teamId),
      assigneeId: null,
    })
    await preference(users[0])
    const input = {
      commandKey: randomUUID(),
      teamId: f.teamId,
      edits: [
        {
          issueId: parent.issue.id,
          expectedRevision: 0,
          changes: { subIssues: ["New child"] },
        },
      ],
    }
    const edited = await editing.editCanonicalIssues(f.actors[0], input)
    expect(edited.status).toBe("saved")
    const records = (await service.readCanonicalIssues(f.actors[0])).records
    expect(
      records.find((r) => r.issue.id === parent.issue.id)!.issue.assignee
    ).toBe("")
    const child = records.find(
      (r) => r.issue.parentId === parent.issue.id
    )!.issue
    expect(child.assignee).toBe(users[0])
    expect(child.activity).toMatchObject(assignment(f.actors[0]))
    expect(child.activity).toHaveLength(1)
    await editing.editCanonicalIssues(f.actors[0], input)
    expect((await service.readCanonicalIssues(f.actors[0])).records).toEqual(
      records
    )
  }, 30000)
  it("rejects changed-input command reuse, removed membership and private-team access", async () => {
    const f = await fixture(),
      input = command(f.teamId)
    await service.createCanonicalIssue(f.actors[1], input)
    await expect(
      service.createCanonicalIssue(f.actors[1], {
        ...input,
        draft: draft("Changed"),
      })
    ).rejects.toThrow(/different input/)
    await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
      f.teamId,
    ])
    await expect(
      service.createCanonicalIssue(f.actors[1], input)
    ).rejects.toThrow()
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, users[1]]
    )
    await expect(
      service.createCanonicalIssue(f.actors[1], input)
    ).rejects.toThrow()
  }, 30000)
  it("validates assignee, parent, status and label availability before committing", async () => {
    const f = await fixture()
    for (const patch of [
      { assigneeId: "missing" },
      { draft: { ...draft(), parentId: randomUUID() } },
      { draft: { ...draft(), status: "missing" } },
      { draft: { ...draft(), labels: "missing" } },
    ])
      await expect(
        service.createCanonicalIssue(f.actors[0], {
          ...command(f.teamId),
          ...patch,
        })
      ).rejects.toThrow()
    expect(
      (await service.readCanonicalIssues(f.actors[0])).records
    ).toHaveLength(0)
  }, 30000)
  it("imports project/cycle relations and deduplicates a legacy issue across actors", async () => {
    const f = await fixture(),
      project = {
        id: randomUUID(),
        name: "Imported",
        status: "Backlog" as const,
        teamIds: [f.teamId],
        health: "On track" as const,
      },
      legacyId = randomUUID()
    const input = {
      ...command(f.teamId),
      legacyId,
      draft: { ...draft(), project: project.id, cycle: "2026-10-26" },
      projectImport: project,
      cycleImport: { startDate: "2026-10-26", endDate: "2026-11-08" },
    }
    const [a, b] = await Promise.all([
      service.createCanonicalIssue(f.actors[0], input),
      service.createCanonicalIssue(f.actors[1], {
        ...input,
        commandKey: randomUUID(),
      }),
    ])
    expect(a.issue.id).toBe(b.issue.id)
    expect(a.issue.cycle).toBe("2026-10-26")
    expect(
      (await service.readCanonicalIssues(f.actors[1])).projects
    ).toHaveLength(1)
  }, 30000)
  it("never reuses an allocated team number after the last issue is deleted", async () => {
    const f = await fixture(),
      first = await service.createCanonicalIssue(f.actors[0], command(f.teamId))
    await pool.query("DELETE FROM issues WHERE id=$1", [first.issue.id])
    expect(
      (await service.createCanonicalIssue(f.actors[0], command(f.teamId))).issue
        .number
    ).toBe(2)
  }, 30000)
  it("retains server product state across sessions, rejects stale writes and isolates personal values", async () => {
    const f = await fixture(),
      actor = f.actors[0]
    const input = {
      workspaceId: f.workspaceId,
      sessionId:
        actor.authentication.kind === "session"
          ? actor.authentication.sessionId
          : "",
      commandKey: randomUUID(),
      key: "forge:desktop-tabs",
      value: "saved tabs",
      expectedRevision: 0,
    }
    await product.saveProductState(actor, input)
    expect((await product.readProductState(actor)).entries[0].value).toBe(
      "saved tabs"
    )
    expect((await product.readProductState(f.actors[1])).entries).toHaveLength(
      0
    )
    await expect(
      product.saveProductState(actor, {
        ...input,
        commandKey: randomUUID(),
        value: "stale",
      })
    ).rejects.toThrow(/changed in another session/)
    expect((await product.saveProductState(actor, input)).replayed).toBe(true)
  }, 30000)
  it("shares team configuration with live admin authority and denies member writes", async () => {
    const f = await fixture(),
      actor = f.actors[0]
    const input = {
      workspaceId: f.workspaceId,
      sessionId:
        actor.authentication.kind === "session"
          ? actor.authentication.sessionId
          : "",
      commandKey: randomUUID(),
      key: `forge:team-cycles:v1:${f.teamId}`,
      value: JSON.stringify({
        enabled: true,
        duration: 2,
        cooldown: 2,
        startDay: 1,
        futureCycles: 2,
        activeIssues: false,
        startedIssues: true,
        completedIssues: true,
      }),
      expectedRevision: 0,
    }
    await product.saveProductState(actor, input)
    expect((await product.readProductState(f.actors[1])).entries[0].value).toBe(
      input.value
    )
    await expect(
      product.saveProductState(f.actors[1], {
        ...input,
        sessionId:
          f.actors[1].authentication.kind === "session"
            ? f.actors[1].authentication.sessionId
            : "",
        commandKey: randomUUID(),
      })
    ).rejects.toThrow()
  }, 30000)
  it("denies direct SQL capacity bypass and frees a slot only when an issue is archived", async () => {
    const f = await fixture()
    await seed(f.workspaceId, f.teamId, 250)
    await expect(
      pool.query(
        "INSERT INTO issues(workspace_id,team_id,number,title) VALUES($1,$2,251,'Bypass')",
        [f.workspaceId, f.teamId]
      )
    ).rejects.toMatchObject({ constraint: "workspace_active_issue_limit" })
    await pool.query(
      "UPDATE issues SET archived_at=now() WHERE workspace_id=$1 AND number=1",
      [f.workspaceId]
    )
    expect(
      (await service.createCanonicalIssue(f.actors[0], command(f.teamId))).issue
        .number
    ).toBe(251)
  }, 30000)
  it("rolls back auto-assignment, child history and numbering when audit insertion fails", async () => {
    const f = await fixture()
    await preference(users[0])
    const input = {
      ...command(f.teamId),
      draft: { ...draft(), subIssues: ["Child"] },
    }
    await pool.query(
      "CREATE FUNCTION for41_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit failure'; END $$"
    )
    await pool.query(
      "CREATE TRIGGER for41_reject_audit BEFORE INSERT ON command_audit_events FOR EACH ROW EXECUTE FUNCTION for41_reject_audit()"
    )
    try {
      await expect(
        service.createCanonicalIssue(f.actors[0], input)
      ).rejects.toThrow()
    } finally {
      await pool.query(
        "DROP TRIGGER for41_reject_audit ON command_audit_events"
      )
      await pool.query("DROP FUNCTION for41_reject_audit()")
    }
    for (const table of [
      "issues",
      "command_receipts",
      "command_audit_events",
      "command_outbox_events",
    ])
      expect(
        (
          await pool.query(
            `SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1`,
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(0)
    const retry = await service.createCanonicalIssue(f.actors[0], input)
    expect(retry.issue.number).toBe(1)
    expect(retry.records).toHaveLength(2)
    for (const row of retry.records) {
      expect(row.issue.assignee).toBe(users[0])
      expect(row.issue.activity).toMatchObject(assignment(f.actors[0]))
      expect(row.issue.activity).toHaveLength(1)
    }
  }, 30000)
  it("preserves differing legacy issue/project versions as conflicts without overwriting shared data", async () => {
    const f = await fixture(),
      legacyId = randomUUID(),
      input = { ...command(f.teamId), legacyId }
    await service.createCanonicalIssue(f.actors[0], input)
    await expect(
      service.createCanonicalIssue(f.actors[1], {
        ...input,
        commandKey: randomUUID(),
        draft: draft("Different local version"),
      })
    ).rejects.toThrow(/different version/)
    const project = {
      id: randomUUID(),
      name: "Original project",
      status: "Backlog" as const,
      teamIds: [f.teamId],
      health: "On track" as const,
    }
    await service.importCanonicalProject(f.actors[0], {
      commandKey: randomUUID(),
      project,
    })
    await expect(
      service.importCanonicalProject(f.actors[1], {
        commandKey: randomUUID(),
        project: { ...project, name: "Different project" },
      })
    ).rejects.toThrow(/different version/)
    const state = await service.readCanonicalIssues(f.actors[1])
    expect(state.records[0].issue.title).toBe(input.draft.title)
    expect(state.projects[0].name).toBe("Original project")
  }, 30000)
  it("applies omitted-assignment automation to child issues while preserving an explicitly unassigned parent", async () => {
    const f = await fixture()
    await pool.query(
      "INSERT INTO account_preferences(user_id,version,values) VALUES($1,1,$2) ON CONFLICT(user_id) DO UPDATE SET values=EXCLUDED.values",
      [users[0], { "general.autoAssignToSelf": true }]
    )
    try {
      const result = await service.createCanonicalIssue(f.actors[0], {
        ...command(f.teamId),
        assigneeId: null,
        draft: { ...draft(), subIssues: ["Child"] },
      })
      expect(result.issue.assignee).toBe("")
      const child = result.records.find(
        (r) => r.issue.parentId === result.issue.id
      )!.issue
      expect(child.assignee).toBe(users[0])
      expect(child.creator).toBe(users[0])
      expect(child.activity).toMatchObject(assignment(f.actors[0]))
      expect(child.activity).toHaveLength(1)
    } finally {
      await pool.query(
        "UPDATE account_preferences SET values='{}' WHERE user_id=$1",
        [users[0]]
      )
    }
  }, 30000)
  it("FOR-42 AC-01: returns the newest authorized version on conflict and applies only explicitly rebased fields", async () => {
    const f = await fixture(),
      created = await service.createCanonicalIssue(
        f.actors[0],
        command(f.teamId)
      ),
      id = created.issue.id
    const first = {
      commandKey: randomUUID(),
      teamId: f.teamId,
      edits: [
        {
          issueId: id,
          expectedRevision: 0,
          changes: { title: "First writer", priority: "High" as const },
        },
      ],
    }
    const saved = await editing.editCanonicalIssues(f.actors[0], first)
    expect(saved.status).toBe("saved")
    expect(saved.records[0].issue.revision).toBe(1)
    const stale = {
      commandKey: randomUUID(),
      teamId: f.teamId,
      edits: [
        {
          issueId: id,
          expectedRevision: 0,
          changes: { description: "Second writer" },
        },
      ],
    }
    const conflict = await editing.editCanonicalIssues(f.actors[1], stale)
    expect(conflict.status).toBe("conflict")
    expect(conflict.records[0].issue.title).toBe("First writer")
    expect(conflict.records[0].issue.description).toBe("")
    const resolved = await editing.editCanonicalIssues(f.actors[1], {
      ...stale,
      commandKey: randomUUID(),
      edits: [{ ...stale.edits[0], expectedRevision: 1 }],
    })
    expect(resolved.status).toBe("saved")
    expect(resolved.records[0].issue).toMatchObject({
      revision: 2,
      title: "First writer",
      priority: "High",
      description: "Second writer",
    })
    expect(
      (await editing.editCanonicalIssues(f.actors[0], first)).replayed
    ).toBe(true)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE workspace_id=$1 AND operation='issues.edit@1'",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(2)
  }, 30000)
  it("FOR-42 AC-02: a stale bulk operation changes no items and returns current versions for every draft", async () => {
    const f = await fixture(),
      a = await service.createCanonicalIssue(
        f.actors[0],
        command(f.teamId, "A")
      ),
      b = await service.createCanonicalIssue(
        f.actors[0],
        command(f.teamId, "B")
      )
    await editing.editCanonicalIssues(f.actors[1], {
      teamId: f.teamId,
      commandKey: randomUUID(),
      edits: [
        {
          issueId: b.issue.id,
          expectedRevision: 0,
          changes: { priority: "High" },
        },
      ],
    })
    const result = await editing.editCanonicalIssues(f.actors[0], {
      teamId: f.teamId,
      commandKey: randomUUID(),
      edits: [a, b].map((r) => ({
        issueId: r.issue.id,
        expectedRevision: 0,
        changes: { status: "done" },
      })),
    })
    expect(result.status).toBe("conflict")
    expect(result.records).toHaveLength(2)
    expect(result.records.map((r) => r.issue.status)).toEqual(["todo", "todo"])
    expect(
      result.records.find((r) => r.issue.id === a.issue.id)!.issue.revision
    ).toBe(0)
  }, 30000)
  it("rolls back failed edit audit and safely replays the exact retry without extra activity or events", async () => {
    const f = await fixture(),
      created = await service.createCanonicalIssue(
        f.actors[0],
        command(f.teamId)
      )
    const input = {
      teamId: f.teamId,
      commandKey: randomUUID(),
      edits: [
        {
          issueId: created.issue.id,
          expectedRevision: 0,
          changes: { description: "Retry me" },
        },
      ],
    }
    await pool.query(
      "CREATE FUNCTION for41_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit failure'; END $$"
    )
    await pool.query(
      "CREATE TRIGGER for41_reject_audit BEFORE INSERT ON command_audit_events FOR EACH ROW EXECUTE FUNCTION for41_reject_audit()"
    )
    try {
      await expect(
        editing.editCanonicalIssues(f.actors[0], input)
      ).rejects.toThrow()
    } finally {
      await pool.query(
        "DROP TRIGGER for41_reject_audit ON command_audit_events"
      )
      await pool.query("DROP FUNCTION for41_reject_audit()")
    }
    expect(
      (await service.readCanonicalIssues(f.actors[0])).records[0].issue
    ).toMatchObject({ revision: 0, description: "" })
    const saved = await editing.editCanonicalIssues(f.actors[0], input),
      retry = await editing.editCanonicalIssues(f.actors[0], input)
    expect(saved.status).toBe("saved")
    expect(retry.replayed).toBe(true)
    expect(retry.records[0].issue.activity).toHaveLength(1)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_outbox_events WHERE workspace_id=$1 AND topic='issue.updated'",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(1)
  }, 30000)
  it("version checks observe direct/definition writes and cannot be spoofed by supplying revision", async () => {
    const f = await fixture(),
      created = await service.createCanonicalIssue(
        f.actors[0],
        command(f.teamId)
      )
    await pool.query(
      "UPDATE issues SET title='External authorized write',revision=0 WHERE id=$1",
      [created.issue.id]
    )
    const result = await editing.editCanonicalIssues(f.actors[1], {
      teamId: f.teamId,
      commandKey: randomUUID(),
      edits: [
        {
          issueId: created.issue.id,
          expectedRevision: 0,
          changes: { title: "Stale" },
        },
      ],
    })
    expect(result.status).toBe("conflict")
    expect(result.records[0].issue.revision).toBe(1)
  }, 30000)
  it("rolls back an edit and its new sub-issues together when child creation exceeds capacity", async () => {
    const f = await fixture()
    await seed(f.workspaceId, f.teamId, 249)
    const row = (await service.readCanonicalIssues(f.actors[0])).records[0]
      .issue
    await expect(
      editing.editCanonicalIssues(f.actors[0], {
        teamId: f.teamId,
        commandKey: randomUUID(),
        edits: [
          {
            issueId: row.id,
            expectedRevision: 0,
            changes: {
              title: "Must roll back",
              subIssues: ["Child A", "Child B"],
            },
          },
        ],
      })
    ).rejects.toThrow()
    expect(
      (await service.readCanonicalIssues(f.actors[0])).records[0].issue
    ).toMatchObject({ title: row.title, revision: 0 })
    expect(
      (
        await pool.query(
          "SELECT active_count FROM workspace_issue_capacity WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].active_count
    ).toBe(249)
  }, 30000)
  it("rechecks membership before replaying an edit receipt", async () => {
    const f = await fixture(),
      created = await service.createCanonicalIssue(
        f.actors[1],
        command(f.teamId)
      )
    const input = {
      teamId: f.teamId,
      commandKey: randomUUID(),
      edits: [
        {
          issueId: created.issue.id,
          expectedRevision: 0,
          changes: { priority: "Urgent" as const },
        },
      ],
    }
    await editing.editCanonicalIssues(f.actors[1], input)
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, users[1]]
    )
    await expect(
      editing.editCanonicalIssues(f.actors[1], input)
    ).rejects.toThrow()
  }, 30000)
  it("derives lifecycle timestamps for completion and reopening in the database", async () => {
    const f = await fixture(),
      created = await service.createCanonicalIssue(
        f.actors[0],
        command(f.teamId)
      )
    const saved = await editing.editCanonicalIssues(f.actors[0], {
      teamId: f.teamId,
      commandKey: randomUUID(),
      edits: [
        {
          issueId: created.issue.id,
          expectedRevision: 0,
          changes: { status: "done" },
        },
      ],
    })
    expect(saved.records[0].issue.completedAt).not.toBeNull()
    expect(saved.records[0].issue.statusChangedAt).not.toBe(
      created.issue.statusChangedAt
    )
    const reopened = await editing.editCanonicalIssues(f.actors[0], {
      teamId: f.teamId,
      commandKey: randomUUID(),
      edits: [
        {
          issueId: created.issue.id,
          expectedRevision: 1,
          changes: { status: "todo" },
        },
      ],
    })
    expect(reopened.records[0].issue.completedAt).toBeNull()
    expect(reopened.records[0].issue.statusChangedAt).not.toBe(
      saved.records[0].issue.statusChangedAt
    )
  }, 30000)
  it("omits private team and hidden project relationships from project responses", async () => {
    const f = await fixture(),
      hidden = randomUUID(),
      visible = randomUUID()
    await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
      f.secondTeam,
    ])
    await pool.query(
      "INSERT INTO projects(id,workspace_id,name,properties) VALUES($1,$3,'Visible',$4),($2,$3,'Hidden','{}')",
      [
        visible,
        hidden,
        f.workspaceId,
        JSON.stringify({
          teamIds: [f.teamId, f.secondTeam],
          dependencyIds: [hidden],
        }),
      ]
    )
    for (const [projectId, teamId] of [
      [visible, f.teamId],
      [visible, f.secondTeam],
      [hidden, f.secondTeam],
    ])
      await pool.query(
        "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
        [f.workspaceId, projectId, teamId]
      )
    const result = await service.readCanonicalIssues(f.actors[1])
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0].properties).toMatchObject({
      teamIds: [f.teamId],
      dependencyIds: [],
    })
    expect(JSON.stringify(result.projects)).not.toContain(f.secondTeam)
    expect(JSON.stringify(result.projects)).not.toContain(hidden)
  }, 30000)
  it("preserves NUL and malformed UTF16 in private server source copies", async () => {
    const f = await fixture(),
      actor = f.actors[0]
    if (actor.authentication.kind !== "session")
      throw new Error("Session required")
    const value = "raw\0\ud800text\udfff"
    await product.saveProductState(actor, {
      workspaceId: f.workspaceId,
      sessionId: actor.authentication.sessionId,
      commandKey: randomUUID(),
      key: "forge:desktop-tabs",
      value,
      expectedRevision: 0,
    })
    const snapshot = await product.readProductState(actor)
    expect(
      snapshot.entries.find((entry) => entry.key === "forge:desktop-tabs")
        ?.value
    ).toBe(value)
  }, 30000)
  describe("FOR-139 started assignment", () => {
    beforeEach(async () => {
      vi.stubEnv("FORGE_ASSIGN_STARTED_ISSUES_ENABLED", "true")
      await pool.query(
        "DELETE FROM account_preferences WHERE user_id=ANY($1)",
        [users]
      )
      await pool.query(
        `INSERT INTO account_preferences(user_id,values) VALUES($1,'{"general.assignStartedIssues":true}')`,
        [users[0]]
      )
    })
    afterEach(async () => {
      vi.stubEnv("FORGE_ASSIGN_STARTED_ISSUES_ENABLED", "false")
      vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", "true")
      await pool.query(
        "DELETE FROM account_preferences WHERE user_id=ANY($1)",
        [users]
      )
    })
    async function startInput(
      f: Awaited<ReturnType<typeof fixture>>,
      assignee?: string
    ) {
      const created = await service.createCanonicalIssue(f.actors[0], {
        ...command(f.teamId),
        assigneeId: assignee ?? null,
      })
      return {
        commandKey: randomUUID(),
        teamId: f.teamId,
        edits: [
          {
            issueId: created.issue.id,
            expectedRevision: 0,
            changes: { status: "in-progress" } as IssueChanges,
          },
        ],
      }
    }
    async function counts(workspace: string, key: string) {
      return (
        await pool.query(
          `SELECT
        (SELECT count(*)::int FROM command_receipts WHERE workspace_id=$1 AND command_key=$2) receipts,
        (SELECT count(*)::int FROM command_audit_events a JOIN command_receipts r ON a.command_id=r.id WHERE r.workspace_id=$1 AND r.command_key=$2) audit,
        (SELECT count(*)::int FROM command_outbox_events o JOIN command_receipts r ON o.command_id=r.id WHERE r.workspace_id=$1 AND r.command_key=$2) outbox`,
          [workspace, key]
        )
      ).rows[0]
    }
    it.each(["session", "apiKey", "agent"] as const)(
      "AT-01: %s atomically assigns once; replay ignores preference changes and rejects revoked authority",
      async (kind) => {
        const f = await fixture(),
          input = await startInput(f)
        let actor = f.actors[0]
        if (kind === "apiKey") {
          const id = randomUUID()
          credentials.push(id)
          await pool.query(
            "INSERT INTO apikey(id,config_id,reference_id,key,permissions,metadata) VALUES($1,'forge-api',$2,$3,$4,$5)",
            [
              id,
              users[0],
              randomUUID(),
              JSON.stringify({ issues: ["read", "write"] }),
              JSON.stringify({ workspaceId: f.workspaceId }),
            ]
          )
          actor = {
            ...actor,
            authentication: { kind, credentialId: id },
            scopes: ["issues:read", "issues:write"],
          }
        }
        if (kind === "agent") {
          const thread = randomUUID(),
            run = randomUUID()
          await pool.query(
            "INSERT INTO agent_threads(id,workspace_id,created_by_user_id) VALUES($1,$2,$3)",
            [thread, f.workspaceId, users[0]]
          )
          await pool.query(
            "INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,execution_kind,requested_selection,state) VALUES($1,$2,$3,'forge-native','{}','running')",
            [run, thread, users[0]]
          )
          actor = {
            ...actor,
            authentication: { kind, runId: run, tokenId: randomUUID() },
            scopes: ["issues:read", "issues:write"],
          }
        }
        const results = await Promise.all([
          editing.editCanonicalIssues(actor, input),
          editing.editCanonicalIssues(actor, input),
        ])
        expect(results.map((r) => r.replayed).sort()).toEqual([false, true])
        const issue = results[0].records[0].issue
        expect(issue).toMatchObject({
          status: "in-progress",
          assignee: users[0],
          revision: 1,
        })
        expect(issue.activity).toHaveLength(1)
        expect(issue.activity[0]).toMatchObject({
          author: users[0],
          field: "status",
          from: "todo",
          to: "in-progress",
          automaticAssignment: { from: "", to: users[0] },
        })
        expect(issue.activity[0].text).toContain("self-assigned")
        const row = (
          await pool.query(
            "SELECT assignee_id,properties FROM issues WHERE id=$1",
            [issue.id]
          )
        ).rows[0]
        expect(row.assignee_id).toBe(users[0])
        expect(row.properties.assignee).toBe(users[0])
        await pool.query(
          "UPDATE account_preferences SET values='{}' WHERE user_id=$1",
          [users[0]]
        )
        vi.stubEnv("FORGE_ASSIGN_STARTED_ISSUES_ENABLED", "false")
        expect((await editing.editCanonicalIssues(actor, input)).replayed).toBe(
          true
        )
        expect(await counts(f.workspaceId, input.commandKey)).toEqual({
          receipts: 1,
          audit: 1,
          outbox: 1,
        })
        if (actor.authentication.kind === "apiKey")
          await pool.query("UPDATE apikey SET enabled=false WHERE id=$1", [
            actor.authentication.credentialId,
          ])
        else if (actor.authentication.kind === "agent")
          await pool.query(
            "UPDATE agent_runs SET state='cancelled' WHERE id=$1",
            [actor.authentication.runId]
          )
        else
          await pool.query("DELETE FROM session WHERE id=$1", [
            actor.authentication.sessionId,
          ])
        await expect(
          editing.editCanonicalIssues(actor, input)
        ).rejects.toThrow()
      },
      30000
    )
    it.each([
      "existing",
      "explicit-other",
      "explicit-empty",
      "disabled",
      "missing",
      "invalid",
      "future",
      "gate-off",
      "sync-off",
      "non-start",
      "same-start",
      "between-started",
      "unrelated",
    ])(
      "AT-02: preserves assignment for %s",
      async (scenario) => {
        const f = await fixture(),
          input = await startInput(
            f,
            scenario === "existing" ? users[1] : undefined
          ),
          edit = input.edits[0]
        if (scenario === "explicit-other") edit.changes.assignee = users[1]
        if (scenario === "explicit-empty") edit.changes.assignee = ""
        if (scenario === "disabled")
          await pool.query(
            `UPDATE account_preferences SET values='{"general.assignStartedIssues":false,"general.autoAssignToSelf":true}' WHERE user_id=$1`,
            [users[0]]
          )
        if (scenario === "missing")
          await pool.query("DELETE FROM account_preferences WHERE user_id=$1", [
            users[0],
          ])
        if (scenario === "invalid")
          await pool.query(
            `UPDATE account_preferences SET values='{"general.assignStartedIssues":"true"}' WHERE user_id=$1`,
            [users[0]]
          )
        if (scenario === "future")
          await pool.query(
            "UPDATE account_preferences SET version=99 WHERE user_id=$1",
            [users[0]]
          )
        if (scenario === "gate-off")
          vi.stubEnv("FORGE_ASSIGN_STARTED_ISSUES_ENABLED", "false")
        if (scenario === "sync-off")
          vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", "false")
        if (scenario === "non-start") edit.changes.status = "done"
        if (scenario === "same-start" || scenario === "between-started") {
          await pool.query(
            "UPDATE issues SET status_id='in-progress' WHERE id=$1",
            [edit.issueId]
          )
          edit.expectedRevision = 1
          if (scenario === "between-started") edit.changes.status = "in-review"
        }
        if (scenario === "unrelated") edit.changes = { priority: "High" }
        const result = await editing.editCanonicalIssues(f.actors[0], input)
        expect(result.status).toBe("saved")
        expect(result.records[0].issue.assignee).toBe(
          ["existing", "explicit-other"].includes(scenario) ? users[1] : ""
        )
        expect(
          result.records[0].issue.activity.some((a) => a.automaticAssignment)
        ).toBe(false)
      },
      30000
    )
    it("integrates creation and started rules for an unowned parent and its new child", async () => {
      const f = await fixture(),
        input = await startInput(f)
      await pool.query(
        `UPDATE account_preferences SET values='{"general.assignStartedIssues":true,"general.autoAssignToSelf":true}' WHERE user_id=$1`,
        [users[0]]
      )
      input.edits[0].changes.subIssues = ["Independent new child"]
      const result = await editing.editCanonicalIssues(f.actors[0], input)
      expect(result.records).toHaveLength(2)
      const parent = result.records.find(
        (r) => r.issue.id === input.edits[0].issueId
      )!.issue
      const child = result.records.find(
        (r) => r.issue.parentId === parent.id
      )!.issue
      expect(parent).toMatchObject({
        status: "in-progress",
        assignee: users[0],
        revision: 1,
      })
      expect(parent.activity.filter((a) => a.automaticAssignment)).toHaveLength(
        1
      )
      expect(child).toMatchObject({
        status: "in-progress",
        assignee: users[0],
        revision: 0,
      })
      expect(child.activity).toHaveLength(1)
      expect(child.activity[0]).toMatchObject({
        author: users[0],
        field: "assignee",
        to: users[0],
      })
      expect(child.activity[0].automaticAssignment).toBeUndefined()
      expect(await counts(f.workspaceId, input.commandKey)).toEqual({
        receipts: 1,
        audit: 1,
        outbox: 2,
      })
    }, 30000)
    it.each(["scope", "private-team"])(
      "AT-02: opt-in never grants missing %s authority",
      async (reason) => {
        const f = await fixture(),
          input = await startInput(f)
        await pool.query(
          `INSERT INTO account_preferences(user_id,values) VALUES($1,'{"general.assignStartedIssues":true}')`,
          [users[1]]
        )
        const actor = {
          ...f.actors[1],
          scopes: reason === "scope" ? (["issues:read"] as const) : null,
        }
        if (reason === "private-team")
          await pool.query(
            "UPDATE teams SET visibility='private' WHERE id=$1",
            [f.teamId]
          )
        await expect(
          editing.editCanonicalIssues(actor, input)
        ).rejects.toThrow()
        expect(
          (await service.readCanonicalIssues(f.actors[0])).records[0].issue
        ).toMatchObject({ status: "todo", assignee: "", revision: 0 })
        expect(await counts(f.workspaceId, input.commandKey)).toEqual({
          receipts: 0,
          audit: 0,
          outbox: 0,
        })
      },
      30000
    )
    it("AT-01: uses custom canonical categories and the executing actor's own preference", async () => {
      const f = await fixture(),
        input = await startInput(f),
        { defaultDefinitionValue } =
          await import("@/lib/issue-definition-contract"),
        value = defaultDefinitionValue()
      const status = value.statuses.statuses.find(
        (s) => s.id === "in-progress"
      )!
      value.statuses.statuses.push({
        ...status,
        id: "custom-building",
        name: "Making progress",
      })
      const { saveIssueDefinitions } =
        await import("@/application/issue-definitions/definitions.server")
      const actor = f.actors[0]
      if (actor.authentication.kind !== "session")
        throw new Error("Session required")
      await saveIssueDefinitions(actor, {
        workspaceId: f.workspaceId,
        sessionId: actor.authentication.sessionId,
        teamId: f.teamId,
        commandKey: randomUUID(),
        expectedRevision: 0,
        value,
        statusReplacements: {},
        labelReplacements: {},
      })
      input.edits[0].expectedRevision =
        (await service.readCanonicalIssues(actor)).records[0].issue.revision ??
        0
      input.edits[0].changes.status = "custom-building"
      expect(
        (await editing.editCanonicalIssues(f.actors[1], input)).records[0].issue
          .assignee
      ).toBe("")
      const next = await startInput(f)
      next.edits[0].changes.status = "custom-building"
      const assigned = await editing.editCanonicalIssues(f.actors[0], next)
      expect(assigned.records[0].issue.assignee).toBe(users[0])
      expect(assigned.records[0].issue.activity[0].text).toContain(
        "Making progress"
      )
    }, 30000)
    it("AT-03: stale start cannot overwrite a competing assignee; rebase preserves the winner", async () => {
      const f = await fixture(),
        input = await startInput(f),
        id = input.edits[0].issueId
      await editing.editCanonicalIssues(f.actors[1], {
        teamId: f.teamId,
        commandKey: randomUUID(),
        edits: [
          { issueId: id, expectedRevision: 0, changes: { assignee: users[1] } },
        ],
      })
      const stale = await editing.editCanonicalIssues(f.actors[0], input)
      expect(stale.status).toBe("conflict")
      expect(stale.records[0].issue).toMatchObject({
        status: "todo",
        assignee: users[1],
        revision: 1,
      })
      expect(await counts(f.workspaceId, input.commandKey)).toEqual({
        receipts: 0,
        audit: 0,
        outbox: 0,
      })
      const saved = await editing.editCanonicalIssues(f.actors[0], {
        ...input,
        commandKey: randomUUID(),
        edits: [{ ...input.edits[0], expectedRevision: 1 }],
      })
      expect(saved.records[0].issue).toMatchObject({
        status: "in-progress",
        assignee: users[1],
        revision: 2,
      })
    }, 30000)
    it("AT-03: racing start and assignment have one winner and a conflict", async () => {
      const f = await fixture(),
        input = await startInput(f),
        id = input.edits[0].issueId
      const results = await Promise.all([
        editing.editCanonicalIssues(f.actors[0], input),
        editing.editCanonicalIssues(f.actors[1], {
          teamId: f.teamId,
          commandKey: randomUUID(),
          edits: [
            {
              issueId: id,
              expectedRevision: 0,
              changes: { assignee: users[1] },
            },
          ],
        }),
      ])
      expect(results.map((r) => r.status).sort()).toEqual(["conflict", "saved"])
      const current = (await service.readCanonicalIssues(f.actors[0]))
        .records[0].issue
      expect(current.revision).toBe(1)
      expect(current.assignee).toBe(
        results[0].status === "saved" ? users[0] : users[1]
      )
      expect(current.activity).toHaveLength(1)
    }, 30000)
    it("AT-01/03: bulk evaluates per issue and stale items roll the whole batch back", async () => {
      const f = await fixture(),
        a = await startInput(f),
        b = await startInput(f, users[1]),
        c = await startInput(f),
        input = { ...a, edits: [...a.edits, ...b.edits, ...c.edits] }
      input.edits[2].changes.assignee = ""
      const result = await editing.editCanonicalIssues(f.actors[0], input)
      expect(result.records.map((r) => r.issue.assignee)).toEqual([
        users[0],
        users[1],
        "",
      ])
      expect(await counts(f.workspaceId, input.commandKey)).toEqual({
        receipts: 1,
        audit: 1,
        outbox: 3,
      })
      const d = await startInput(f),
        e = await startInput(f)
      await pool.query("UPDATE issues SET assignee_id=$2 WHERE id=$1", [
        e.edits[0].issueId,
        users[1],
      ])
      const stale = { ...d, edits: [...d.edits, ...e.edits] }
      expect(
        (await editing.editCanonicalIssues(f.actors[0], stale)).status
      ).toBe("conflict")
      expect(
        (await service.readCanonicalIssues(f.actors[0])).records.find(
          (r) => r.issue.id === d.edits[0].issueId
        )!.issue
      ).toMatchObject({
        status: "todo",
        assignee: "",
        revision: 0,
        activity: [],
      })
      expect(await counts(f.workspaceId, stale.commandKey)).toEqual({
        receipts: 0,
        audit: 0,
        outbox: 0,
      })
    }, 30000)
    it("AT-01/03: audit failure rolls back status, assignment and history; retry commits once", async () => {
      const f = await fixture(),
        input = await startInput(f)
      await pool.query(
        `CREATE FUNCTION for139_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${f.workspaceId}' THEN RAISE EXCEPTION 'for139 audit failure'; END IF; RETURN NEW; END $$`
      )
      await pool.query(
        "CREATE TRIGGER for139_reject_audit BEFORE INSERT ON command_audit_events FOR EACH ROW EXECUTE FUNCTION for139_reject_audit()"
      )
      try {
        await expect(
          editing.editCanonicalIssues(f.actors[0], input)
        ).rejects.toThrow()
      } finally {
        await pool.query(
          "DROP TRIGGER for139_reject_audit ON command_audit_events"
        )
        await pool.query("DROP FUNCTION for139_reject_audit()")
      }
      expect(
        (await service.readCanonicalIssues(f.actors[0])).records[0].issue
      ).toMatchObject({
        status: "todo",
        assignee: "",
        revision: 0,
        activity: [],
      })
      expect(await counts(f.workspaceId, input.commandKey)).toEqual({
        receipts: 0,
        audit: 0,
        outbox: 0,
      })
      expect(
        (await editing.editCanonicalIssues(f.actors[0], input)).records[0].issue
          .assignee
      ).toBe(users[0])
      expect(
        (await editing.editCanonicalIssues(f.actors[0], input)).replayed
      ).toBe(true)
      expect(await counts(f.workspaceId, input.commandKey)).toEqual({
        receipts: 1,
        audit: 1,
        outbox: 1,
      })
    }, 30000)
  })
  describe("FOR-43 bounded authorized issue queries", () => {
    it("AT-01: stable pages and counts across a concurrent create, with an ID tie-breaker", async () => {
      const f = await fixture("enterprise")
      await seed(f.workspaceId, f.teamId, 121)
      const query = { teamIds: [f.teamId], limit: 25 } as const
      const first = await queryIssues(f.actors[1], {
        ...query,
        teamIds: [...query.teamIds],
      })
      expect(first.records).toHaveLength(25)
      expect(first.total).toBe(121)
      expect(first.facets.team).toEqual([{ value: f.teamId, count: 121 }])
      const created = await service.createCanonicalIssue(
        f.actors[0],
        command(f.secondTeam, "New after first page")
      )
      // Move fixture to the requested team with a free, unique number.
      await pool.query("UPDATE issues SET team_id=$1,number=122 WHERE id=$2", [
        f.teamId,
        created.issue.id,
      ])
      const ids = first.records.map((r) => r.issue.id)
      let cursor = first.nextCursor
      while (cursor) {
        const next = await queryIssues(f.actors[1], {
          ...query,
          teamIds: [...query.teamIds],
          cursor,
        })
        expect(next.total).toBe(121)
        ids.push(...next.records.map((r) => r.issue.id))
        cursor = next.nextCursor
      }
      expect(ids).toHaveLength(121)
      expect(new Set(ids).size).toBe(121)
      expect(ids).not.toContain(created.issue.id)
      expect(
        (await queryIssues(f.actors[1], { teamIds: [f.teamId] })).total
      ).toBe(122)
    }, 30000)
    it("AT-02: private matches disclose no titles, descriptions, identifiers, counts or facets", async () => {
      const f = await fixture()
      await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
        f.secondTeam,
      ])
      await service.createCanonicalIssue(
        f.actors[0],
        command(f.secondTeam, "Private secret needle")
      )
      const result = await queryIssues(f.actors[1], { search: "secret needle" })
      expect(result.records).toEqual([])
      expect(result.total).toBe(0)
      expect(result.groups).toEqual([])
      expect(
        Object.values(result.facets).every((rows) => rows.length === 0)
      ).toBe(true)
      expect(JSON.stringify(result)).not.toContain("Private secret")
      expect(JSON.stringify(result)).not.toContain(f.secondTeam)
      expect(
        (await queryIssues(f.actors[0], { search: "secret needle" })).total
      ).toBe(1)
    }, 30000)
    it("rechecks private membership on continuation and binds cursors to actor and filter", async () => {
      const f = await fixture()
      await seed(f.workspaceId, f.secondTeam, 4)
      await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
        f.secondTeam,
      ])
      await pool.query(
        "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
        [f.workspaceId, f.secondTeam, users[1]]
      )
      const first = await queryIssues(f.actors[1], { limit: 2 })
      expect(first.total).toBe(4)
      await expect(
        queryIssues(f.actors[0], { limit: 2, cursor: first.nextCursor! })
      ).rejects.toThrow("another query")
      await expect(
        queryIssues(f.actors[1], {
          limit: 2,
          search: "changed",
          cursor: first.nextCursor!,
        })
      ).rejects.toThrow("another query")
      await pool.query("DELETE FROM team_members WHERE team_id=$1", [
        f.secondTeam,
      ])
      const next = await queryIssues(f.actors[1], {
        limit: 2,
        cursor: first.nextCursor!,
      })
      expect(next.records).toEqual([])
      expect(next.total).toBe(0)
      expect(Object.values(next.facets).flat()).toEqual([])
    }, 30000)
    it("runs supported filters and literal search on the server, including authorized nested expansion", async () => {
      const f = await fixture()
      const parent = await service.createCanonicalIssue(f.actors[0], {
        ...command(f.teamId, "Literal 100%_needle"),
        draft: {
          ...draft("Literal 100%_needle"),
          priority: "High",
          description: "Search this bounded description",
          subIssues: ["Child that does not match"],
        },
      })
      const { defaultIssueDisplay } = await import("@/lib/issue-view-contract")
      const filters = {
        match: "all" as const,
        rules: [
          {
            id: "priority",
            field: "priority" as const,
            operator: "is" as const,
            value: "High",
          },
        ],
      }
      const result = await queryIssues(f.actors[1], {
        teamIds: [f.teamId],
        search: "100%_needle",
        filters,
      })
      expect(result.records.map((r) => r.issue.id)).toEqual([parent.issue.id])
      expect(
        (await queryIssues(f.actors[1], { search: "bounded description" }))
          .total
      ).toBe(1)
      const expanded = await queryIssues(f.actors[1], {
        search: "100%_needle",
        display: { ...defaultIssueDisplay(), nested: "Show all" },
      })
      expect(expanded.total).toBe(2)
      expect(
        (
          await queryIssues(f.actors[1], {
            search: "100%_needle",
            display: { ...defaultIssueDisplay(), showSubIssues: false },
          })
        ).total
      ).toBe(1)
      expect(
        (await queryIssues(f.actors[1], { personal: "created" })).total
      ).toBe(0)
      expect(
        (await queryIssues(f.actors[0], { personal: "created" })).total
      ).toBe(2)
      for (const order of [
        "Priority",
        "Created",
        "Updated",
        "Due date",
        "Title",
        "Status",
      ] as const) {
        for (const descending of [false, true]) {
          const q = {
            limit: 1,
            display: { ...defaultIssueDisplay(), order, descending },
          }
          const a = await queryIssues(f.actors[1], q)
          const b = await queryIssues(f.actors[1], {
            ...q,
            cursor: a.nextCursor!,
          })
          expect(a.records[0].issue.id).not.toBe(b.records[0].issue.id)
          expect(b.nextCursor).toBeNull()
        }
      }
    }, 30000)
    it("keeps board group totals consistent with team status names and canonical label order", async () => {
      const f = await fixture()
      await pool.query(
        "UPDATE issue_statuses SET name='Ready' WHERE team_id=$1 AND id='todo'",
        [f.teamId]
      )
      await pool.query(
        "INSERT INTO resource_labels(workspace_id,team_id,name) VALUES($1,$2,'Zebra'),($1,$2,'Alpha')",
        [f.workspaceId, f.teamId]
      )
      await service.createCanonicalIssue(f.actors[0], {
        ...command(f.teamId, "Labeled"),
        draft: { ...draft("Labeled"), labels: "Zebra,Alpha" },
      })
      await service.createCanonicalIssue(
        f.actors[0],
        command(f.secondTeam, "Other team")
      )
      const { defaultIssueDisplay } = await import("@/lib/issue-view-contract")
      const statuses = await queryIssues(f.actors[1], {})
      expect(statuses.groups.map((g) => g.group).sort()).toEqual([
        "Ready",
        "Todo",
      ])
      const labels = await queryIssues(f.actors[1], {
        teamIds: [f.teamId],
        display: { ...defaultIssueDisplay(), group: "Labels" },
      })
      expect(labels.records[0].issue.labels).toBe("Alpha,Zebra")
      expect(labels.groups).toEqual([
        { group: "Alpha", subgroup: "All issues", count: 1 },
      ])
    }, 30000)
    it("rejects oversized requests, malformed/expired cursors and revoked sessions", async () => {
      const f = await fixture()
      await seed(f.workspaceId, f.teamId, 3)
      await expect(queryIssues(f.actors[1], { limit: 101 })).rejects.toThrow()
      await expect(
        queryIssues(f.actors[1], { search: "x".repeat(201) })
      ).rejects.toThrow()
      await expect(
        queryIssues(f.actors[1], { cursor: "not-a-cursor" })
      ).rejects.toThrow()
      const first = await queryIssues(f.actors[1], { limit: 1 })
      const decoded = JSON.parse(
        Buffer.from(first.nextCursor!, "base64url").toString()
      )
      decoded.expires = 0
      await expect(
        queryIssues(f.actors[1], {
          limit: 1,
          cursor: Buffer.from(JSON.stringify(decoded)).toString("base64url"),
        })
      ).rejects.toThrow("expired")
      await pool.query("DELETE FROM session WHERE id=$1", [
        (f.actors[1].authentication as { sessionId: string }).sessionId,
      ])
      await expect(queryIssues(f.actors[1], {})).rejects.toThrow()
    }, 30000)
  })
  describe("FOR-44 canonical relationships", () => {
    async function relationInput(
      a: string,
      b: string,
      kind: IssueRelationshipKind = "blockedBy",
      action: "add" | "remove" = "add"
    ) {
      const rows = (
        await pool.query(
          "SELECT id,revision FROM issues WHERE id=ANY($1::uuid[])",
          [[a, b]]
        )
      ).rows
      return {
        commandKey: randomUUID(),
        issueId: a,
        targetId: b,
        expectedRevision: rows.find((r) => r.id === a).revision,
        expectedTargetRevision: rows.find((r) => r.id === b).revision,
        kind,
        action,
      }
    }
    async function pair(
      f: Awaited<ReturnType<typeof fixture>>,
      crossTeam = false
    ) {
      const a = await service.createCanonicalIssue(
        f.actors[0],
        command(f.teamId, "Issue A")
      )
      const b = await service.createCanonicalIssue(
        f.actors[0],
        command(crossTeam ? f.secondTeam : f.teamId, "Issue B")
      )
      return [a.issue.id, b.issue.id] as const
    }
    it("normalizes uppercase endpoint UUIDs before command identity and lookup", async () => {
      const f = await fixture(),
        [a, b] = await pair(f),
        r = await import("./issue-relationships.server")
      const input = await relationInput(a, b, "related")
      const result = await r.changeIssueRelationship(f.actors[0], {
        ...input,
        issueId: a.toUpperCase(),
        targetId: b.toUpperCase(),
      })
      expect(result.status).toBe("saved")
      expect(await r.changeIssueRelationship(f.actors[0], input)).toMatchObject(
        { status: "saved", replayed: true }
      )
    }, 30000)
    it("persists reciprocal cross-team blocking information and replays one audited command (AT-01)", async () => {
      const f = await fixture(),
        [a, b] = await pair(f, true),
        r = await import("./issue-relationships.server")
      const input = await relationInput(a, b)
      const saved = await r.changeIssueRelationship(f.actors[1], input)
      expect(saved.status).toBe("saved")
      expect(await r.changeIssueRelationship(f.actors[1], input)).toMatchObject(
        { status: "saved", replayed: true }
      )
      expect(
        (await r.readIssueRelationships(f.actors[1], { issueId: a }))
          .relationships
      ).toMatchObject([{ kind: "blockedBy", issue: { id: b } }])
      expect(
        (await r.readIssueRelationships(f.actors[0], { issueId: b }))
          .relationships
      ).toMatchObject([{ kind: "blocks", issue: { id: a } }])
      const receipt = (
        await pool.query(
          "SELECT id FROM command_receipts WHERE command_key=$1",
          [input.commandKey]
        )
      ).rows
      expect(receipt).toHaveLength(1)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM command_audit_events WHERE command_id=$1",
            [receipt[0].id]
          )
        ).rows[0].n
      ).toBe(1)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM command_outbox_events WHERE command_id=$1",
            [receipt[0].id]
          )
        ).rows[0].n
      ).toBe(2)
      await r.changeIssueRelationship(
        f.actors[0],
        await relationInput(b, a, "blocks", "remove")
      )
      expect(
        (await r.readIssueRelationships(f.actors[1], { issueId: a }))
          .relationships
      ).toEqual([])
      expect(
        (await r.readIssueRelationships(f.actors[1], { issueId: b }))
          .relationships
      ).toEqual([])
    }, 30000)
    it("keeps related links symmetric and idempotent from either endpoint", async () => {
      const f = await fixture(),
        [a, b] = await pair(f, true),
        r = await import("./issue-relationships.server")
      await r.changeIssueRelationship(
        f.actors[0],
        await relationInput(a, b, "related")
      )
      await r.changeIssueRelationship(
        f.actors[1],
        await relationInput(b, a, "related")
      )
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM issue_relations WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(1)
      expect(
        (await r.readIssueRelationships(f.actors[1], { issueId: b }))
          .relationships
      ).toMatchObject([{ kind: "related", issue: { id: a } }])
      await r.changeIssueRelationship(
        f.actors[1],
        await relationInput(b, a, "related", "remove")
      )
      expect(
        (await r.readIssueRelationships(f.actors[0], { issueId: a }))
          .relationships
      ).toEqual([])
    }, 30000)
    it("supports cross-team parents, sub-issues, reparenting and detachment", async () => {
      const f = await fixture(),
        [a, b] = await pair(f, true),
        r = await import("./issue-relationships.server")
      const c = (
        await service.createCanonicalIssue(
          f.actors[0],
          command(f.teamId, "New parent")
        )
      ).issue.id
      await r.changeIssueRelationship(
        f.actors[1],
        await relationInput(a, b, "parent")
      )
      expect(
        (await r.readIssueRelationships(f.actors[0], { issueId: b }))
          .relationships
      ).toMatchObject([{ kind: "child", issue: { id: a } }])
      const previous = (
        await r.readIssueRelationships(f.actors[0], { issueId: b })
      ).issue.revision
      await r.changeIssueRelationship(
        f.actors[0],
        await relationInput(c, a, "child")
      )
      expect(
        (await r.readIssueRelationships(f.actors[1], { issueId: b }))
          .relationships
      ).toEqual([])
      expect(
        (await r.readIssueRelationships(f.actors[0], { issueId: b })).issue
          .revision
      ).toBeGreaterThan(previous)
      await r.changeIssueRelationship(
        f.actors[1],
        await relationInput(a, c, "parent", "remove")
      )
      expect(
        (await r.readIssueRelationships(f.actors[0], { issueId: c }))
          .relationships
      ).toEqual([])
      const composed = await service.createCanonicalIssue(f.actors[1], {
        ...command(f.teamId, "Cross-team composer child"),
        draft: { ...draft("Cross-team composer child"), parentId: b },
      })
      expect(composed.issue.parentId).toBe(b)
      expect(
        (await r.readIssueRelationships(f.actors[1], { issueId: b }))
          .relationships
      ).toMatchObject([{ kind: "child", issue: { id: composed.issue.id } }])
    }, 30000)
    it("rejects ancestor cycles through relationship and canonical edit commands without corrupting records (AT-02)", async () => {
      const f = await fixture(),
        [a, b] = await pair(f),
        r = await import("./issue-relationships.server")
      await r.changeIssueRelationship(
        f.actors[0],
        await relationInput(a, b, "child")
      )
      const before = (
        await pool.query(
          "SELECT id,parent_id,revision,properties FROM issues WHERE workspace_id=$1 ORDER BY id",
          [f.workspaceId]
        )
      ).rows
      const input = await relationInput(a, b, "parent")
      expect(await r.changeIssueRelationship(f.actors[1], input)).toMatchObject(
        { status: "invalid", message: expect.stringContaining("cycle") }
      )
      expect(
        (
          await pool.query(
            "SELECT id,parent_id,revision,properties FROM issues WHERE workspace_id=$1 ORDER BY id",
            [f.workspaceId]
          )
        ).rows
      ).toEqual(before)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM command_receipts WHERE command_key=$1",
            [input.commandKey]
          )
        ).rows[0].n
      ).toBe(0)
      await expect(
        editing.editCanonicalIssues(f.actors[1], {
          commandKey: randomUUID(),
          teamId: f.teamId,
          edits: [
            {
              issueId: a,
              expectedRevision: input.expectedRevision,
              changes: { parentId: b, title: "Must roll back" },
            },
          ],
        })
      ).rejects.toThrow("relationship controls")
      expect(
        (await pool.query("SELECT title FROM issues WHERE id=$1", [a])).rows[0]
          .title
      ).toBe("Issue A")
    }, 30000)
    it("rejects transitive blocking cycles and direct SQL multi-row cycles atomically", async () => {
      const f = await fixture(),
        [a, b] = await pair(f),
        r = await import("./issue-relationships.server")
      const c = (
        await service.createCanonicalIssue(
          f.actors[0],
          command(f.teamId, "Issue C")
        )
      ).issue.id
      await r.changeIssueRelationship(
        f.actors[0],
        await relationInput(a, b, "blocks")
      )
      await r.changeIssueRelationship(
        f.actors[0],
        await relationInput(b, c, "blocks")
      )
      expect(
        await r.changeIssueRelationship(
          f.actors[1],
          await relationInput(c, a, "blocks")
        )
      ).toMatchObject({ status: "invalid" })
      await expect(
        pool.query(
          "INSERT INTO issue_relations(workspace_id,issue_id,related_issue_id,kind) VALUES($1,$2,$3,'blocks')",
          [f.workspaceId, c, a]
        )
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "issue_relations_blocks_acyclic",
      })
      await pool.query("DELETE FROM issue_relations WHERE workspace_id=$1", [
        f.workspaceId,
      ])
      await expect(
        pool.query(
          "INSERT INTO issue_relations(workspace_id,issue_id,related_issue_id,kind) VALUES($1,$2,$3,'blocks'),($1,$3,$4,'blocks'),($1,$4,$2,'blocks')",
          [f.workspaceId, a, b, c]
        )
      ).rejects.toMatchObject({ code: "23514" })
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM issue_relations WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(0)
    }, 30000)
    it("serializes opposite concurrent commands and returns an explicit conflict", async () => {
      const f = await fixture(),
        [a, b] = await pair(f),
        r = await import("./issue-relationships.server")
      const one = await relationInput(a, b, "blocks"),
        two = await relationInput(b, a, "blocks")
      const results = await Promise.all([
        r.changeIssueRelationship(f.actors[0], one),
        r.changeIssueRelationship(f.actors[1], two),
      ])
      expect(results.map((v) => v.status).sort()).toEqual(["conflict", "saved"])
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM issue_relations WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(1)
    }, 30000)
    it("fences stale repeatable-read snapshots during opposite direct SQL inserts", async () => {
      const f = await fixture(),
        [a, b] = await pair(f)
      const clients = await Promise.all([pool.connect(), pool.connect()])
      try {
        for (const client of clients) {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ")
          await client.query(
            "SELECT version FROM issue_hierarchy_guards WHERE workspace_id=$1",
            [f.workspaceId]
          )
        }
        const insert = async (i: number, from: string, to: string) => {
          try {
            await clients[i].query(
              "INSERT INTO issue_relations(workspace_id,issue_id,related_issue_id,kind) VALUES($1,$2,$3,'blocks')",
              [f.workspaceId, from, to]
            )
            await clients[i].query("COMMIT")
            return "saved"
          } catch (error) {
            await clients[i].query("ROLLBACK")
            return (error as { code: string }).code
          }
        }
        expect(
          (await Promise.all([insert(0, a, b), insert(1, b, a)])).sort()
        ).toEqual(["40001", "saved"])
      } finally {
        for (const client of clients) client.release()
      }
    }, 30000)
    it("rejects stale target revisions and requires an explicit new command to rebase", async () => {
      const f = await fixture(),
        [a, b] = await pair(f),
        r = await import("./issue-relationships.server")
      const input = await relationInput(a, b)
      await pool.query("UPDATE issues SET title='New B' WHERE id=$1", [b])
      const conflict = await r.changeIssueRelationship(f.actors[1], input)
      expect(conflict.status).toBe("conflict")
      expect(conflict.records?.find((v) => v.issue.id === b)?.issue.title).toBe(
        "New B"
      )
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM issue_relations WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(0)
      expect(
        (
          await r.changeIssueRelationship(
            f.actors[1],
            await relationInput(a, b)
          )
        ).status
      ).toBe("saved")
    }, 30000)
    it("rejects cross-tenant and revoked private-team references, including receipt replay", async () => {
      const f = await fixture(),
        other = await fixture(),
        [a, b] = await pair(f, true),
        r = await import("./issue-relationships.server")
      const foreign = (
        await service.createCanonicalIssue(
          other.actors[0],
          command(other.teamId)
        )
      ).issue.id
      await expect(
        r.changeIssueRelationship(f.actors[1], await relationInput(a, foreign))
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      const input = await relationInput(a, b, "parent")
      await r.changeIssueRelationship(f.actors[1], input)
      const visibleRevision = (
        await r.readIssueRelationships(f.actors[1], { issueId: a })
      ).resultRevision
      const searchRevision = (
        await r.searchRelationshipIssues(f.actors[1], {
          issueId: a,
          search: "Issue B",
        })
      ).resultRevision
      await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
        f.secondTeam,
      ])
      await expect(
        r.changeIssueRelationship(f.actors[1], input)
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        r.readIssueRelationships(f.actors[1], { issueId: b })
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect(
        (await r.readIssueRelationships(f.actors[1], { issueId: a }))
          .relationships
      ).toEqual([])
      expect(
        (await r.readIssueRelationships(f.actors[1], { issueId: a }))
          .resultRevision
      ).not.toBe(visibleRevision)
      expect(
        (
          await r.searchRelationshipIssues(f.actors[1], {
            issueId: a,
            search: "Issue B",
          })
        ).resultRevision
      ).not.toBe(searchRevision)
      const records = (await service.readCanonicalIssues(f.actors[1])).records
      const current = records.find((v) => v.issue.id === a)!.issue
      expect(current.parentId).toBe("")
      await editing.editCanonicalIssues(f.actors[1], {
        teamId: f.teamId,
        commandKey: randomUUID(),
        edits: [
          {
            issueId: a,
            expectedRevision: current.revision!,
            changes: { title: "Unrelated edit" },
          },
        ],
      })
      expect(
        (await pool.query("SELECT parent_id FROM issues WHERE id=$1", [a]))
          .rows[0].parent_id
      ).toBe(b)
      const latestRevision = (
        await pool.query("SELECT revision FROM issues WHERE id=$1", [a])
      ).rows[0].revision
      await expect(
        editing.editCanonicalIssues(f.actors[1], {
          teamId: f.teamId,
          commandKey: randomUUID(),
          edits: [
            {
              issueId: a,
              expectedRevision: latestRevision,
              changes: { parentId: "" },
            },
          ],
        })
      ).rejects.toThrow("relationship controls")
      expect(
        (
          await r.searchRelationshipIssues(f.actors[1], {
            issueId: a,
            search: "Issue B",
          })
        ).issues
      ).toEqual([])
    }, 30000)
    it("retains hidden relationships for restore and detaches on permanent deletion without deleting children", async () => {
      const f = await fixture(),
        [a, b] = await pair(f, true),
        r = await import("./issue-relationships.server")
      await r.changeIssueRelationship(
        f.actors[0],
        await relationInput(a, b, "parent")
      )
      await r.changeIssueRelationship(
        f.actors[0],
        await relationInput(a, b, "blockedBy")
      )
      await pool.query("UPDATE issues SET archived_at=now() WHERE id=$1", [b])
      expect(
        (await r.readIssueRelationships(f.actors[1], { issueId: a }))
          .relationships
      ).toEqual([])
      expect(
        (await service.readCanonicalIssues(f.actors[1])).records.find(
          (v) => v.issue.id === a
        )?.issue.parentId
      ).toBe("")
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM issue_relations WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(1)
      await pool.query("UPDATE issues SET archived_at=null WHERE id=$1", [b])
      expect(
        (
          await r.readIssueRelationships(f.actors[1], { issueId: a })
        ).relationships
          .map((v) => v.kind)
          .sort()
      ).toEqual(["blockedBy", "parent"])
      await pool.query("DELETE FROM issues WHERE id=$1", [b])
      expect(
        (await r.readIssueRelationships(f.actors[1], { issueId: a }))
          .relationships
      ).toEqual([])
      expect(
        (await pool.query("SELECT parent_id FROM issues WHERE id=$1", [a])).rows
      ).toEqual([{ parent_id: null }])
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM issue_relations WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(0)
    }, 30000)
    it("pages relationships and search independently of issue-list pages, filtering hidden rows first", async () => {
      const f = await fixture("enterprise"),
        r = await import("./issue-relationships.server")
      await seed(f.workspaceId, f.teamId, 65)
      const rows = (
        await pool.query(
          "SELECT id FROM issues WHERE workspace_id=$1 ORDER BY number",
          [f.workspaceId]
        )
      ).rows
      const a = rows[0].id
      await pool.query(
        "INSERT INTO issue_relations(workspace_id,issue_id,related_issue_id,kind) SELECT workspace_id,$1,id,'related' FROM issues WHERE workspace_id=$2 AND id<>$1",
        [a, f.workspaceId]
      )
      const first = await r.readIssueRelationships(f.actors[1], {
          issueId: a,
          limit: 50,
        }),
        second = await r.readIssueRelationships(f.actors[1], {
          issueId: a,
          limit: 50,
          cursor: first.nextCursor!,
        })
      expect(first.relationships).toHaveLength(50)
      expect(second.relationships).toHaveLength(14)
      expect(second.nextCursor).toBeNull()
      expect(
        new Set(
          [...first.relationships, ...second.relationships].map(
            (v) => v.issue.id
          )
        ).size
      ).toBe(64)
      const search = await r.searchRelationshipIssues(f.actors[1], {
          issueId: a,
        }),
        more = await r.searchRelationshipIssues(f.actors[1], {
          issueId: a,
          after: search.nextCursor!,
        })
      expect(search.issues).toHaveLength(20)
      expect(more.issues).toHaveLength(20)
      expect(
        (
          await r.searchRelationshipIssues(f.actors[1], {
            issueId: a,
            search: "Fixture 65",
          })
        ).issues
      ).toHaveLength(1)
      await expect(
        r.readIssueRelationships(f.actors[1], { issueId: a, limit: 101 })
      ).rejects.toThrow()
    }, 30000)
    it.each(["apiKey", "agent"] as const)(
      "uses the same relationship command for %s actors and checks scopes",
      async (kind) => {
        const f = await fixture(),
          [a, b] = await pair(f),
          r = await import("./issue-relationships.server"),
          actor = await credentialActor(f, kind)
        const input = await relationInput(a, b, "related")
        expect((await r.changeIssueRelationship(actor, input)).status).toBe(
          "saved"
        )
        await expect(
          r.changeIssueRelationship(
            { ...actor, scopes: ["issues:read"] },
            input
          )
        ).rejects.toMatchObject({ code: "FORBIDDEN" })
      },
      30000
    )
  })
  describe("FOR-45 lifecycle", () => {
    it("returns live availability when old lifecycle commands are replayed after another actor changes state", async () => {
      const f = await fixture(),
        id = (
          await service.createCanonicalIssue(f.actors[1], command(f.teamId))
        ).issue.id,
        l = await lifecycle()
      const deletion = {
        commandKey: randomUUID(),
        teamId: f.teamId,
        issueId: id,
        expectedRevision: await revision(id),
        action: "delete" as const,
      }
      await l.changeIssueLifecycle(f.actors[1], deletion)
      const restoration = {
        ...deletion,
        commandKey: randomUUID(),
        expectedRevision: await revision(id),
        action: "restore" as const,
      }
      await l.changeIssueLifecycle(f.actors[1], restoration)
      expect(await l.changeIssueLifecycle(f.actors[1], deletion)).toMatchObject(
        {
          replayed: true,
          value: { active: true, revision: await revision(id) },
        }
      )
      await change(f, id, "delete", f.actors[0])
      expect(
        await l.changeIssueLifecycle(f.actors[1], restoration)
      ).toMatchObject({
        replayed: true,
        value: { active: false, revision: await revision(id) },
      })
    }, 30000)
    it("suppresses mixed edit/recovery copies, preserves recoverable drafts, and checkpoints bounded purge cleanup", async () => {
      const f = await fixture(),
        a = (
          await service.createCanonicalIssue(
            f.actors[1],
            command(f.teamId, "Private source")
          )
        ).issue.id,
        b = (
          await service.createCanonicalIssue(
            f.actors[1],
            command(f.teamId, "Unrelated source")
          )
        ).issue.id
      const draftKey = `forge:team-issue-edit-drafts:v1:${f.teamId}:${randomUUID()}`
      const value = JSON.stringify({
        commandKey: randomUUID(),
        teamId: f.teamId,
        edits: [
          {
            issueId: a,
            expectedRevision: 0,
            changes: { description: "Hidden draft body" },
          },
          {
            issueId: b,
            expectedRevision: 0,
            changes: { title: "Keep live draft" },
          },
        ],
      })
      const wrapperKey = `forge:pending-recovery:v1:${randomUUID()}`,
        wrapper = JSON.stringify({
          key: draftKey,
          value,
          createdAt: new Date().toISOString(),
        })
      const save = async (key: string, raw: string, expectedRevision = 0) =>
        product.saveProductState(f.actors[1], {
          workspaceId: f.workspaceId,
          sessionId:
            f.actors[1].authentication.kind === "session"
              ? f.actors[1].authentication.sessionId
              : "",
          commandKey: randomUUID(),
          key,
          value: raw,
          expectedRevision,
        })
      await save(draftKey, value)
      await save(wrapperKey, wrapper)
      await change(f, a, "delete")
      let snapshot = await product.readProductState(f.actors[1])
      expect(JSON.stringify(snapshot.entries)).not.toContain(
        "Hidden draft body"
      )
      expect(JSON.stringify(snapshot.entries)).not.toContain("Keep live draft")
      const projected = snapshot.entries.find((row) => row.key === draftKey)!
      expect(projected.value).toBeNull()
      await save(draftKey, value, projected.revision)
      await expect(
        save(
          draftKey,
          JSON.stringify({
            ...JSON.parse(value),
            edits: JSON.parse(value).edits.slice(1),
          }),
          projected.revision + 1
        )
      ).rejects.toThrow("Restore or explicitly discard")
      await change(f, a, "restore")
      snapshot = await product.readProductState(f.actors[1])
      expect(
        snapshot.entries.find((row) => row.key === draftKey)?.value
      ).toContain("Hidden draft body")
      // New deletion gets an expired original clock without renewing an existing marker.
      await pool.query(
        "UPDATE issues SET deleted_at=clock_timestamp()-interval '721 hours' WHERE id=$1",
        [a]
      )
      for (let n = 0; n < 7; n++)
        await save(
          `forge:inbox:v1:${randomUUID()}`,
          JSON.stringify({ entries: [] })
        )
      await pool.query(
        "INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5)",
        [
          f.workspaceId,
          `user:${users[1]}`,
          users[1],
          `forge:inbox:v1:${randomUUID()}`,
          JSON.stringify("unrelated malformed legacy copy"),
        ]
      )
      const { purgeDeletedIssues } = await import("./purge-issues.server"),
        blobs = { delete: vi.fn().mockResolvedValue(undefined) }
      await purgeDeletedIssues(blobs)
      const checkpoint = (
        await pool.query(
          "SELECT purge_copy_cursor,purged_at FROM issues WHERE id=$1",
          [a]
        )
      ).rows[0]
      expect(checkpoint.purge_copy_cursor).not.toBeNull()
      expect(checkpoint.purged_at).toBeNull()
      for (let n = 0; n < 5; n++) await purgeDeletedIssues(blobs)
      expect(
        (await pool.query("SELECT purged_at FROM issues WHERE id=$1", [a]))
          .rows[0].purged_at
      ).not.toBeNull()
      expect(
        JSON.stringify(
          (
            await pool.query(
              "SELECT encoded_value FROM product_state WHERE workspace_id=$1",
              [f.workspaceId]
            )
          ).rows
        )
      ).not.toContain("Hidden draft body")
      const latest = (
        await pool.query(
          "SELECT revision FROM product_state WHERE workspace_id=$1 AND key=$2",
          [f.workspaceId, draftKey]
        )
      ).rows[0].revision
      await save(draftKey, value, latest)
      expect(
        JSON.stringify(
          (
            await pool.query(
              "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2",
              [f.workspaceId, draftKey]
            )
          ).rows
        )
      ).not.toContain("Hidden draft body")
    }, 30000)
    it("reconciles expired issue copies on isolated restore before releasing the target", async () => {
      const f = await fixture(),
        id = (
          await service.createCanonicalIssue(
            f.actors[1],
            command(f.teamId, "Expired restored body")
          )
        ).issue.id
      await pool.query(
        "UPDATE issues SET deleted_at=clock_timestamp()-interval '721 hours' WHERE id=$1",
        [id]
      )
      const { enforceRestoredDeadlines } =
        await import("../../../scripts/lib/recovery")
      const client = await pool.connect()
      try {
        await enforceRestoredDeadlines(client, {
          delete: vi.fn().mockResolvedValue(undefined),
          get: vi.fn().mockResolvedValue(null),
          put: vi.fn(),
        })
      } finally {
        client.release()
      }
      expect(
        (
          await pool.query(
            "SELECT title,properties,purged_at FROM issues WHERE id=$1",
            [id]
          )
        ).rows[0]
      ).toMatchObject({
        title: "",
        properties: {},
        purged_at: expect.any(Date),
      })
    }, 30000)
    it("fences internal file publication when issue deletion happens during byte upload", async () => {
      const f = await fixture(),
        id = (
          await service.createCanonicalIssue(f.actors[1], command(f.teamId))
        ).issue.id
      const { createForgeResourceFileService } =
        await import("@/adapters/files/forge-resource-file-service.server")
      let started!: () => void, release!: () => void
      const uploading = new Promise<void>((resolve) => {
          started = resolve
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve
        })
      const blobs = {
        put: vi.fn(async () => {
          started()
          await gate
        }),
        get: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
      }
      const creating = createForgeResourceFileService(blobs).create(
        f.actors[1],
        { kind: "issue", id },
        {
          name: "late.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("late bytes"),
        }
      )
      // Attach rejection handling before unblocking the upload.
      const outcome = creating.then(
        () => "saved",
        () => "rejected"
      )
      await uploading
      await change(f, id, "delete")
      release()
      expect(await outcome).toBe("rejected")
      expect(blobs.delete).toHaveBeenCalledOnce()
      expect(
        (
          await pool.query("SELECT id FROM resource_files WHERE issue_id=$1", [
            id,
          ])
        ).rowCount
      ).toBe(0)
    }, 30000)
    it("restoration and cross-team creation compete for the same last slot, with exact replay accounting", async () => {
      const f = await fixture()
      await seed(f.workspaceId, f.teamId, 250)
      const id = (
        await pool.query(
          "SELECT id FROM issues WHERE workspace_id=$1 LIMIT 1",
          [f.workspaceId]
        )
      ).rows[0].id
      await change(f, id, "delete")
      const l = await lifecycle(),
        input = {
          commandKey: randomUUID(),
          teamId: f.teamId,
          issueId: id,
          expectedRevision: await revision(id),
          action: "restore" as const,
        }
      const outcomes = await Promise.allSettled([
        l.changeIssueLifecycle(f.actors[1], input),
        service.createCanonicalIssue(f.actors[0], command(f.secondTeam)),
      ])
      expect(
        outcomes.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1)
      if (outcomes[0].status === "fulfilled")
        expect(await l.changeIssueLifecycle(f.actors[1], input)).toMatchObject({
          replayed: true,
        })
      expect(
        (
          await pool.query(
            "SELECT active_count FROM workspace_issue_capacity WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].active_count
      ).toBe(250)
      const archived = {
        commandKey: randomUUID(),
        teamId: f.teamId,
        issueId: (
          await pool.query(
            "SELECT id FROM issues WHERE workspace_id=$1 AND team_id=$2 AND deleted_at IS NULL LIMIT 1",
            [f.workspaceId, f.teamId]
          )
        ).rows[0].id,
        expectedRevision: 0,
        action: "archive" as const,
      }
      archived.expectedRevision = await revision(archived.issueId)
      await l.changeIssueLifecycle(f.actors[1], archived)
      expect(await l.changeIssueLifecycle(f.actors[1], archived)).toMatchObject(
        { replayed: true }
      )
      expect(
        (
          await pool.query(
            "SELECT active_count FROM workspace_issue_capacity WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].active_count
      ).toBe(249)
    }, 30000)
    const lifecycle = () => import("./issue-lifecycle.server")
    const revision = async (id: string) =>
      (await pool.query("SELECT revision FROM issues WHERE id=$1", [id]))
        .rows[0].revision as number
    async function change(
      f: Awaited<ReturnType<typeof fixture>>,
      id: string,
      action: "delete" | "restore" | "archive" | "unarchive",
      actor = f.actors[1]
    ) {
      return (await lifecycle()).changeIssueLifecycle(actor, {
        commandKey: randomUUID(),
        teamId: f.teamId,
        issueId: id,
        expectedRevision: await revision(id),
        action,
      })
    }
    it("AT-01: member delete/restore preserves comments and subscriptions, suppresses search, files and relationships", async () => {
      const f = await fixture(),
        id = (
          await service.createCanonicalIssue(
            f.actors[1],
            command(f.teamId, "Recoverable secret")
          )
        ).issue.id
      await pool.query(
        "UPDATE issues SET properties=properties || $2::jsonb WHERE id=$1",
        [
          id,
          JSON.stringify({
            subscribers: users.join(","),
            comments: [
              {
                id: randomUUID(),
                author: users[1],
                body: "Private comment",
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        ]
      )
      const child = (
        await service.createCanonicalIssue(f.actors[1], {
          ...command(f.teamId),
          draft: { ...draft("Surviving child"), parentId: id },
        })
      ).issue.id
      await pool.query(
        "INSERT INTO issue_relations(workspace_id,issue_id,related_issue_id,kind) VALUES($1,$2,$3,'related')",
        [f.workspaceId, id, child]
      )
      const fileId = randomUUID()
      await pool.query(
        "INSERT INTO resource_files(id,workspace_id,created_by_user_id,issue_id,name,content_type,size_bytes,checksum,storage_reference) VALUES($1,$2,$3,$4,'private.txt','text/plain',1,$5,$6)",
        [
          fileId,
          f.workspaceId,
          users[1],
          id,
          "a".repeat(64),
          `files/${randomUUID()}`,
        ]
      )
      const { lookupAuthorizedFile } =
          await import("@/adapters/files/file-delivery-lookup.server"),
        lookup = () =>
          lookupAuthorizedFile(f.actors[1], { kind: "resources", id: fileId })
      expect(await lookup()).not.toBeNull()
      const inboxKey = `forge:inbox:v1:${JSON.stringify([f.workspaceId, users[1]])}`
      const inboxValue = JSON.stringify({
        entries: [
          { id: `issue:${id}`, issue: { id, title: "Recoverable secret" } },
        ],
        unsubscribedIssueIds: [],
      })
      await pool.query(
        "INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5)",
        [
          f.workspaceId,
          `user:${users[1]}`,
          users[1],
          inboxKey,
          JSON.stringify(inboxValue),
        ]
      )
      const input = {
          commandKey: randomUUID(),
          teamId: f.teamId,
          issueId: id,
          expectedRevision: await revision(id),
          action: "delete" as const,
        },
        l = await lifecycle()
      expect((await l.changeIssueLifecycle(f.actors[1], input)).status).toBe(
        "saved"
      )
      expect(await l.changeIssueLifecycle(f.actors[1], input)).toMatchObject({
        status: "saved",
        replayed: true,
      })
      const { getPlanningResource } =
          await import("../planning/queries.server"),
        rel = await import("./issue-relationships.server")
      expect(await getPlanningResource(f.actors[1], "issue", id)).toBeNull()
      expect(await lookup()).toBeNull()
      expect(
        (await product.readProductState(f.actors[1])).entries.find(
          (e) => e.key === inboxKey
        )?.value
      ).not.toContain("Recoverable secret")
      expect(
        (await service.readCanonicalIssues(f.actors[1])).records.some(
          (r) => r.issue.id === id
        )
      ).toBe(false)
      expect(
        (await queryIssues(f.actors[1], { search: "Recoverable secret" }))
          .records
      ).toHaveLength(0)
      const { defaultIssueDisplay } = await import("@/lib/issue-view-contract")
      expect(
        (
          await queryIssues(f.actors[1], { personal: "subscribed" })
        ).records.map((r) => r.issue.id)
      ).not.toContain(id)
      expect(
        (
          await queryIssues(f.actors[1], {
            search: "Surviving child",
            display: { ...defaultIssueDisplay(), showSubIssues: false },
          })
        ).records.map((r) => r.issue.id)
      ).toContain(child)
      expect(
        (await rel.readIssueRelationships(f.actors[1], { issueId: child }))
          .relationships
      ).toHaveLength(0)
      expect(
        (
          await l.listInactiveIssues(f.actors[1], {
            teamId: f.teamId,
            kind: "deleted",
          })
        ).items[0]
      ).toMatchObject({ id, title: "Recoverable secret" })
      await change(f, id, "restore")
      const restored = (
        await service.readCanonicalIssues(f.actors[1])
      ).records.find((r) => r.issue.id === id)!.issue
      expect(restored.comments[0].body).toBe("Private comment")
      expect(restored.subscribers).toBe(users.join(","))
      expect(
        (await product.readProductState(f.actors[1])).entries.find(
          (e) => e.key === inboxKey
        )?.value
      ).toContain("Recoverable secret")
      expect(await lookup()).not.toBeNull()
      expect(
        (
          await rel.readIssueRelationships(f.actors[1], { issueId: child })
        ).relationships.map((r) => r.issue.id)
      ).toContain(id)
    }, 30000)
    it("AT-04: capacity rejection preserves records and create/unarchive atomically compete for one slot", async () => {
      const f = await fixture()
      await seed(f.workspaceId, f.teamId, 250, 1)
      const archived = (
        await pool.query(
          "SELECT id FROM issues WHERE workspace_id=$1 AND archived_at IS NOT NULL",
          [f.workspaceId]
        )
      ).rows[0].id
      await expect(change(f, archived, "unarchive")).rejects.toThrow(
        "250 active"
      )
      expect(
        (
          await pool.query("SELECT archived_at FROM issues WHERE id=$1", [
            archived,
          ])
        ).rows[0].archived_at
      ).not.toBeNull()
      const active = (
        await pool.query(
          "SELECT id FROM issues WHERE workspace_id=$1 AND archived_at IS NULL LIMIT 1",
          [f.workspaceId]
        )
      ).rows[0].id
      await change(f, active, "delete")
      await service.createCanonicalIssue(
        f.actors[1],
        command(f.secondTeam, "Fills slot")
      )
      await expect(change(f, active, "restore")).rejects.toThrow("250 active")
      expect(
        (
          await pool.query("SELECT deleted_at FROM issues WHERE id=$1", [
            active,
          ])
        ).rows[0].deleted_at
      ).not.toBeNull()
      await change(f, archived, "delete")
      await change(f, archived, "restore")
      const release = (
        await pool.query(
          "SELECT id FROM issues WHERE workspace_id=$1 AND team_id=$2 AND archived_at IS NULL AND deleted_at IS NULL LIMIT 1",
          [f.workspaceId, f.teamId]
        )
      ).rows[0].id
      await change(f, release, "archive")
      const l = await lifecycle(),
        input = {
          commandKey: randomUUID(),
          teamId: f.teamId,
          issueId: archived,
          expectedRevision: await revision(archived),
          action: "unarchive" as const,
        }
      const results = await Promise.allSettled([
        l.changeIssueLifecycle(f.actors[1], input),
        service.createCanonicalIssue(
          f.actors[0],
          command(f.secondTeam, "Competing create")
        ),
      ])
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      if (results[0].status === "fulfilled")
        expect(await l.changeIssueLifecycle(f.actors[1], input)).toMatchObject({
          replayed: true,
        })
      expect(
        (
          await pool.query(
            "SELECT active_count FROM workspace_issue_capacity WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].active_count
      ).toBe(250)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM issues WHERE workspace_id=$1 AND archived_at IS NULL AND deleted_at IS NULL",
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(250)
    }, 30000)
    it("rejects stale revisions, private-team access, missing scopes and revoked actors", async () => {
      const f = await fixture(),
        id = (
          await service.createCanonicalIssue(f.actors[1], command(f.teamId))
        ).issue.id,
        l = await lifecycle()
      const input = {
        commandKey: randomUUID(),
        teamId: f.teamId,
        issueId: id,
        expectedRevision: await revision(id),
        action: "delete" as const,
      }
      await pool.query(
        "UPDATE issues SET title='Concurrent update' WHERE id=$1",
        [id]
      )
      expect(await l.changeIssueLifecycle(f.actors[1], input)).toEqual({
        status: "conflict",
      })
      const api = await credentialActor(f, "apiKey")
      await expect(
        l.changeIssueLifecycle(
          { ...api, scopes: ["issues:read"] },
          { ...input, expectedRevision: await revision(id) }
        )
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
        f.teamId,
      ])
      await expect(change(f, id, "delete")).rejects.toMatchObject({
        code: "FORBIDDEN",
      })
      await pool.query("UPDATE teams SET visibility='workspace' WHERE id=$1", [
        f.teamId,
      ])
      await pool.query(
        "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
        [f.workspaceId, users[1]]
      )
      await expect(change(f, id, "delete")).rejects.toMatchObject({
        code: "FORBIDDEN",
      })
    }, 30000)
    it("refuses recovery at the exact SQL deadline even if the worker is late", async () => {
      const f = await fixture(),
        id = (
          await service.createCanonicalIssue(f.actors[1], command(f.teamId))
        ).issue.id
      await pool.query(
        "UPDATE issues SET deleted_at=clock_timestamp()-interval '30 days' WHERE id=$1",
        [id]
      )
      await expect(change(f, id, "restore")).rejects.toThrow("recovery period")
      expect(
        (
          await (
            await lifecycle()
          ).listInactiveIssues(f.actors[1], {
            teamId: f.teamId,
            kind: "deleted",
          })
        ).items
      ).toHaveLength(0)
      await expect(
        pool.query("UPDATE issues SET deleted_at=null WHERE id=$1", [id])
      ).rejects.toMatchObject({ constraint: "issue_recovery_expired" })
    }, 30000)
    it("AT-02: purge retries failed bytes before scrubbing private dependents; old links stay unavailable", async () => {
      const f = await fixture(),
        id = (
          await service.createCanonicalIssue(
            f.actors[1],
            command(f.teamId, "Private purge body")
          )
        ).issue.id
      const child = (
        await service.createCanonicalIssue(f.actors[1], {
          ...command(f.teamId),
          draft: { ...draft("Survivor"), parentId: id },
        })
      ).issue.id
      const doc = randomUUID(),
        shared = randomUUID(),
        fileId = randomUUID(),
        ref = `files/${randomUUID()}`
      await pool.query(
        "INSERT INTO documents(id,workspace_id,title,issue_id,shared_with_workspace,body) VALUES($1,$3,'Private',$4,false,'{}'),($2,$3,'Shared',$4,true,'{}')",
        [doc, shared, f.workspaceId, id]
      )
      await pool.query(
        "INSERT INTO resource_files(id,workspace_id,created_by_user_id,document_id,name,content_type,size_bytes,checksum,storage_reference) VALUES($1,$2,$3,$4,'secret.txt','text/plain',1,$5,$6)",
        [fileId, f.workspaceId, users[1], doc, "b".repeat(64), ref]
      )
      await pool.query(
        "INSERT INTO issue_relations(workspace_id,issue_id,related_issue_id,kind) VALUES($1,$2,$3,'related')",
        [f.workspaceId, id, child]
      )
      await pool.query(
        "UPDATE issues SET deleted_at=clock_timestamp()-interval '31 days' WHERE id=$1",
        [id]
      )
      const inboxKey = `forge:inbox:v1:${JSON.stringify([f.workspaceId, users[1]])}`
      const inboxValue = JSON.stringify({
        entries: [
          { id: `issue:${id}`, issue: { id, title: "Private purge body" } },
        ],
        unsubscribedIssueIds: [],
      })
      await pool.query(
        "INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5)",
        [
          f.workspaceId,
          `user:${users[1]}`,
          users[1],
          inboxKey,
          JSON.stringify(inboxValue),
        ]
      )
      const { purgeDeletedIssues } = await import("./purge-issues.server"),
        remove = vi.fn().mockRejectedValue(new Error("secret provider failure"))
      expect(
        (await purgeDeletedIssues({ delete: remove })).failed
      ).toBeGreaterThan(0)
      const stalled = (
        await pool.query(
          "SELECT purge_started_at,purged_at,purge_error FROM issues WHERE id=$1",
          [id]
        )
      ).rows[0]
      expect(stalled.purge_started_at).not.toBeNull()
      expect(stalled.purged_at).toBeNull()
      expect(stalled.purge_error).not.toContain("secret")
      await expect(change(f, id, "restore")).rejects.toThrow("recovery period")
      expect(
        (
          await pool.query("SELECT id FROM resource_files WHERE id=$1", [
            fileId,
          ])
        ).rowCount
      ).toBe(1)
      await pool.query("UPDATE issues SET purge_lease_until=null WHERE id=$1", [
        id,
      ])
      remove.mockResolvedValue(undefined)
      expect(
        (await purgeDeletedIssues({ delete: remove })).purged
      ).toBeGreaterThan(0)
      const purged = (
        await pool.query(
          "SELECT title,properties,purged_at FROM issues WHERE id=$1",
          [id]
        )
      ).rows[0]
      expect(purged.title).toBe("")
      expect(purged.properties).toEqual({})
      const snapshot = (
        await pool.query(
          "SELECT encoded_value,revision FROM product_state WHERE workspace_id=$1 AND key=$2",
          [f.workspaceId, inboxKey]
        )
      ).rows[0]
      expect(snapshot.encoded_value).not.toContain("Private purge body")
      await product.saveProductState(f.actors[1], {
        workspaceId: f.workspaceId,
        sessionId:
          f.actors[1].authentication.kind === "session"
            ? f.actors[1].authentication.sessionId
            : "",
        commandKey: randomUUID(),
        key: inboxKey,
        value: inboxValue,
        expectedRevision: snapshot.revision,
      })
      expect(
        (
          await pool.query(
            "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2",
            [f.workspaceId, inboxKey]
          )
        ).rows[0].encoded_value
      ).not.toContain("Private purge body")

      expect(purged.purged_at).not.toBeNull()
      expect(
        (await pool.query("SELECT id FROM documents WHERE id=$1", [doc]))
          .rowCount
      ).toBe(0)
      expect(
        (
          await pool.query("SELECT issue_id FROM documents WHERE id=$1", [
            shared,
          ])
        ).rows[0].issue_id
      ).toBe(id)
      expect(
        (await pool.query("SELECT parent_id FROM issues WHERE id=$1", [child]))
          .rows[0].parent_id
      ).toBeNull()
      expect(
        (
          await pool.query("SELECT id FROM resource_files WHERE id=$1", [
            fileId,
          ])
        ).rowCount
      ).toBe(0)
      expect(
        (
          await pool.query(
            "SELECT id FROM issue_relations WHERE issue_id=$1 OR related_issue_id=$1",
            [id]
          )
        ).rowCount
      ).toBe(0)
      const { getPlanningResource } = await import("../planning/queries.server")
      expect(await getPlanningResource(f.actors[1], "issue", id)).toBeNull()
      await expect(change(f, id, "restore")).rejects.toMatchObject({
        code: "FORBIDDEN",
      })
      expect((await purgeDeletedIssues({ delete: remove })).purged).toBe(0)
    }, 30000)
  })
})

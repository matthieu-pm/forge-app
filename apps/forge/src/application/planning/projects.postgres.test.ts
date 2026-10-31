// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import type { Actor } from "@/application/actor"
import type * as Projects from "./projects.server"
import type * as Issues from "../issues/issues.server"
import type * as Queries from "../issues/query-issues.server"
import { blankIssueDraft } from "@/lib/issue-record-contract"

const file = process.env.FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE
describe.skipIf(!file)("FOR-54 shared projects on PostgreSQL", () => {
  const marker = `for54-${randomUUID()}`,
    userIds = [`${marker}-alice`, `${marker}-bob`],
    workspaces: Array<string> = []
  let pool: Pool,
    projects: typeof Projects,
    issues: typeof Issues,
    queries: typeof Queries
  beforeAll(async () => {
    const { connection, applicationConnection } = JSON.parse(
      readFileSync(file!, "utf8")
    )
    const target = {
      environment: "issue-history-acceptance",
      ...DATABASE_TARGETS["issue-history-acceptance"],
    } as const
    assertMigrationTarget(connection, target)
    assertMigrationTarget(
      applicationConnection.replace("-pooler.", "."),
      target
    )
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: connection, max: 6 })
    expect(
      (
        await pool.query(
          "SELECT current_database() db,current_setting('neon.branch_id',true) branch"
        )
      ).rows[0]
    ).toEqual({ db: target.database, branch: target.branchId })
    vi.stubEnv("DATABASE_URL", applicationConnection)
    vi.stubEnv("FORGE_SERVICE_ENVIRONMENT", "development")
    projects = await import("./projects.server")
    issues = await import("../issues/issues.server")
    queries = await import("../issues/query-issues.server")
    for (const id of userIds)
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [id, `${id}@example.test`]
      )
  }, 30000)
  afterAll(async () => {
    if (!pool) return
    for (const workspace of workspaces) {
      await pool.query("DELETE FROM organization WHERE id=$1", [workspace])
    }
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [userIds])
    await pool.end()
    const { databaseClient } = await import("@/db")
    await databaseClient.end()
    vi.unstubAllEnvs()
  }, 30000)
  async function fixture() {
    const workspaceId = `${marker}-${workspaces.length}`,
      teamId = randomUUID(),
      privateTeam = randomUUID()
    workspaces.push(workspaceId)
    await pool.query(
      "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
      [workspaceId]
    )
    const actors: Array<Actor> = []
    for (const [index, userId] of userIds.entries()) {
      await pool.query(
        "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)",
        [randomUUID(), workspaceId, userId, index ? "member" : "admin"]
      )
      const sessionId = randomUUID()
      await pool.query(
        "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
        [sessionId, userId, workspaceId]
      )
      actors.push({
        workspaceId,
        userId,
        workspaceRole: index ? "member" : "admin",
        authentication: { kind: "session", sessionId },
        scopes: null,
      })
    }
    for (const id of [teamId, privateTeam])
      await pool.query(
        "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,$3,$3,$4,$5,'emoji','🔥','#94a3b8','Europe/Paris',$6)",
        [
          id,
          workspaceId,
          id,
          id.slice(0, 5).toUpperCase(),
          id === privateTeam ? "private" : "workspace",
          userIds[0],
        ]
      )
    return { workspaceId, teamId, privateTeam, actors }
  }
  const create = (
    id: string,
    teamIds: Array<string>,
    name = "Shared project"
  ) => [
    {
      id,
      expectedRevision: null,
      changes: {
        name,
        teamIds,
        status: "Planned",
        leadId: userIds[1],
        startDate: "2026-10",
        targetDate: "2026-Q4",
      },
    },
  ]
  const save = (actor: Actor, changes: unknown, key = randomUUID()) =>
    projects.saveCanonicalProjects(actor, key, changes)
  const project = async (actor: Actor, id: string) =>
    (await issues.readCanonicalIssues(actor, true)).projects.find(
      (p) => p.id === id
    )
  const link = (
    actor: Actor,
    teamId: string,
    projectId: string,
    title = "Visible work"
  ) =>
    issues.createCanonicalIssue(actor, {
      commandKey: randomUUID(),
      teamId,
      draft: { ...blankIssueDraft("todo"), title, project: projectId },
    })

  it("AT-01: member creation/editing and canonical issue membership agree for Alice and Bob", async () => {
    const f = await fixture(),
      id = randomUUID()
    await save(f.actors[1], create(id, [f.teamId]))
    const row = (await project(f.actors[0], id))!
    expect(row.properties).toMatchObject({
      status: "Planned",
      leadId: userIds[1],
      startDate: "2026-10",
      targetDate: "2026-Q4",
      creatorId: userIds[1],
      teamIds: [f.teamId],
    })
    const issue = await link(f.actors[0], f.teamId, id)
    const bob = await queries.queryCanonicalIssues(f.actors[1], { project: id })
    expect(bob.records.map((r) => r.issue.id)).toEqual([issue.issue.id])
    expect(bob.projectTotals).toEqual([{ project: id, count: 1, completed: 0 }])
    await save(f.actors[1], [
      {
        id,
        expectedRevision: row.revision,
        changes: { name: "Member edited", status: "Active" },
      },
    ])
    expect(await project(f.actors[0], id)).toMatchObject({
      name: "Member edited",
      properties: { status: "Active" },
    })
  }, 30000)
  it("AT-02: shared metadata preserves hidden teams while issues, counts and denied links reveal no private work", async () => {
    const f = await fixture(),
      id = randomUUID()
    await save(f.actors[0], create(id, [f.teamId, f.privateTeam]))
    const secret = await link(
      f.actors[0],
      f.privateTeam,
      id,
      "Private secret title"
    )
    const visible = await link(f.actors[0], f.teamId, id)
    const row = (await project(f.actors[1], id))!
    expect(row.properties.teamIds).toEqual([f.teamId])
    const page = await queries.queryCanonicalIssues(f.actors[1], {
      project: id,
    })
    expect(page.records.map((r) => r.issue.id)).toEqual([visible.issue.id])
    expect(JSON.stringify(page)).not.toContain(secret.issue.id)
    expect(JSON.stringify(page)).not.toContain("Private secret title")
    expect(page.projectTotals).toEqual([
      { project: id, count: 1, completed: 0 },
    ])
    await expect(link(f.actors[1], f.privateTeam, id)).rejects.toThrow()
    const { editCanonicalIssues } = await import("../issues/edit-issues.server")
    await expect(
      editCanonicalIssues(f.actors[1], {
        commandKey: randomUUID(),
        teamId: f.privateTeam,
        edits: [
          {
            issueId: secret.issue.id,
            expectedRevision: secret.issue.revision ?? 0,
            changes: { project: id },
          },
        ],
      })
    ).rejects.toThrow()
    await save(f.actors[1], [
      {
        id,
        expectedRevision: row.revision,
        changes: { name: "Public edit", teamIds: [f.teamId] },
      },
    ])
    expect((await project(f.actors[0], id))!.properties.teamIds).toEqual(
      expect.arrayContaining([f.teamId, f.privateTeam])
    )
  }, 30000)
  it("denies private-only and foreign projects, inaccessible team additions, missing scope and revoked sessions", async () => {
    const f = await fixture(),
      foreign = await fixture(),
      id = randomUUID()
    await save(f.actors[0], create(id, [f.privateTeam]))
    expect(await project(f.actors[1], id)).toBeUndefined()
    await expect(
      save(f.actors[1], [
        { id, expectedRevision: 1, changes: { name: "Denied" } },
      ])
    ).rejects.toThrow()
    await expect(
      save(foreign.actors[0], [
        { id, expectedRevision: 1, changes: { name: "Denied" } },
      ])
    ).rejects.toThrow()
    await expect(
      save(f.actors[1], create(randomUUID(), [f.privateTeam]))
    ).rejects.toThrow()
    await expect(
      save(
        { ...f.actors[1], scopes: ["projects:read"] },
        create(randomUUID(), [])
      )
    ).rejects.toThrow()
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, userIds[1]]
    )
    await expect(save(f.actors[1], create(randomUUID(), []))).rejects.toThrow()
  }, 30000)
  it("replays one effect, rejects changed retry input and reauthorizes revoked replays", async () => {
    const f = await fixture(),
      id = randomUUID(),
      key = randomUUID(),
      changes = create(id, [f.teamId])
    await save(f.actors[1], changes, key)
    expect((await save(f.actors[1], changes, key)).replayed).toBe(true)
    await expect(
      save(f.actors[1], create(id, [], "Changed"), key)
    ).rejects.toThrow()
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM command_audit_events WHERE resource_id=$1 AND operation='projects.save@1'",
          [id]
        )
      ).rows[0].count
    ).toBe(1)
    await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
      f.teamId,
    ])
    await expect(save(f.actors[1], changes, key)).rejects.toThrow()
  }, 30000)
  it("allows one competing version and rolls back a stale bulk batch", async () => {
    const f = await fixture(),
      a = randomUUID(),
      b = randomUUID()
    await save(f.actors[0], [...create(a, []), ...create(b, [])])
    const revision = (await project(f.actors[1], a))!.revision
    const results = await Promise.allSettled(
      ["Alice", "Bob"].map((name) =>
        save(f.actors[1], [
          { id: a, expectedRevision: revision, changes: { name } },
        ])
      )
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    await expect(
      save(f.actors[1], [
        {
          id: b,
          expectedRevision: (await project(f.actors[1], b))!.revision,
          changes: { name: "Must roll back" },
        },
        { id: a, expectedRevision: revision, changes: { name: "Stale" } },
      ])
    ).rejects.toThrow("changed in another session")
    expect((await project(f.actors[0], b))!.name).toBe("Shared project")
  }, 30000)
  it("validates dates, members, team restrictions and the metadata boundary", async () => {
    const f = await fixture(),
      id = randomUUID()
    await expect(
      save(f.actors[1], [
        {
          id,
          expectedRevision: null,
          changes: { name: "Bad", startDate: "2027", targetDate: "2026" },
        },
      ])
    ).rejects.toThrow("target date")
    await expect(
      save(f.actors[1], [
        {
          id,
          expectedRevision: null,
          changes: { name: "Bad", leadId: "foreign-person" },
        },
      ])
    ).rejects.toThrow("workspace member")
    await expect(
      save(f.actors[1], [
        {
          id,
          expectedRevision: null,
          changes: { name: "Bad", comments: [{ text: "Forged" }] },
        },
      ])
    ).rejects.toThrow()
    await save(f.actors[1], create(id, []))
    await link(f.actors[0], f.teamId, id)
    await expect(
      save(f.actors[0], [
        {
          id,
          expectedRevision: (await project(f.actors[0], id))!.revision,
          changes: { teamIds: [f.privateTeam] },
        },
      ])
    ).rejects.toThrow()
    expect((await project(f.actors[1], id))!.properties.teamIds).toEqual([])
  }, 30000)
  it("routes authenticated save-queue requests through the project command and stores no shared draft blob", async () => {
    const f = await fixture(),
      id = randomUUID(),
      actor = f.actors[1]
    const { saveProductState } =
      await import("../product-state/product-state.server")
    const result = await saveProductState(actor, {
      workspaceId: f.workspaceId,
      sessionId: (actor.authentication as { sessionId: string }).sessionId,
      commandKey: randomUUID(),
      key: `forge:project-command:v1:${randomUUID()}`,
      expectedRevision: 0,
      value: JSON.stringify(create(id, [])),
    })
    expect(result.value.revision).toBe(1)
    expect((await project(f.actors[0], id))!.name).toBe("Shared project")
    expect(
      (
        await pool.query(
          "SELECT count(*)::int count FROM product_state WHERE workspace_id=$1 AND key LIKE 'forge:project-command:%'",
          [f.workspaceId]
        )
      ).rows[0].count
    ).toBe(0)
  }, 30000)
  it("redacts legacy unreadable project references before issue responses and project aggregation", async () => {
    const f = await fixture(),
      id = randomUUID()
    await save(f.actors[0], create(id, [f.privateTeam]))
    await pool.query(
      "INSERT INTO issues(workspace_id,team_id,number,title,status_id,project_id,properties) VALUES($1,$2,1,'Legacy visible issue','todo',$3,'{}')",
      [f.workspaceId, f.teamId, id]
    )
    expect(
      (await issues.readCanonicalIssues(f.actors[1])).records[0].issue.project
    ).toBe("")
    const page = await queries.queryCanonicalIssues(f.actors[1], {})
    expect(page.projectTotals).toEqual([
      { project: "", count: 1, completed: 0 },
    ])
    expect(JSON.stringify(page)).not.toContain(id)
    expect(
      (await queries.queryCanonicalIssues(f.actors[1], { project: id })).records
    ).toEqual([])
  }, 30000)
})

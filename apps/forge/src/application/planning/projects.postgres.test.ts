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
    const {
      connection,
      applicationConnection,
      target: configuredTarget,
    } = JSON.parse(readFileSync(file!, "utf8"))
    const environment =
      configuredTarget === "initiative-rehearsal"
        ? "initiative-rehearsal"
        : "issue-history-acceptance"
    const target = { environment, ...DATABASE_TARGETS[environment] } as const
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
  const project = async (actor: Actor, id: string) => {
    const row = (await issues.readCanonicalIssues(actor, true)).projects.find(
      (p) => p.id === id
    )
    return row
      ? { ...row, properties: row.properties as Record<string, unknown> }
      : undefined
  }
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
  it("hides saved project recovery content after revocation and restores the exact private original after access returns", async () => {
    const f = await fixture(),
      id = randomUUID(),
      actor = f.actors[1]
    await save(actor, create(id, [f.teamId]))
    const { readProductState, saveProductState } =
      await import("../product-state/product-state.server")
    const key = `forge:pending-recovery:v1:${randomUUID()}`
    const value = JSON.stringify({
      key: `forge:project-command:v1:${randomUUID()}`,
      value: JSON.stringify([
        {
          id,
          expectedRevision: (await project(actor, id))!.revision,
          changes: {
            name: "Secret retained title",
            summary: "Secret retained summary",
          },
        },
      ]),
    })
    await saveProductState(actor, {
      workspaceId: f.workspaceId,
      sessionId: (actor.authentication as { sessionId: string }).sessionId,
      commandKey: randomUUID(),
      key,
      value,
      expectedRevision: 0,
    })
    expect(
      (await readProductState(actor)).entries.find((entry) => entry.key === key)
        ?.value
    ).toBe(value)
    await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
      f.teamId,
    ])
    const hidden = await readProductState(actor)
    expect(hidden.entries.find((entry) => entry.key === key)?.value).toBeNull()
    expect(JSON.stringify(hidden)).not.toContain("Secret retained")
    expect(
      (
        await pool.query(
          "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2",
          [f.workspaceId, key]
        )
      ).rows[0].encoded_value
    ).toBe(JSON.stringify(value))
    await pool.query(
      "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member')",
      [randomUUID(), f.workspaceId, f.teamId, actor.userId]
    )
    expect(
      (await readProductState(actor)).entries.find((entry) => entry.key === key)
        ?.value
    ).toBe(value)
  }, 30000)
  it("FOR-58 AT-01/02: shared milestones, attributed updates, authorized progress, conflicts and exact replay", async () => {
    const f = await fixture(),
      id = randomUUID(),
      milestoneId = randomUUID()
    await save(f.actors[0], create(id, [f.teamId, f.privateTeam]))
    let row = (await project(f.actors[0], id))!
    await save(f.actors[1], [
      {
        id,
        expectedRevision: row.revision,
        changes: {
          milestones: [{ id: milestoneId, name: "Release", completed: false }],
        },
      },
    ])
    const a = await issues.createCanonicalIssue(f.actors[0], {
      commandKey: randomUUID(),
      teamId: f.teamId,
      draft: {
        ...blankIssueDraft("done"),
        title: "Done",
        project: id,
        milestone: milestoneId,
      },
    })
    await issues.createCanonicalIssue(f.actors[0], {
      commandKey: randomUUID(),
      teamId: f.teamId,
      draft: {
        ...blankIssueDraft("todo"),
        title: "Open",
        project: id,
        milestone: milestoneId,
      },
    })
    await issues.createCanonicalIssue(f.actors[0], {
      commandKey: randomUUID(),
      teamId: f.privateTeam,
      draft: {
        ...blankIssueDraft("done"),
        title: "Private",
        project: id,
        milestone: milestoneId,
      },
    })
    const page = await queries.queryCanonicalIssues(f.actors[1], {
      project: id,
      limit: 1,
    })
    expect(page.projectTotals).toEqual([
      { project: id, count: 2, completed: 1 },
    ])
    expect(page.rollups.reduce((n, r) => n + r.count, 0)).toBe(2)
    expect(page.rollups.reduce((n, r) => n + r.completed, 0)).toBe(1)
    row = (await project(f.actors[1], id))!
    const post = {
      id: randomUUID(),
      text: "Half complete",
      health: "On track",
      authorId: userIds[0],
      createdAt: "2000-01-01T00:00:00.000Z",
      attachments: [],
      reactions: [],
      comments: [],
    }
    const change = [
        { id, expectedRevision: row.revision, changes: { updates: [post] } },
      ],
      key = randomUUID()
    await save(f.actors[1], change, key)
    expect((await save(f.actors[1], change, key)).replayed).toBe(true)
    const updated = (await project(f.actors[0], id))!
    const posts = updated.properties.updates as Array<typeof post>
    expect(posts[0]).toMatchObject({ text: post.text, authorId: userIds[1] })
    expect(posts[0].createdAt).not.toBe(post.createdAt)
    expect(updated.properties.health).toBe("On track")
    await expect(
      save(f.actors[1], [
        { id, expectedRevision: row.revision, changes: { milestones: [] } },
      ])
    ).rejects.toThrow("changed in another session")
    await expect(
      save(f.actors[1], [
        {
          id,
          expectedRevision: updated.revision,
          changes: {},
          relocation: { milestoneId },
        },
      ])
    ).rejects.toThrow()
    expect((await project(f.actors[0], id))!.revision).toBe(updated.revision)
    expect(
      (
        await pool.query(
          "SELECT properties->>'milestone' milestone FROM issues WHERE id=$1",
          [a.issue.id]
        )
      ).rows[0].milestone
    ).toBe(milestoneId)
    await expect(
      issues.createCanonicalIssue(f.actors[1], {
        commandKey: randomUUID(),
        teamId: f.teamId,
        draft: {
          ...blankIssueDraft("todo"),
          title: "Dangling",
          project: id,
          milestone: "missing",
        },
      })
    ).rejects.toThrow("Choose a milestone")
  })

  it("FOR-58: milestone move, conversion and deletion cover every row and commit issue history once", async () => {
    const f = await fixture(),
      id = randomUUID(),
      targetId = randomUUID(),
      m = randomUUID()
    await save(f.actors[1], [
      ...create(id, [f.teamId]),
      ...create(targetId, [f.teamId], "Destination"),
    ])
    let source = (await project(f.actors[1], id))!,
      target = (await project(f.actors[1], targetId))!
    await save(f.actors[1], [
      {
        id,
        expectedRevision: source.revision,
        changes: { milestones: [{ id: m, name: "Ship", completed: false }] },
      },
    ])
    const linked = await issues.createCanonicalIssue(f.actors[1], {
      commandKey: randomUUID(),
      teamId: f.teamId,
      draft: {
        ...blankIssueDraft("todo"),
        title: "Ship work",
        project: id,
        milestone: m,
      },
    })
    source = (await project(f.actors[1], id))!
    const move = [
        {
          id,
          expectedRevision: source.revision,
          changes: {},
          relocation: {
            milestoneId: m,
            targetId,
            targetRevision: target.revision,
          },
        },
      ],
      key = randomUUID()
    await save(f.actors[1], move, key)
    await save(f.actors[1], move, key)
    expect((await project(f.actors[1], id))!.properties.milestones).toEqual([])
    target = (await project(f.actors[1], targetId))!
    expect(target.properties.milestones).toMatchObject([{ id: m }])
    expect(
      (
        await pool.query(
          "SELECT project_id,properties->>'milestone' milestone FROM issues WHERE id=$1",
          [linked.issue.id]
        )
      ).rows[0]
    ).toEqual({ project_id: targetId, milestone: m })
    const converted = randomUUID()
    await save(f.actors[1], [
      {
        id: targetId,
        expectedRevision: target.revision,
        changes: {},
        relocation: { milestoneId: m, convertId: converted },
      },
    ])
    expect((await project(f.actors[1], converted))!.name).toBe("Ship")
    expect(
      (
        await pool.query(
          "SELECT project_id,properties->>'milestone' milestone FROM issues WHERE id=$1",
          [linked.issue.id]
        )
      ).rows[0]
    ).toEqual({ project_id: converted, milestone: "" })
    const latest = (await project(f.actors[1], converted))!
    await save(f.actors[1], [
      {
        id: converted,
        expectedRevision: latest.revision,
        changes: {
          milestones: [{ id: m, name: "Delete me", completed: false }],
        },
      },
    ])
    await pool.query(
      "UPDATE issues SET properties=jsonb_set(properties,'{milestone}',to_jsonb($2::text)),archived_at=now() WHERE id=$1",
      [linked.issue.id, m]
    )
    const beforeDelete = (await project(f.actors[1], converted))!
    await save(f.actors[1], [
      {
        id: converted,
        expectedRevision: beforeDelete.revision,
        changes: {},
        relocation: { milestoneId: m },
      },
    ])
    expect(
      (
        await pool.query(
          "SELECT properties->>'milestone' milestone FROM issues WHERE id=$1",
          [linked.issue.id]
        )
      ).rows[0].milestone
    ).toBe("")
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_outbox_events WHERE workspace_id=$1 AND topic='issue.updated'",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(3)
  })

  it("FOR-58: project catalog admin policy, stale versions, shared reads and custom status assignment", async () => {
    const f = await fixture(),
      id = randomUUID()
    const service = await import("../product-state/product-state.server")
    const { initialProjectStatuses, projectStatusesStorageKey } =
      await import("@/lib/project-statuses")
    const catalog = initialProjectStatuses()
    catalog.version = 1
    catalog.statuses.push({
      id: "review",
      name: "Review",
      description: "Reviewing",
      color: "#123456",
      group: "in-progress",
    })
    const command = {
      commandKey: randomUUID(),
      workspaceId: f.workspaceId,
      sessionId:
        f.actors[0].authentication.kind === "session"
          ? f.actors[0].authentication.sessionId
          : "",
      key: projectStatusesStorageKey(f.workspaceId),
      value: JSON.stringify(catalog),
      expectedRevision: 0,
    }
    await expect(
      service.saveProductState(f.actors[1], {
        ...command,
        sessionId:
          f.actors[1].authentication.kind === "session"
            ? f.actors[1].authentication.sessionId
            : "",
      })
    ).rejects.toThrow("Only workspace admins")
    await service.saveProductState(f.actors[0], command)
    const shared = await service.readProductState(f.actors[1])
    expect(
      JSON.parse(
        shared.entries.find((e) => e.key === command.key)!.value!
      ).statuses.at(-1).name
    ).toBe("Review")
    await expect(
      service.saveProductState(f.actors[0], {
        ...command,
        commandKey: randomUUID(),
        expectedRevision: 1,
      })
    ).rejects.toThrow("changed in another session")
    await save(f.actors[1], create(id, [f.teamId]))
    const row = (await project(f.actors[1], id))!
    await save(f.actors[1], [
      { id, expectedRevision: row.revision, changes: { statusId: "review" } },
    ])
    expect((await project(f.actors[0], id))!.properties).toMatchObject({
      statusId: "review",
      status: "Active",
    })
    catalog.version = 2
    catalog.statuses = catalog.statuses.filter((s) => s.id !== "review")
    await expect(
      service.saveProductState(f.actors[0], {
        ...command,
        commandKey: randomUUID(),
        expectedRevision: 1,
        value: JSON.stringify(catalog),
      })
    ).rejects.toThrow("in use")
  })

  it("FOR-58: post authorship, private attachment binding, detach and revoked download access", async () => {
    const f = await fixture(),
      id = randomUUID(),
      fileId = randomUUID(),
      postId = randomUUID()
    await save(f.actors[1], create(id, [f.teamId]))
    await pool.query(
      "INSERT INTO resource_files(id,workspace_id,created_by_user_id,project_id,attachment_state,name,content_type,size_bytes,checksum,storage_reference) VALUES($1,$2,$3,$4,'unbound','note.txt','text/plain',4,$5,$6)",
      [
        fileId,
        f.workspaceId,
        userIds[1],
        id,
        "a".repeat(64),
        `files/${randomUUID()}`,
      ]
    )
    const { lookupAuthorizedFile } =
      await import("@/adapters/files/file-delivery-lookup.server")
    expect(
      await lookupAuthorizedFile(f.actors[0], { kind: "resources", id: fileId })
    ).toBeNull()
    let row = (await project(f.actors[1], id))!
    const post = {
      id: postId,
      text: "Private file",
      health: "On track",
      authorId: userIds[0],
      createdAt: "2000-01-01T00:00:00.000Z",
      attachments: [
        {
          id: fileId,
          fileId,
          name: "note.txt",
          mime: "text/plain",
          sizeBytes: 4,
        },
      ],
      reactions: [],
      comments: [],
    }
    await save(f.actors[1], [
      { id, expectedRevision: row.revision, changes: { updates: [post] } },
    ])
    expect(
      await lookupAuthorizedFile(f.actors[0], { kind: "resources", id: fileId })
    ).toMatchObject({ name: "note.txt" })
    row = (await project(f.actors[0], id))!
    const savedPost = (row.properties.updates as Array<typeof post>)[0]
    // Even a claimed different author cannot change the committed author or time.
    await save(f.actors[1], [
      {
        id,
        expectedRevision: row.revision,
        changes: {
          updates: [
            {
              ...savedPost,
              authorId: userIds[0],
              createdAt: post.createdAt,
              text: "Edited",
            },
          ],
        },
      },
    ])
    row = (await project(f.actors[0], id))!
    expect((row.properties.updates as Array<typeof post>)[0].authorId).toBe(
      userIds[1]
    )
    await save(f.actors[0], [
      { id, expectedRevision: row.revision, changes: { updates: [] } },
    ])
    expect(
      await lookupAuthorizedFile(f.actors[1], { kind: "resources", id: fileId })
    ).toBeNull()
    expect(
      (
        await pool.query(
          "SELECT attachment_state FROM resource_files WHERE id=$1",
          [fileId]
        )
      ).rows[0].attachment_state
    ).toBe("detached")
  })
  it("FOR-58: shared labels are versioned and their usage excludes hidden projects", async () => {
    const f = await fixture(),
      visibleId = randomUUID(),
      hiddenId = randomUUID()
    const service = await import("../product-state/product-state.server")
    const key = "forge:workspace-project-labels:v1"
    const labelId = randomUUID()
    const directory = {
      version: 1,
      catalogRevision: 0,
      labels: [
        {
          id: labelId,
          name: "Release",
          description: "Shipping",
          color: "#123456",
          groupId: null,
          issues: 999,
          lastApplied: null,
          createdAt: new Date().toISOString(),
        },
      ],
      groups: [],
      inheritedCount: 0,
    }
    const command = {
      commandKey: randomUUID(),
      workspaceId: f.workspaceId,
      sessionId: (f.actors[0].authentication as { sessionId: string })
        .sessionId,
      key,
      value: JSON.stringify(directory),
      expectedRevision: 0,
    }
    await service.saveProductState(f.actors[0], command)
    await save(f.actors[0], [
      ...create(visibleId, [f.teamId]),
      ...create(hiddenId, [f.privateTeam]),
    ])
    for (const id of [visibleId, hiddenId])
      await save(f.actors[0], [
        {
          id,
          expectedRevision: (await project(f.actors[0], id))!.revision,
          changes: { labelIds: [labelId] },
        },
      ])
    const member = (await service.readProductState(f.actors[1])).entries.find(
      (e) => e.key === key
    )!
    expect(JSON.parse(member.value!).labels[0].issues).toBe(1)
    expect(JSON.parse(member.value!).catalogRevision).toBe(1)
    await expect(
      service.saveProductState(f.actors[0], {
        ...command,
        commandKey: randomUUID(),
        expectedRevision: 1,
      })
    ).rejects.toThrow("changed in another session")
    await expect(
      service.saveProductState(f.actors[0], {
        ...command,
        commandKey: randomUUID(),
        expectedRevision: 1,
        value: JSON.stringify({ ...directory, catalogRevision: 1, labels: [] }),
      })
    ).rejects.toThrow("in use")
  })

  it("FOR-58: changing an issue project clears its previous milestone and writes attributable history", async () => {
    const f = await fixture(),
      id = randomUUID(),
      destination = randomUUID(),
      milestoneId = randomUUID()
    await save(f.actors[1], [
      ...create(id, [f.teamId]),
      ...create(destination, [f.teamId]),
    ])
    await save(f.actors[1], [
      {
        id,
        expectedRevision: (await project(f.actors[1], id))!.revision,
        changes: {
          milestones: [{ id: milestoneId, name: "Scope", completed: false }],
        },
      },
    ])
    const result = await issues.createCanonicalIssue(f.actors[1], {
      commandKey: randomUUID(),
      teamId: f.teamId,
      draft: {
        ...blankIssueDraft("todo"),
        title: "Move project",
        project: id,
        milestone: milestoneId,
      },
    })
    const { editCanonicalIssues } = await import("../issues/edit-issues.server")
    const moved = await editCanonicalIssues(f.actors[1], {
      commandKey: randomUUID(),
      teamId: f.teamId,
      edits: [
        {
          issueId: result.issue.id,
          expectedRevision: result.issue.revision!,
          changes: { project: destination },
        },
      ],
    })
    expect(moved.status).toBe("saved")
    expect(
      (
        await pool.query(
          "SELECT project_id,properties->>'milestone' milestone FROM issues WHERE id=$1",
          [result.issue.id]
        )
      ).rows[0]
    ).toEqual({ project_id: destination, milestone: "" })
  })
  it.each(["move", "convert"])(
    "FOR-58 review: %s holds private-team membership until the complete command commits",
    async (mode) => {
      const f = await fixture(),
        source = randomUUID(),
        target = randomUUID(),
        milestoneId = randomUUID()
      await pool.query(
        "INSERT INTO team_members(workspace_id,team_id,user_id,role) VALUES($1,$2,$3,'member')",
        [f.workspaceId, f.privateTeam, userIds[1]]
      )
      await save(f.actors[1], [
        ...create(source, [f.teamId, f.privateTeam]),
        ...(mode === "move" ? create(target, [f.teamId, f.privateTeam]) : []),
      ])
      await save(f.actors[1], [
        {
          id: source,
          expectedRevision: (await project(f.actors[1], source))!.revision,
          changes: {
            milestones: [
              { id: milestoneId, name: "Private work", completed: false },
            ],
          },
        },
      ])
      const issue = await issues.createCanonicalIssue(f.actors[1], {
        commandKey: randomUUID(),
        teamId: mode === "move" ? f.privateTeam : f.teamId,
        draft: {
          ...blankIssueDraft("todo"),
          title: "Private assignment",
          project: source,
          milestone: milestoneId,
        },
      })
      const sourceRow = (await project(f.actors[1], source))!,
        targetRow = await project(f.actors[1], target)
      const blocker = await pool.connect(),
        revoker = await pool.connect()
      let moving: Promise<unknown> | undefined
      try {
        await blocker.query("BEGIN")
        const blockerPid = (await blocker.query("SELECT pg_backend_pid() pid"))
          .rows[0].pid
        await blocker.query("SELECT id FROM issues WHERE id=$1 FOR UPDATE", [
          issue.issue.id,
        ])
        moving = save(f.actors[1], [
          {
            id: source,
            expectedRevision: sourceRow.revision,
            changes: {},
            relocation: {
              milestoneId,
              ...(mode === "move"
                ? { targetId: target, targetRevision: targetRow!.revision }
                : { convertId: target }),
            },
          },
        ])
        let blocked = false
        for (let attempt = 0; attempt < 80; attempt++) {
          blocked = (
            await pool.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked",
              [blockerPid]
            )
          ).rows[0].blocked
          if (blocked) break
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(blocked).toBe(true)
        await revoker.query("BEGIN")
        await revoker.query("SET LOCAL lock_timeout='250ms'")
        let code: string | undefined
        try {
          await revoker.query(
            "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
            [f.workspaceId, f.privateTeam, userIds[1]]
          )
        } catch (error) {
          code = (error as { code?: string }).code
        }
        await revoker.query("ROLLBACK")
        expect(code).toBe("55P03")
      } finally {
        await revoker.query("ROLLBACK")
        await blocker.query("ROLLBACK")
        await moving
        revoker.release()
        blocker.release()
      }
      expect(
        (
          await pool.query("SELECT project_id FROM issues WHERE id=$1", [
            issue.issue.id,
          ])
        ).rows[0].project_id
      ).toBe(target)
      await pool.query(
        "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
        [f.workspaceId, f.privateTeam, userIds[1]]
      )
      await expect(
        save(f.actors[1], [
          {
            id: target,
            expectedRevision: (await project(f.actors[1], target))!.revision,
            changes: {},
            relocation: { milestoneId },
          },
        ])
      ).rejects.toThrow()
    },
    30000
  )
})

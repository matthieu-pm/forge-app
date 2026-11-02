// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import type { Actor } from "@/application/actor"
import type * as Views from "./saved-views.server"
import type * as Issues from "../issues/issues.server"
import type * as Queries from "../issues/query-issues.server"
import { newCustomView } from "@/lib/custom-views"
import { viewDefinition } from "@/lib/saved-view-contract"
import { blankIssueDraft } from "@/lib/issue-record-contract"

const file = process.env.FORGE_SAVED_VIEWS_TEST_DATABASE_FILE
describe.skipIf(!file)("FOR-60 saved views on PostgreSQL", () => {
  const marker = `for60-${randomUUID()}`,
    userIds = [`${marker}-alice`, `${marker}-bob`],
    workspaces: Array<string> = []
  let pool: Pool,
    views: typeof Views,
    issues: typeof Issues,
    queries: typeof Queries
  beforeAll(async () => {
    const { connection, applicationConnection } = JSON.parse(
      readFileSync(file!, "utf8")
    )
    const target = {
      environment: "saved-views-acceptance",
      ...DATABASE_TARGETS["saved-views-acceptance"],
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
    vi.stubEnv("FORGE_FEATURE_SAVED_VIEWS", "true")
    views = await import("./saved-views.server")
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
  const definition = (
    userId: string,
    visibility: "personal" | "workspace" | "team" = "personal",
    teamId?: string
  ) =>
    viewDefinition({
      ...newCustomView("issues", userId, teamId),
      visibility,
      name: "Useful work",
    })
  const save = (
    actor: Actor,
    id: string,
    value: unknown,
    expectedRevision: number | null = null,
    key = randomUUID()
  ) =>
    views.mutateSavedView(actor, key, {
      action: "save",
      id,
      expectedRevision,
      definition: value,
    })
  const favorite = (actor: Actor, id: string, value: boolean) =>
    views.mutateSavedView(actor, randomUUID(), {
      action: "favorite",
      id,
      favorite: value,
    })
  it("AT-01: fresh sessions see private/shared definitions and actor-owned favorites", async () => {
    const {
        actors: [alice, bob],
      } = await fixture(),
      personal = randomUUID(),
      shared = randomUUID()
    await save(alice, personal, definition(alice.userId))
    await save(alice, shared, definition(alice.userId, "workspace"))
    await favorite(bob, shared, true)
    const a = await views.readSavedViews(alice),
      b = await views.readSavedViews(bob)
    expect(a.views.map((v) => v.id).sort()).toEqual([personal, shared].sort())
    expect(a.views.every((v) => !v.favorite)).toBe(true)
    expect(b.views).toHaveLength(1)
    expect(b.views[0]).toMatchObject({
      id: shared,
      favorite: true,
      canEdit: false,
    })
    const sessionId = randomUUID()
    await pool.query(
      "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
      [sessionId, bob.userId, bob.workspaceId]
    )
    expect(
      (
        await views.readSavedViews({
          ...bob,
          authentication: { kind: "session", sessionId },
        })
      ).views
    ).toEqual(b.views)
  }, 30000)
  it("enforces creator/admin editing, immutable ownership and revision conflicts", async () => {
    const {
        actors: [alice, bob],
      } = await fixture(),
      id = randomUUID(),
      value = definition(bob.userId, "workspace")
    await save(bob, id, value)
    await save(alice, id, { ...value, name: "Admin edit" }, 1)
    await expect(save(bob, id, value, 1)).rejects.toThrow("changed")
    await expect(
      save(bob, randomUUID(), { ...value, ownerId: alice.userId })
    ).rejects.toThrow()
    const privateId = randomUUID()
    await save(bob, privateId, definition(bob.userId))
    await expect(save(alice, privateId, value, 1)).rejects.toThrow()
    const memberShared = randomUUID()
    await save(alice, memberShared, definition(alice.userId, "workspace"))
    await expect(save(bob, memberShared, value, 1)).rejects.toThrow()
    await expect(
      views.mutateSavedView(bob, randomUUID(), {
        action: "delete",
        id: memberShared,
        expectedRevision: 1,
      })
    ).rejects.toThrow()
  }, 30000)
  it("an admin can make a shared view personal to its creator and immediately loses read access", async () => {
    const {
        actors: [alice, bob],
      } = await fixture(),
      id = randomUUID(),
      shared = definition(bob.userId, "workspace")
    await save(bob, id, shared)
    await save(alice, id, { ...shared, visibility: "personal" }, 1)
    expect((await views.readSavedViews(alice)).views).toEqual([])
    expect((await views.readSavedViews(bob)).views).toEqual([
      expect.objectContaining({
        id,
        ownerId: bob.userId,
        visibility: "personal",
        revision: 2,
      }),
    ])
    await expect(save(alice, id, shared, 2)).rejects.toThrow()
  }, 30000)
  it("AT-02: rejects unknown fields, versions and inaccessible IDs with no widened results", async () => {
    const {
        actors: [alice, bob],
        privateTeam,
      } = await fixture(),
      id = randomUUID()
    const value = definition(bob.userId)
    await expect(save(bob, id, { ...value, version: 2 })).rejects.toThrow()
    await expect(
      save(bob, id, {
        ...value,
        filters: {
          match: "all",
          rules: [{ id: "x", field: "secret", operator: "is", value: "x" }],
        },
      })
    ).rejects.toThrow()
    await expect(
      save(bob, id, {
        ...value,
        filters: { match: "all", rules: [], unknown: true },
      })
    ).rejects.toThrow()
    await expect(
      save(bob, id, definition(bob.userId, "team", privateTeam))
    ).rejects.toThrow("unavailable")
    const projectId = randomUUID()
    await pool.query(
      "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Hidden project')",
      [projectId, bob.workspaceId]
    )
    await pool.query(
      "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
      [bob.workspaceId, projectId, privateTeam]
    )
    const filtered = {
      ...definition(alice.userId, "workspace"),
      filters: {
        match: "all",
        rules: [
          { id: "p", field: "project", operator: "is", value: projectId },
        ],
      },
    }
    await save(alice, id, filtered)
    const read = await views.readSavedViews(bob)
    expect(read.views).toEqual([])
    expect(read.error).toContain("unavailable")
    expect(JSON.stringify(read)).not.toContain(projectId)
    await expect(
      save(bob, randomUUID(), { ...value, filters: filtered.filters })
    ).rejects.toThrow("unavailable")
    await pool.query(
      "UPDATE saved_views SET definition=jsonb_set(definition,'{version}','99') WHERE id=$1",
      [id]
    )
    const owner = await views.readSavedViews(alice)
    expect(owner.views).toEqual([])
    expect(owner.error).toContain("unsupported")
  }, 30000)
  it("executes shared issue filters through FOR-43 without revealing private records or counts", async () => {
    const {
        actors: [alice, bob],
        teamId,
        privateTeam,
      } = await fixture(),
      id = randomUUID()
    for (const team of [teamId, privateTeam])
      await issues.createCanonicalIssue(alice, {
        commandKey: randomUUID(),
        teamId: team,
        draft: {
          ...blankIssueDraft("todo"),
          title: "Saved search",
          priority: "High",
        },
      })
    const value = definition(alice.userId, "workspace")
    if (value.kind !== "issues") throw Error("fixture")
    value.filters = {
      match: "all",
      rules: [{ id: "p", field: "priority", operator: "is", value: "High" }],
    }
    await save(alice, id, value)
    const found = (await views.readSavedViews(bob)).views[0]
    if (found.kind !== "issues") throw Error("fixture")
    const page = await queries.queryCanonicalIssues(bob, {
      filters: found.filters,
      display: found.display,
    })
    expect(page.total).toBe(1)
    expect(page.records.map((r) => r.teamId)).toEqual([teamId])
  }, 30000)
  it("executes project filters against authorized canonical projections", async () => {
    const {
      actors: [alice, bob],
      teamId,
      privateTeam,
    } = await fixture()
    for (const [team, name] of [
      [teamId, "Visible"],
      [privateTeam, "Hidden"],
    ]) {
      const id = randomUUID()
      await pool.query(
        "INSERT INTO projects(id,workspace_id,name,properties) VALUES($1,$2,$3,$4)",
        [id, bob.workspaceId, name, { status: "Planned" }]
      )
      await pool.query(
        "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
        [bob.workspaceId, id, team]
      )
    }
    const value = viewDefinition({
      ...newCustomView("projects", alice.userId),
      visibility: "workspace",
      filters: [{ field: "Status", value: "Planned" }],
    })
    const result = await views.queryViewProjects(bob, value)
    expect(result.map((p) => p.name)).toEqual(["Visible"])
    expect(result[0].teamIds).toEqual([teamId])
  }, 30000)
  it("revocation hides team views and favorites, including writes with a retained Actor", async () => {
    const {
        actors: [alice, bob],
        privateTeam,
      } = await fixture(),
      id = randomUUID()
    await pool.query(
      "INSERT INTO team_members(workspace_id,team_id,user_id,role) VALUES($1,$2,$3,'member')",
      [bob.workspaceId, privateTeam, bob.userId]
    )
    await save(alice, id, definition(alice.userId, "team", privateTeam))
    await favorite(bob, id, true)
    expect((await views.readSavedViews(bob)).views).toHaveLength(1)
    await pool.query(
      "DELETE FROM team_members WHERE team_id=$1 AND user_id=$2",
      [privateTeam, bob.userId]
    )
    expect((await views.readSavedViews(bob)).views).toEqual([])
    await expect(favorite(bob, id, true)).rejects.toThrow()
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [bob.workspaceId, bob.userId]
    )
    await expect(views.readSavedViews(bob)).rejects.toThrow()
  }, 30000)
  it("durable retries do not repeat effects and deletion clears favorites without deleting work", async () => {
    const {
        actors: [alice, bob],
      } = await fixture(),
      id = randomUUID(),
      key = randomUUID(),
      value = definition(alice.userId, "workspace")
    const first = await save(alice, id, value, null, key),
      second = await save(alice, id, value, null, key)
    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    await favorite(bob, id, true)
    const del = randomUUID()
    await views.mutateSavedView(alice, del, {
      action: "delete",
      id,
      expectedRevision: 1,
    })
    expect(
      (
        await views.mutateSavedView(alice, del, {
          action: "delete",
          id,
          expectedRevision: 1,
        })
      ).replayed
    ).toBe(true)
    expect((await views.readSavedViews(alice)).views).toEqual([])
    expect(
      (
        await pool.query(
          "SELECT * FROM saved_view_favorites WHERE view_id=$1",
          [id]
        )
      ).rows
    ).toEqual([])
    await expect(save(alice, id, value)).rejects.toThrow()
  }, 30000)
  it("feature gate returns no definitions and rejects all mutations", async () => {
    const {
      actors: [alice],
    } = await fixture()
    vi.stubEnv("FORGE_FEATURE_SAVED_VIEWS", "false")
    try {
      expect(await views.readSavedViews(alice)).toMatchObject({
        enabled: false,
        views: [],
      })
      await expect(
        save(alice, randomUUID(), definition(alice.userId))
      ).rejects.toThrow("not enabled")
    } finally {
      vi.stubEnv("FORGE_FEATURE_SAVED_VIEWS", "true")
    }
  }, 30000)
  it("FOR-60 review: empty and nonempty initiative project filters fail closed on save, read and execution", async () => {
    const {
      actors: [alice, bob],
    } = await fixture()
    for (const value of ["", randomUUID()]) {
      const id = randomUUID(),
        unsupportedDefinition = viewDefinition({
          ...newCustomView("projects", alice.userId),
          visibility: "workspace",
          filters: [{ field: "Initiatives", value }],
        })
      await expect(save(alice, id, unsupportedDefinition)).rejects.toThrow(
        /Initiative filters/
      )
      await expect(
        views.queryViewProjects(bob, unsupportedDefinition)
      ).rejects.toThrow(/Initiative filters/)
      await pool.query(
        "INSERT INTO saved_views(id,workspace_id,owner_id,visibility,definition,revision) VALUES($1,$2,$3,'workspace',$4,1)",
        [id, alice.workspaceId, alice.userId, unsupportedDefinition]
      )
    }
    expect(await views.readSavedViews(bob)).toMatchObject({
      views: [],
      error: expect.stringContaining("unsupported filters"),
    })
  }, 30000)
})

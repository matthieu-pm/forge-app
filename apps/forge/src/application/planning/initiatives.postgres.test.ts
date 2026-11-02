// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import type { Actor } from "@/application/actor"
import type * as Initiatives from "./initiatives.server"
import type * as Projects from "./projects.server"
import type * as Issues from "../issues/issues.server"
import { blankInitiative } from "@/lib/initiatives"
import { initiativeFields } from "@/lib/shared-initiative-contract"
import { blankIssueDraft } from "@/lib/issue-record-contract"

const file = process.env.FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE
describe.skipIf(!file)("FOR-59 shared initiatives on PostgreSQL", () => {
  const marker = `for59-${randomUUID()}`,
    userIds = [`${marker}-alice`, `${marker}-bob`],
    workspaces: Array<string> = []
  let initiativeService: typeof Initiatives,
    pool: Pool,
    projects: typeof Projects,
    issues: typeof Issues
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
    vi.stubEnv("FORGE_FEATURE_INITIATIVES", "true")
    initiativeService = await import("./initiatives.server")
    projects = await import("./projects.server")
    issues = await import("../issues/issues.server")
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

  const createInitiative = async (
    actor: Actor,
    projectIds: Array<string> = []
  ) => {
    const id = randomUUID()
    await initiativeService.saveCanonicalInitiatives(actor, randomUUID(), [
      {
        id,
        expectedRevision: null,
        changes: initiativeFields
          .strip()
          .parse({ ...blankInitiative(actor.userId), name: "Shared strategy" }),
        addProjectIds: projectIds,
      },
    ])
    return (
      await initiativeService.readCanonicalInitiatives(actor)
    ).initiatives.find((i) => i.id === id)!
  }
  const get = async (actor: Actor, id: string) =>
    (await initiativeService.readCanonicalInitiatives(actor)).initiatives.find(
      (i) => i.id === id
    )!
  const change = (
    actor: Actor,
    id: string,
    expectedRevision: number,
    changes: unknown = {},
    extra = {},
    commandKey = randomUUID()
  ) =>
    initiativeService.saveCanonicalInitiatives(actor, commandKey, [
      { id, expectedRevision, changes, ...extra },
    ])

  it("AT-01: authorized canonical issue and project changes refresh shared initiative progress in both sessions", async () => {
    const f = await fixture(),
      a = randomUUID(),
      b = randomUUID()
    await save(f.actors[1], [
      ...create(a, [f.teamId]),
      ...create(b, [f.teamId]),
    ])
    const initiative = await createInitiative(f.actors[1], [a, b])
    const first = await link(f.actors[1], f.teamId, a),
      second = await link(f.actors[1], f.teamId, b)
    expect((await get(f.actors[0], initiative.id)).rollup).toMatchObject({
      projectCount: 2,
      issueCount: 2,
      completedIssues: 0,
      percent: 0,
    })
    const { editCanonicalIssues } = await import("../issues/edit-issues.server")
    await editCanonicalIssues(f.actors[1], {
      commandKey: randomUUID(),
      teamId: f.teamId,
      edits: [
        {
          issueId: first.issue.id,
          expectedRevision: first.issue.revision!,
          changes: { status: "done" },
        },
      ],
    })
    const expected = {
      projectCount: 2,
      issueCount: 2,
      completedIssues: 1,
      percent: 50,
    }
    expect((await get(f.actors[0], initiative.id)).rollup).toMatchObject(
      expected
    )
    expect((await get(f.actors[1], initiative.id)).rollup).toMatchObject(
      expected
    )
    await save(f.actors[1], [
      {
        id: b,
        expectedRevision: (await project(f.actors[1], b))!.revision,
        changes: { status: "Completed" },
      },
    ])
    expect(
      (await get(f.actors[0], initiative.id)).rollup?.completedProjects
    ).toBe(1)
    await pool.query("UPDATE issues SET archived_at=now() WHERE id=$1", [
      second.issue.id,
    ])
    expect((await get(f.actors[1], initiative.id)).rollup).toMatchObject({
      issueCount: 1,
      completedIssues: 1,
      percent: 100,
    })
  }, 30000)
  it("AT-02: filters children, teams and aggregates without hidden-count hints, preserving unreadable membership on edits", async () => {
    const f = await fixture(),
      mixed = randomUUID(),
      hidden = randomUUID()
    await save(f.actors[0], [
      ...create(mixed, [f.teamId, f.privateTeam]),
      ...create(hidden, [f.privateTeam]),
    ])
    await link(f.actors[0], f.teamId, mixed)
    await link(f.actors[0], f.privateTeam, mixed, "Private issue title")
    await link(f.actors[0], f.privateTeam, hidden, "Secret child title")
    const initiative = await createInitiative(f.actors[0], [mixed, hidden])
    const member = await get(f.actors[1], initiative.id)
    expect(member.projects.map((p) => p.id)).toEqual([mixed])
    expect(member.projects[0].teamIds).toEqual([f.teamId])
    expect(member.rollup).toMatchObject({ projectCount: 1, issueCount: 1 })
    expect(JSON.stringify(member)).not.toContain(hidden)
    expect(JSON.stringify(member)).not.toContain(f.privateTeam)
    expect((await get(f.actors[0], initiative.id)).rollup).toMatchObject({
      projectCount: 2,
      issueCount: 3,
    })
    await change(
      f.actors[1],
      member.id,
      member.revision!,
      { summary: "Member edit" },
      { removeProjectIds: [mixed] }
    )
    const admin = await get(f.actors[0], initiative.id)
    expect(admin.projects.map((p) => p.id)).toEqual([hidden])
    const empty = await get(f.actors[1], initiative.id)
    expect(empty.name).toBe("Shared strategy")
    expect(empty.projects).toEqual([])
    expect(empty.rollup).toMatchObject({ projectCount: 0, issueCount: 0 })
  }, 30000)
  it("rejects private and foreign link edits, stale revisions and atomic stale batches", async () => {
    const f = await fixture(),
      foreign = await fixture(),
      hidden = randomUUID()
    await save(f.actors[0], create(hidden, [f.privateTeam]))
    const i = await createInitiative(f.actors[1]),
      j = await createInitiative(f.actors[1])
    await expect(
      change(f.actors[1], i.id, i.revision!, {}, { addProjectIds: [hidden] })
    ).rejects.toThrow()
    await expect(
      change(foreign.actors[0], i.id, i.revision!, { name: "Foreign" })
    ).rejects.toThrow()
    await change(f.actors[0], i.id, i.revision!, { name: "First" })
    await expect(
      initiativeService.saveCanonicalInitiatives(f.actors[1], randomUUID(), [
        {
          id: j.id,
          expectedRevision: j.revision,
          changes: { name: "Rollback" },
        },
        { id: i.id, expectedRevision: i.revision, changes: { name: "Stale" } },
      ])
    ).rejects.toThrow(/changed in another session/)
    expect((await get(f.actors[1], j.id)).name).toBe("Shared strategy")
    const latest = await get(f.actors[1], i.id)
    const competing = await Promise.allSettled(
      ["one", "two"].map((name) =>
        change(f.actors[1], i.id, latest.revision!, { name })
      )
    )
    expect(competing.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  }, 30000)
  it("uses one immutable receipt and reauthorizes linked project/session access on replay", async () => {
    const f = await fixture(),
      p = randomUUID()
    await save(f.actors[1], create(p, [f.teamId]))
    const i = await createInitiative(f.actors[1]),
      key = randomUUID()
    const payload = [
      {
        id: i.id,
        expectedRevision: i.revision,
        changes: { summary: "Once" },
        addProjectIds: [p],
      },
    ]
    await initiativeService.saveCanonicalInitiatives(f.actors[1], key, payload)
    expect(
      (
        await initiativeService.saveCanonicalInitiatives(
          f.actors[1],
          key,
          payload
        )
      ).replayed
    ).toBe(true)
    await expect(
      initiativeService.saveCanonicalInitiatives(f.actors[1], key, [
        { ...payload[0], changes: { summary: "Different" } },
      ])
    ).rejects.toThrow()
    await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
      f.teamId,
    ])
    await expect(
      initiativeService.saveCanonicalInitiatives(f.actors[1], key, payload)
    ).rejects.toThrow()
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, userIds[1]]
    )
    await expect(
      initiativeService.readCanonicalInitiatives(f.actors[1])
    ).rejects.toThrow()
  }, 30000)
  it("attributes shared updates/comments, enforces author moderation and actor-owned reactions", async () => {
    const f = await fixture(),
      i = await createInitiative(f.actors[1])
    const post = {
      id: randomUUID(),
      text: "Shared update",
      health: "On track",
      authorId: userIds[0],
      createdAt: "2000-01-01T00:00:00.000Z",
      attachments: [],
      reactions: [],
      comments: [],
    }
    await change(f.actors[1], i.id, i.revision!, { updates: [post] })
    let current = await get(f.actors[0], i.id)
    expect(current.updates[0].authorId).toBe(userIds[1])
    expect(current.updates[0].createdAt).not.toBe(post.createdAt)
    await change(f.actors[0], i.id, current.revision!, {
      updates: [
        {
          ...current.updates[0],
          text: "Admin edit",
          comments: [{ ...post, id: randomUUID(), text: "Admin reply" }],
        },
      ],
    })
    current = await get(f.actors[1], i.id)
    expect(current.updates[0].comments[0].authorId).toBe(userIds[0])
    await expect(
      change(f.actors[1], i.id, current.revision!, {
        updates: [{ ...current.updates[0], comments: [] }],
      })
    ).rejects.toThrow()
    await expect(
      change(f.actors[1], i.id, current.revision!, {
        updates: [
          {
            ...current.updates[0],
            reactions: [{ emoji: "👍", userIds: [userIds[0]] }],
          },
        ],
      })
    ).rejects.toThrow()
    await change(f.actors[1], i.id, current.revision!, {
      updates: [
        {
          ...current.updates[0],
          reactions: [{ emoji: "👍", userIds: [userIds[1]] }],
        },
      ],
      comments: [{ ...post, id: randomUUID(), text: "Top-level comment" }],
    })
    const shared = await get(f.actors[0], i.id)
    expect(shared.comments[0].authorId).toBe(userIds[1])
    expect(shared.updates[0].reactions[0].userIds).toEqual([userIds[1]])
  }, 30000)
  it("denies disabled feature and undeclared external transports; validates owners and attachment scope", async () => {
    const f = await fixture(),
      i = await createInitiative(f.actors[1])
    await expect(
      change(f.actors[1], i.id, i.revision!, { ownerId: "foreign-member" })
    ).rejects.toThrow()
    await expect(
      initiativeService.readCanonicalInitiatives({
        ...f.actors[1],
        scopes: ["projects:read"],
      })
    ).rejects.toThrow()
    vi.stubEnv("FORGE_FEATURE_INITIATIVES", "false")
    expect(
      (await initiativeService.readCanonicalInitiatives(f.actors[1]))
        .initiatives
    ).toEqual([])
    await expect(
      change(f.actors[1], i.id, i.revision!, { name: "Disabled" })
    ).rejects.toThrow()
    vi.stubEnv("FORGE_FEATURE_INITIATIVES", "true")
    await expect(
      change(f.actors[1], i.id, i.revision!, {
        comments: [
          {
            id: randomUUID(),
            text: "attachment",
            authorId: userIds[1],
            createdAt: new Date().toISOString(),
            attachments: [
              {
                id: randomUUID(),
                name: "bad",
                mime: "text/plain",
                data: "data:text/plain;base64,YQ==",
              },
            ],
            reactions: [],
          },
        ],
      })
    ).rejects.toThrow(/attachments/)
  }, 30000)
  it("review: a departed initiative owner does not block unrelated metadata or activity changes", async () => {
    const f = await fixture(),
      i = await createInitiative(f.actors[0])
    await change(f.actors[0], i.id, i.revision!, { ownerId: userIds[1] })
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, userIds[1]]
    )
    let current = await get(f.actors[0], i.id)
    await change(f.actors[0], i.id, current.revision!, {
      summary: "Owner has left",
    })
    current = await get(f.actors[0], i.id)
    await change(f.actors[0], i.id, current.revision!, {
      comments: [
        {
          id: randomUUID(),
          text: "Still collaborates",
          authorId: userIds[0],
          createdAt: new Date().toISOString(),
          attachments: [],
          reactions: [],
        },
      ],
    })
    current = await get(f.actors[0], i.id)
    expect(current.summary).toBe("Owner has left")
    expect(current.comments[0].text).toBe("Still collaborates")
    await expect(
      change(f.actors[0], i.id, current.revision!, { ownerId: userIds[1] })
    ).rejects.toThrow()
  }, 30000)
})

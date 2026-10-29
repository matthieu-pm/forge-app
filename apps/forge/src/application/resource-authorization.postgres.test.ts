// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  assertIsolatedTestConnection,
  verifyIsolatedTestIdentity,
} from "../../scripts/lib/isolated-test-database"
import type { Actor } from "./actor"
import type * as Queries from "./planning/queries.server"
import type * as Database from "@/db"

const identity = vi.hoisted(() => ({
  actor: null as Actor | null,
  verify: vi.fn(),
  mail: vi.fn(),
}))
// Authentication seams only: all authorization, credentials, sessions and resources use real SQL.
vi.mock("@/adapters/auth/session-actor.server", () => ({
  requireSessionActor: async () => identity.actor!,
}))
vi.mock("@/lib/auth", () => ({
  auth: { api: { verifyApiKey: identity.verify } },
}))
vi.mock("@/application/mail/auth-emails.server", () => ({
  sendWorkspaceInvitationEmail: identity.mail,
}))

const file = process.env.FORGE_AUTHZ_TEST_DATABASE_FILE
describe.skipIf(!file)("FOR-39 live authorization acceptance", () => {
  const marker = `for39-${randomUUID()}`
  const w = [marker, `${marker}-foreign`]
  const user = ["owner", "member", "private", "foreign"].map(
    (n) => `${marker}-${n}`
  )
  const team = Array.from({ length: 4 }, () => randomUUID())
  const project = Array.from({ length: 4 }, () => randomUUID())
  const issue = Array.from({ length: 4 }, () => randomUUID())
  const doc = Array.from({ length: 4 }, () => randomUUID())
  const initiative = randomUUID(),
    label = randomUUID(),
    privateLabel = randomUUID()
  const artifact = randomUUID(),
    attachment = randomUUID()
  const thread = randomUUID(),
    run = randomUUID(),
    invitation = randomUUID(),
    businessRun = randomUUID()
  let pool: Pool, appPool: Pool, database: typeof Database, q: typeof Queries
  let verified = false
  const cleanup: { pool?: Pool; appPool?: Pool; database?: typeof Database } =
    {}
  const actor = (index = 1, extra: Partial<Actor> = {}): Actor => ({
    workspaceId: index === 3 ? w[1] : w[0],
    userId: user[index],
    workspaceRole: index === 0 || index === 3 ? "owner" : "member",
    authentication: { kind: "session", sessionId: `${user[index]}-session` },
    scopes: null,
    ...extra,
  })
  const keyActor = (index = 1): Actor =>
    actor(index, {
      authentication: { kind: "apiKey", credentialId: `${user[index]}-key` },
      scopes: [
        "teams:read",
        "teams:write",
        "issues:read",
        "issues:write",
        "projects:read",
      ],
    })
  const request = (path: string, index = 1, method = "GET", body?: unknown) =>
    new Request(`https://forge.test/api/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${index}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  beforeAll(async () => {
    const { connection, applicationConnection } = JSON.parse(
      readFileSync(file!, "utf8")
    )
    const target = assertIsolatedTestConnection(connection)
    assertIsolatedTestConnection(applicationConnection)
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: connection })
    cleanup.pool = pool
    await verifyIsolatedTestIdentity(pool, target)
    verified = true
    appPool = new Pool({ connectionString: applicationConnection })
    cleanup.appPool = appPool
    await verifyIsolatedTestIdentity(appPool, target)
    expect(
      (await appPool.query("SELECT current_user AS role")).rows[0].role
    ).toBe("forge_staging_web")
    vi.stubEnv("DATABASE_URL", applicationConnection)
    vi.stubEnv("PUBLIC_API_ENABLED", "true")
    vi.stubEnv(
      "FORGE_AGENT_CAPABILITY_SECRET",
      "for39-fixture-secret-01234567890123456789"
    )
    database = await import("@/db")
    cleanup.database = database
    q = await import("./planning/queries.server")
    for (const id of w) {
      await pool.query(
        "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
        [id]
      )
      await pool.query(
        "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'basic','active')",
        [id]
      )
    }
    for (let i = 0; i < user.length; i++) {
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [user[i], `${user[i]}@example.test`]
      )
      await pool.query(
        "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)",
        [
          randomUUID(),
          i === 3 ? w[1] : w[0],
          user[i],
          i === 0 || i === 3 ? "owner" : "member",
        ]
      )
      await pool.query(
        "INSERT INTO session(id,token,user_id,expires_at,active_organization_id) VALUES($1,$1,$2,now()+interval '1 day',$3)",
        [`${user[i]}-session`, user[i], i === 3 ? w[1] : w[0]]
      )
      await pool.query(
        "INSERT INTO apikey(id,config_id,reference_id,key,permissions,metadata) VALUES($1,'forge-api',$2,$1,$3,$4)",
        [
          `${user[i]}-key`,
          user[i],
          JSON.stringify({
            teams: ["read", "write"],
            issues: ["read", "write"],
            projects: ["read"],
          }),
          JSON.stringify({ workspaceId: i === 3 ? w[1] : w[0] }),
        ]
      )
    }
    for (let i = 0; i < team.length; i++)
      await pool.query(
        "INSERT INTO teams(id,workspace_id,slug,identifier,name,icon_kind,icon_value,color,timezone,visibility,created_by_user_id) VALUES($1,$2,$3,$3,$4,'icon','fixture','#000000','UTC',$5,$6)",
        [
          team[i],
          i === 3 ? w[1] : w[0],
          `T${i}`,
          i === 0 ? "public" : "private-secret",
          i === 0 ? "workspace" : "private",
          user[0],
        ]
      )
    await pool.query(
      "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
      [w[0], team[1], user[2]]
    )
    for (let i = 0; i < project.length; i++)
      await pool.query(
        "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)",
        [
          project[i],
          i === 3 ? w[1] : w[0],
          i === 1 ? "private-project-secret" : "shared-project",
        ]
      )
    for (const [p, t] of [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 2],
      [3, 3],
    ])
      await pool.query(
        "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
        [p === 3 ? w[1] : w[0], project[p], team[t]]
      )
    for (let i = 0; i < issue.length; i++)
      await pool.query(
        "INSERT INTO issues(id,workspace_id,team_id,number,title,project_id) VALUES($1,$2,$3,$4,$5,$6)",
        [
          issue[i],
          i === 3 ? w[1] : w[0],
          team[i === 2 ? 0 : i],
          i + 1,
          i === 1 ? "private-issue-secret" : "public-issue",
          project[i === 1 || i === 2 ? 0 : i],
        ]
      )
    await pool.query("UPDATE issues SET parent_id=$1 WHERE id=$2", [
      issue[1],
      issue[0],
    ])
    await pool.query(
      "INSERT INTO issue_relations(workspace_id,issue_id,related_issue_id,kind) VALUES($1,$2,$3,'related'),($1,$2,$4,'blocks')",
      [w[0], issue[0], issue[1], issue[2]]
    )
    await pool.query(
      "INSERT INTO initiatives(id,workspace_id,name) VALUES($1,$2,'shared initiative')",
      [initiative, w[0]]
    )
    for (const p of project.slice(0, 2))
      await pool.query(
        "INSERT INTO initiative_projects(workspace_id,initiative_id,project_id) VALUES($1,$2,$3)",
        [w[0], initiative, p]
      )
    await pool.query(
      "INSERT INTO resource_labels(id,workspace_id,name) VALUES($1,$2,'workspace label')",
      [label, w[0]]
    )
    await pool.query(
      "INSERT INTO resource_labels(id,workspace_id,team_id,name) VALUES($1,$2,$3,'private-label-secret')",
      [privateLabel, w[0], team[1]]
    )
    for (const i of issue.slice(0, 2))
      await pool.query(
        "INSERT INTO issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3)",
        [w[0], i, label]
      )
    await pool.query(
      "INSERT INTO documents(id,workspace_id,title,issue_id) VALUES($1,$2,'private-doc-secret',$3)",
      [doc[0], w[0], issue[1]]
    )
    await pool.query(
      "INSERT INTO documents(id,workspace_id,title,project_id) VALUES($1,$2,'project document',$3)",
      [doc[1], w[0], project[1]]
    )
    await pool.query(
      "INSERT INTO documents(id,workspace_id,title) VALUES($1,$2,'workspace document'),($3,$4,'foreign document')",
      [doc[2], w[0], doc[3], w[1]]
    )
    await pool.query(
      "INSERT INTO agent_threads(id,workspace_id,created_by_user_id,title) VALUES($1,$2,$3,'fixture')",
      [thread, w[0], user[0]]
    )
    await pool.query(
      "INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'running','forge-native','{}')",
      [run, thread, user[0]]
    )
    await pool.query(
      "INSERT INTO invitation(id,organization_id,email,role,expires_at,inviter_id) VALUES($1,$2,$3,'member',now()+interval '2 days',$4)",
      [invitation, w[0], `${marker}-invite@example.test`, user[0]]
    )
    await pool.query(
      "INSERT INTO business_workflow_runs(id,workspace_id,kind,subject_type,subject_id,idempotency_key) VALUES($1,$2,'workspace-invitation','invitation',$3,$4)",
      [businessRun, w[0], invitation, marker]
    )
    await pool.query(
      "INSERT INTO agent_artifacts(id,run_id,kind,name,content_type,size_bytes,storage_reference,checksum) VALUES($1,$2,'file','fixture.txt','text/plain',4,$3,$4)",
      [artifact, run, marker, "a".repeat(64)]
    )
    await pool.query(
      "INSERT INTO agent_attachments(id,workspace_id,user_id,name,content_type,size_bytes,storage_reference,checksum,expires_at) VALUES($1,$2,$3,'fixture.txt','text/plain',4,$4,$5,now()+interval '1 day')",
      [attachment, w[0], user[0], marker, "a".repeat(64)]
    )
    identity.verify.mockImplementation(
      async ({ body }: { body: { key: string } }) => {
        const i = Number(body.key),
          record = (
            await pool.query("SELECT * FROM apikey WHERE id=$1", [
              `${user[i]}-key`,
            ])
          ).rows[0]
        return {
          valid: !!record?.enabled,
          key: record
            ? {
                id: record.id,
                referenceId: record.reference_id,
                metadata: JSON.parse(record.metadata),
                permissions: JSON.parse(record.permissions),
              }
            : null,
        }
      }
    )
    identity.mail.mockResolvedValue({ id: "fixture-delivery" })
  }, 60_000)
  afterAll(async () => {
    try {
      if (verified && cleanup.pool) {
        await cleanup.pool.query(
          "DELETE FROM organization WHERE id=ANY($1::text[])",
          [w]
        )
        await cleanup.pool.query(
          'DELETE FROM "user" WHERE id=ANY($1::text[])',
          [user]
        )
        expect(
          (
            await cleanup.pool.query(
              "SELECT id FROM organization WHERE id=ANY($1::text[])",
              [w]
            )
          ).rows
        ).toEqual([])
      }
    } finally {
      await cleanup.database?.databaseClient.end()
      await cleanup.appPool?.end()
      await cleanup.pool?.end()
      vi.unstubAllEnvs()
    }
  }, 30_000)

  it("filters canonical issue/project lists, search and export before pagination", async () => {
    const visible = [issue[0], issue[2]].sort()
    const first = await q.listPlanningResources(actor(), "issue", { limit: 1 })
    expect(first.items.map((r) => r.id)).toEqual(visible.slice(0, 1))
    const next = await q.exportPlanningPage(actor(), "issue", {
      limit: 1,
      after: first.nextCursor!,
    })
    expect(next.items.map((r) => r.id)).toEqual(visible.slice(1))
    expect(next.nextCursor).toBeNull()
    expect(
      (await q.listPlanningResources(actor(), "issue", { search: "secret" }))
        .items
    ).toEqual([])
    expect(
      (await q.listPlanningResources(actor(), "project")).items
        .map((r) => r.id)
        .sort()
    ).toEqual([project[0], project[2]].sort())
  })
  it("redacts private parent IDs and denies private/foreign direct reads", async () => {
    expect(
      await q.getPlanningResource(actor(), "issue", issue[0])
    ).toMatchObject({ parentId: null })
    expect(await q.getPlanningResource(actor(), "issue", issue[1])).toBeNull()
    expect(await q.getPlanningResource(actor(0), "issue", issue[3])).toBeNull()
    expect(
      await q.getPlanningResource(actor(), "project", project[1])
    ).toBeNull()
    expect(
      await q.getPlanningResource(actor(2), "project", project[1])
    ).toMatchObject({ id: project[1] })
    expect(await q.listIssueRelations(actor(), issue[0])).toEqual([
      { id: issue[2], kind: "blocks" },
    ])
    expect(await q.listIssueDocuments(actor(), issue[1])).toEqual([])
  })
  it("filters project/initiative/label counts and participating team metadata", async () => {
    expect(await q.planningRollup(actor(), "project", project[0])).toEqual({
      issueCount: 2,
    })
    expect(await q.planningRollup(actor(0), "project", project[0])).toEqual({
      issueCount: 3,
    })
    expect(await q.planningRollup(actor(), "initiative", initiative)).toEqual({
      issueCount: 2,
    })
    expect(await q.listInitiativeProjects(actor(), initiative)).toEqual([
      { id: project[0], title: "shared-project" },
    ])
    expect(await q.listProjectTeams(actor(), project[0])).toEqual([
      { teamId: team[0] },
    ])
    expect(await q.planningRollup(actor(), "label", label)).toEqual({
      issueCount: 1,
    })
    expect(
      (await q.listPlanningResources(actor(), "label")).items.map((r) => r.id)
    ).toEqual([label])
  })
  it("only allows live owners/admins to share documents and redacts their origins", async () => {
    expect(await q.getPlanningResource(actor(), "document", doc[0])).toBeNull()
    await expect(
      q.shareDocumentWithWorkspace(actor(2), doc[0], true)
    ).rejects.toThrow()
    await expect(
      q.shareDocumentWithWorkspace(actor(3), doc[0], true)
    ).rejects.toThrow()
    await q.shareDocumentWithWorkspace(actor(0), doc[0], true)
    expect(
      await q.getPlanningResource(actor(), "document", doc[0])
    ).toMatchObject({
      id: doc[0],
      issueId: null,
      teamId: null,
      projectId: null,
    })
    expect(await q.getPlanningResource(actor(), "issue", issue[1])).toBeNull()
    await q.shareDocumentWithWorkspace(actor(0), doc[0], false)
    expect(await q.getPlanningResource(actor(), "document", doc[0])).toBeNull()
  })
  it("requires resource scopes independently of team-directory access", async () => {
    const a = { ...keyActor(), scopes: ["issues:read" as const] }
    expect((await q.listPlanningResources(a, "issue")).items).toHaveLength(2)
    await expect(q.listPlanningResources(a, "project")).rejects.toThrow()
    await expect(
      q.getPlanningResource(keyActor(0), "document", doc[0])
    ).rejects.toThrow()
  })
  it("denies the same private/foreign read through web, REST and signed agent HTTP", async () => {
    const web = await import("@/lib/team-server"),
      api = await import("@/api/v1/handler.server")
    const { handleCapabilityRequest } =
      await import("./agents/capability-http-handler.server")
    const { mintAgentCapabilityToken } =
      await import("./agents/run-token.server")
    // Owner's signed token carries a deliberately stale ordinary role; current SQL role wins.
    const token = await mintAgentCapabilityToken({
      actor: actor(0, { workspaceRole: "member" }),
      runId: run,
      capabilities: ["teams.get"],
    })
    identity.actor = actor()
    expect(
      await web.getTeamForRequest(new Request("https://forge.test"), "T1")
    ).toBeNull()
    for (const id of [team[1], team[3]]) {
      const response = await api.handlePublicApiRequest(request(`teams/${id}`))
      expect(response.status).toBe(404)
      expect(JSON.stringify(await response.json())).not.toContain(
        "private-secret"
      )
    }
    // Demote the signed owner token after minting: private team read must disappear.
    await pool.query(
      "UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2",
      [w[0], user[0]]
    )
    try {
      const response = await handleCapabilityRequest(
        new Request("https://forge.test/api/agent/capabilities/teams.get", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "x-forge-agent-run-id": run,
            "x-forge-workspace-id": w[0],
            "content-type": "application/json",
          },
          body: JSON.stringify({ version: "1", input: { id: team[1] } }),
        }),
        "teams.get"
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toBeNull()
    } finally {
      await pool.query(
        "UPDATE member SET role='owner' WHERE organization_id=$1 AND user_id=$2",
        [w[0], user[0]]
      )
    }
  })
  it("denies forbidden writes across session, REST and a delayed signed tool", async () => {
    const teams = await import("./teams/teams.server"),
      api = await import("@/api/v1/handler.server")
    const { mintAgentCapabilityToken, verifyAgentCapabilityToken } =
      await import("./agents/run-token.server")
    const { forgeCapabilityGateway } =
      await import("@/adapters/agents/forge-capabilities.server")
    expect(
      await teams.updateTeam(actor(), { id: team[1] }, { name: "forbidden" })
    ).toMatchObject({ ok: false, code: "FORBIDDEN" })
    expect(
      (
        await api.handlePublicApiRequest(
          request(`teams/${team[1]}`, 1, "PATCH", {
            settings: { name: "forbidden" },
          })
        )
      ).status
    ).toBe(403)
    const token = await mintAgentCapabilityToken({
      actor: actor(0),
      runId: run,
      capabilities: ["teams.update"],
    })
    const stale = await verifyAgentCapabilityToken(token, {
      runId: run,
      workspaceId: w[0],
      capabilityId: "teams.update",
    })
    await pool.query(
      "UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2",
      [w[0], user[0]]
    )
    try {
      expect(
        await forgeCapabilityGateway.invoke(
          stale,
          {
            capabilityId: "teams.update",
            capabilityVersion: "1",
            input: { slug: "T1", settings: { name: "forbidden" } },
            idempotencyKey: randomUUID(),
            approvalId: randomUUID(),
          },
          { runId: run }
        )
      ).toMatchObject({ ok: false, errorCode: "FORBIDDEN" })
      expect(
        (await pool.query("SELECT name FROM teams WHERE id=$1", [team[1]]))
          .rows[0].name
      ).toBe("private-secret")
    } finally {
      await pool.query(
        "UPDATE member SET role='owner' WHERE organization_id=$1 AND user_id=$2",
        [w[0], user[0]]
      )
    }
  })
  it("applies the same private-team boundary to Calls, templates and recurring settings", async () => {
    const calls = await import("./calls/calls.server")
    const templates = await import("./templates/templates.server")
    const recurring = await import("./recurring-issues/recurring-issues.server")
    const callId = randomUUID()
    await pool.query(
      "INSERT INTO calls(id,workspace_id,team_id,provider,external_id,title,started_at,status) VALUES($1,$2,$3,'upload',$4,'private-call-secret',now(),'ready')",
      [callId, w[0], team[1], marker]
    )
    expect(JSON.stringify(await calls.listCalls(actor()))).not.toContain(
      "private-call-secret"
    )
    await expect(calls.readCall(actor(), callId)).rejects.toThrow()
    await expect(templates.loadDirectory(actor(), "T1")).rejects.toThrow()
    await expect(recurring.loadRecurringIssues(actor(), "T1")).rejects.toThrow()
    expect(await calls.readCall(actor(0), callId)).toMatchObject({ id: callId })
  })
  it("keeps unimplemented public planning transports unavailable", async () => {
    const { handlePublicApiRequest } = await import("@/api/v1/handler.server")
    for (const path of ["issues", "projects", "initiatives", "documents"])
      expect((await handlePublicApiRequest(request(path, 0))).status).toBe(404)
  })
  it("authorizes file grants by the owning workspace and user", async () => {
    const { forgeArtifactService } =
      await import("@/adapters/agents/forge-capabilities.server")
    const { DrizzleAgentAttachmentStore } =
      await import("@/adapters/agents/drizzle-attachment-store.server")
    expect(
      await forgeArtifactService.createDownload(actor(0), artifact)
    ).toMatchObject({ artifact: { id: artifact }, expiresInSeconds: 300 })
    await expect(
      forgeArtifactService.createDownload(actor(), artifact)
    ).rejects.toThrow()
    await expect(
      forgeArtifactService.createDownload(actor(3), artifact)
    ).rejects.toThrow()
    expect(
      await new DrizzleAgentAttachmentStore().getAuthorized(w[0], user[0], [
        attachment,
      ])
    ).toHaveLength(1)
  })
  it("rejects forged workspace selection and expired sessions before returning canonical data", async () => {
    await expect(
      q.listPlanningResources(actor(0, { workspaceId: w[1] }), "issue")
    ).rejects.toThrow()
    await pool.query(
      "UPDATE session SET expires_at=now()-interval '1 second' WHERE id=$1",
      [`${user[1]}-session`]
    )
    await expect(q.listPlanningResources(actor(), "issue")).rejects.toThrow()
    await pool.query(
      "UPDATE session SET expires_at=now()+interval '1 day' WHERE id=$1",
      [`${user[1]}-session`]
    )
  })
  it("rejects revoked team membership, credential scopes and inactive runs", async () => {
    await pool.query(
      "DELETE FROM team_members WHERE team_id=$1 AND user_id=$2",
      [team[1], user[2]]
    )
    expect(await q.getPlanningResource(actor(2), "issue", issue[1])).toBeNull()
    await pool.query("UPDATE apikey SET permissions='{}' WHERE id=$1", [
      `${user[1]}-key`,
    ])
    await expect(q.listPlanningResources(keyActor(), "issue")).rejects.toThrow()
    await pool.query("UPDATE apikey SET enabled=false WHERE id=$1", [
      `${user[1]}-key`,
    ])
    await expect(q.listPlanningResources(keyActor(), "issue")).rejects.toThrow()
    await pool.query("UPDATE agent_runs SET state='cancelled' WHERE id=$1", [
      run,
    ])
    const { requireCurrentActor } = await import("./resource-policy.server")
    await expect(
      requireCurrentActor(
        actor(0, {
          authentication: { kind: "agent", runId: run, tokenId: randomUUID() },
          scopes: ["teams:read"],
        })
      )
    ).rejects.toThrow()
  })
  it("rechecks inviter authority at the actual durable email step before any effect", async () => {
    const { sendInvitationEffectStep } =
      await import("@/workflows/invitation-workflow-steps")
    await pool.query(
      "UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2",
      [w[0], user[0]]
    )
    try {
      await expect(
        sendInvitationEffectStep(businessRun, "initial")
      ).rejects.toThrow("no longer has permission")
      expect(identity.mail).not.toHaveBeenCalled()
      expect(
        (
          await pool.query(
            "SELECT id FROM business_workflow_effects WHERE business_run_id=$1",
            [businessRun]
          )
        ).rows
      ).toEqual([])
    } finally {
      await pool.query(
        "UPDATE member SET role='owner' WHERE organization_id=$1 AND user_id=$2",
        [w[0], user[0]]
      )
    }
    await sendInvitationEffectStep(businessRun, "initial")
    expect(identity.mail).toHaveBeenCalledTimes(1)
    // A completed receipt is not a grant after removal, either.
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [w[0], user[0]]
    )
    await expect(
      sendInvitationEffectStep(businessRun, "initial")
    ).rejects.toThrow("no longer has permission")
    expect(identity.mail).toHaveBeenCalledTimes(1)
    await expect(q.listPlanningResources(actor(0), "issue")).rejects.toThrow()
    const { forgeArtifactService } =
      await import("@/adapters/agents/forge-capabilities.server")
    const { DrizzleAgentAttachmentStore } =
      await import("@/adapters/agents/drizzle-attachment-store.server")
    await expect(
      forgeArtifactService.createDownload(actor(0), artifact)
    ).rejects.toThrow()
    await expect(
      forgeArtifactService.read(actor(0), artifact)
    ).rejects.toThrow()
    expect(
      await new DrizzleAgentAttachmentStore().getAuthorized(w[0], user[0], [
        attachment,
      ])
    ).toEqual([])
  })
})

// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import type { Actor } from "@/application/actor"
import type * as Service from "./team-resources.server"
import type * as Documents from "../documents/documents.server"
import { emptyDocumentBody } from "@/lib/document-contract"
import { defaultDocumentIcon } from "@/lib/team-documents"

const file =
  process.env.FORGE_RESOURCE_TEST_DATABASE_FILE ??
  process.env.FORGE_LOOP_TEST_DATABASE_FILE
const blank = () => ({ sections: [], links: [], order: [] })
describe.skipIf(!file)("FOR-62 shared team resources on PostgreSQL", () => {
  const marker = `for62-resources-${randomUUID()}`,
    users = [marker + "-alice", marker + "-bob"],
    workspaces: Array<string> = []
  let pool: Pool, service: typeof Service, docs: typeof Documents
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(file!, "utf8")),
      target = {
        environment: "resource-loop-acceptance",
        ...DATABASE_TARGETS["resource-loop-acceptance"],
      } as const
    assertMigrationTarget(config.connection, target)
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: config.connection, max: 6 })
    expect(
      (
        await pool.query(
          "SELECT current_database() db,current_setting('neon.branch_id',true) branch"
        )
      ).rows[0]
    ).toEqual({ db: target.database, branch: target.branchId })
    vi.stubEnv("DATABASE_URL", config.applicationConnection)
    vi.stubEnv("FORGE_SERVICE_ENVIRONMENT", "development")
    vi.stubEnv("FORGE_TEAM_RESOURCES_ENABLED", "true")
    vi.stubEnv("FORGE_LOOPS_ENABLED", "true")
    vi.stubEnv("FORGE_SHARED_DOCUMENTS_ENABLED", "true")
    service = await import("./team-resources.server")
    docs = await import("../documents/documents.server")
    const application = (
      await (
        await import("@/db")
      ).databaseClient.query(
        "SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole FROM pg_roles r WHERE r.rolname=current_user"
      )
    ).rows[0]
    expect(application).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    })
    for (const id of users)
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [id, id + "@example.test"]
      )
  }, 30000)
  afterAll(async () => {
    if (!pool) return
    for (const id of workspaces)
      await pool.query("DELETE FROM organization WHERE id=$1", [id])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    await pool.end()
    await (await import("@/db")).databaseClient.end()
    vi.unstubAllEnvs()
  }, 30000)
  async function fixture() {
    const workspaceId = marker + workspaces.length,
      teamId = randomUUID(),
      privateTeamId = randomUUID()
    workspaces.push(workspaceId)
    await pool.query(
      "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
      [workspaceId]
    )
    await pool.query(
      "INSERT INTO workspace_security_settings(workspace_id,loops_policy,external_loop_sources_enabled) VALUES($1,'all-members',true) ON CONFLICT(workspace_id) DO UPDATE SET loops_policy='all-members',external_loop_sources_enabled=true",
      [workspaceId]
    )
    const actors: Array<Actor> = []
    for (const userId of users) {
      const sessionId = randomUUID()
      await pool.query(
        "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'member')",
        [randomUUID(), workspaceId, userId]
      )
      await pool.query(
        "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
        [sessionId, userId, workspaceId]
      )
      actors.push({
        workspaceId,
        userId,
        workspaceRole: "member",
        authentication: { kind: "session", sessionId },
        scopes: null,
      })
    }
    for (const id of [teamId, privateTeamId])
      await pool.query(
        "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1::uuid,$2,$1::text,$1::text,$3,$4,'emoji','🔥','#94a3b8','UTC',$5)",
        [
          id,
          workspaceId,
          id.slice(0, 5),
          id === teamId ? "workspace" : "private",
          users[0],
        ]
      )
    await pool.query(
      "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member')",
      [randomUUID(), workspaceId, privateTeamId, users[0]]
    )
    return { workspaceId, teamId, privateTeamId, actors }
  }
  const command = (
    teamId: string,
    expectedRevision = 0,
    fields: any = blank()
  ) => ({ teamId, expectedRevision, fields })
  it("AT-01: two ordinary members read identical shared sections, resource order and normalized links", async () => {
    const f = await fixture(),
      sectionId = randomUUID(),
      linkId = randomUUID()
    const fields = {
      sections: [
        { id: sectionId, name: "Guides" },
        { id: randomUUID(), name: "Plans" },
      ],
      links: [
        {
          id: linkId,
          title: "Guide",
          url: " https://EXAMPLE.com/guide ",
          sectionId,
        },
      ],
      order: [`link:${linkId}`],
    }
    expect(
      await service.commandTeamResources(
        f.actors[0],
        randomUUID(),
        command(f.teamId, 0, fields)
      )
    ).toEqual({ status: "saved", revision: 1 })
    const alice = await service.readTeamResources(f.actors[0], f.teamId),
      bob = await service.readTeamResources(f.actors[1], f.teamId)
    expect(bob).toEqual(alice)
    expect(bob.links[0].url).toBe("https://example.com/guide")
    expect(
      await service.commandTeamResources(
        f.actors[1],
        randomUUID(),
        command(f.teamId, 1, {
          sections: [...alice.sections].reverse(),
          links: alice.links,
          order: alice.order,
        })
      )
    ).toEqual({ status: "saved", revision: 2 })
    expect(
      (await service.readTeamResources(f.actors[0], f.teamId)).sections.map(
        (section) => section.name
      )
    ).toEqual(["Plans", "Guides"])
  })
  it("another member's reorder survives reload and does not overwrite stale proposals", async () => {
    const f = await fixture(),
      sections = [
        { id: randomUUID(), name: "A" },
        { id: randomUUID(), name: "B" },
      ]
    await service.commandTeamResources(
      f.actors[0],
      randomUUID(),
      command(f.teamId, 0, { ...blank(), sections })
    )
    const current = await service.readTeamResources(f.actors[1], f.teamId)
    const results = await Promise.all(
      f.actors.map((actor, i) =>
        service.commandTeamResources(
          actor,
          randomUUID(),
          command(f.teamId, 1, {
            sections:
              i === 0
                ? [...sections].reverse()
                : sections.map((s) => ({ ...s, name: s.name + " changed" })),
            links: [],
            order: [],
          })
        )
      )
    )
    expect(results.filter((r) => r.status === "saved")).toHaveLength(1)
    expect(results.filter((r) => r.status === "conflict")).toHaveLength(1)
    expect(await service.readTeamResources(f.actors[0], f.teamId)).toEqual(
      await service.readTeamResources(f.actors[1], f.teamId)
    )
    expect(current.revision).toBe(1)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE workspace_id=$1 AND operation='team-resources.write@1'",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(2)
  })
  it("replays an exact lost-response request once and rejects changed input under the same key", async () => {
    const f = await fixture(),
      key = randomUUID(),
      input = command(f.teamId)
    const first = await service.commandTeamResources(f.actors[0], key, input)
    expect(await service.commandTeamResources(f.actors[0], key, input)).toEqual(
      first
    )
    await expect(
      service.commandTeamResources(f.actors[0], key, {
        ...input,
        expectedRevision: 1,
      })
    ).rejects.toThrow("different input")
    expect(
      (
        await pool.query(
          "SELECT (SELECT count(*) FROM command_receipts WHERE workspace_id=$1)::int receipts,(SELECT count(*) FROM command_audit_events WHERE workspace_id=$1)::int audits,(SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1)::int events",
          [f.workspaceId]
        )
      ).rows[0]
    ).toEqual({ receipts: 1, audits: 1, events: 1 })
  })
  it("rolls back the resource board, receipt and outbox together after a database audit fault", async () => {
    const f = await fixture(),
      suffix = randomUUID().replaceAll("-", ""),
      name = `for62_resource_fault_${suffix}`
    await pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${f.workspaceId}' AND NEW.operation = 'team-resources.write@1' THEN RAISE EXCEPTION 'FOR62_RESOURCE_AUDIT_FAULT'; END IF; RETURN NEW; END $$`
    )
    await pool.query(
      `CREATE TRIGGER ${name} BEFORE INSERT ON command_audit_events FOR EACH ROW EXECUTE FUNCTION ${name}()`
    )
    try {
      await expect(
        service.commandTeamResources(
          f.actors[0],
          randomUUID(),
          command(f.teamId)
        )
      ).rejects.toThrow()
    } finally {
      await pool.query(`DROP TRIGGER ${name} ON command_audit_events`)
      await pool.query(`DROP FUNCTION ${name}()`)
    }
    expect(await service.readTeamResources(f.actors[1], f.teamId)).toEqual({
      revision: 0,
      ...blank(),
    })
    expect(
      (
        await pool.query(
          "SELECT (SELECT count(*) FROM command_receipts WHERE workspace_id=$1)::int receipts,(SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1)::int events",
          [f.workspaceId]
        )
      ).rows[0]
    ).toEqual({ receipts: 0, events: 0 })
  })
  it("AT-02: rejects unsafe schemes, credentials and dangling section links before any business effect", async () => {
    const f = await fixture()
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,attack",
      "file:///tmp/file",
      "https://user:secret@example.com",
    ])
      await expect(
        service.commandTeamResources(
          f.actors[0],
          randomUUID(),
          command(f.teamId, 0, {
            ...blank(),
            links: [
              { id: randomUUID(), title: "Unsafe", url, sectionId: null },
            ],
          })
        )
      ).rejects.toThrow()
    await expect(
      service.commandTeamResources(
        f.actors[0],
        randomUUID(),
        command(f.teamId, 0, {
          ...blank(),
          links: [
            {
              id: randomUUID(),
              title: "Orphan",
              url: "https://example.com",
              sectionId: randomUUID(),
            },
          ],
        })
      )
    ).rejects.toThrow()
    expect(await service.readTeamResources(f.actors[1], f.teamId)).toEqual({
      revision: 0,
      ...blank(),
    })
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(0)
  })
  it("denies private-team and cross-workspace reads/writes and reauthorizes receipt replay after revocation", async () => {
    const f = await fixture(),
      g = await fixture(),
      key = randomUUID(),
      input = command(f.privateTeamId)
    await service.commandTeamResources(f.actors[0], key, input)
    await expect(
      service.readTeamResources(f.actors[1], f.privateTeamId)
    ).rejects.toThrow()
    await expect(
      service.commandTeamResources(f.actors[1], randomUUID(), input)
    ).rejects.toThrow()
    await expect(
      service.readTeamResources(g.actors[0], f.teamId)
    ).rejects.toThrow()
    await expect(
      service.commandTeamResources(g.actors[0], randomUUID(), command(f.teamId))
    ).rejects.toThrow()
    await pool.query(
      "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
      [f.workspaceId, f.privateTeamId, users[0]]
    )
    await expect(
      service.commandTeamResources(f.actors[0], key, input)
    ).rejects.toThrow()
    await expect(
      service.readTeamResources(f.actors[0], f.privateTeamId)
    ).rejects.toThrow()
  })
  it("rejects an expired session, stale workspace membership and a disabled feature", async () => {
    const f = await fixture()
    vi.stubEnv("FORGE_TEAM_RESOURCES_ENABLED", "false")
    try {
      await expect(
        service.readTeamResources(f.actors[0], f.teamId)
      ).rejects.toThrow("not enabled")
    } finally {
      vi.stubEnv("FORGE_TEAM_RESOURCES_ENABLED", "true")
      vi.stubEnv("FORGE_LOOPS_ENABLED", "true")
    }
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, users[1]]
    )
    await expect(
      service.readTeamResources(f.actors[1], f.teamId)
    ).rejects.toThrow()
    await pool.query(
      "UPDATE session SET expires_at=now()-interval '1 hour' WHERE id=$1",
      [(f.actors[0].authentication as { sessionId: string }).sessionId]
    )
    await expect(
      service.commandTeamResources(f.actors[0], randomUUID(), command(f.teamId))
    ).rejects.toThrow()
  })
  it("keeps document section membership shared and rejects fabricated destination sections", async () => {
    const f = await fixture(),
      sectionId = randomUUID(),
      id = randomUUID()
    await service.commandTeamResources(
      f.actors[0],
      randomUUID(),
      command(f.teamId, 0, {
        ...blank(),
        sections: [{ id: sectionId, name: "Documents" }],
      })
    )
    const fields = {
      title: "Shared writing",
      body: emptyDocumentBody(),
      icon: defaultDocumentIcon,
      sectionId,
    }
    await docs.commandDocument(f.actors[0], randomUUID(), {
      action: "create",
      id,
      source: { kind: "team", id: f.teamId },
      fields,
    })
    expect(
      (
        await docs.readDocuments(f.actors[1], {
          source: { kind: "team", id: f.teamId },
        })
      )[0].sectionId
    ).toBe(sectionId)
    await expect(
      docs.commandDocument(f.actors[1], randomUUID(), {
        action: "save",
        id,
        expectedRevision: 1,
        fields: { ...fields, sectionId: randomUUID() },
      })
    ).rejects.toThrow("section is no longer available")
    await service.commandTeamResources(
      f.actors[1],
      randomUUID(),
      command(f.teamId, 1, blank())
    )
    const document = (await docs.readDocuments(f.actors[1], { id }))[0]
    expect(document.revision).toBe(1)
    expect(document.body).toEqual(fields.body)
    expect(
      (await service.readTeamResources(f.actors[0], f.teamId)).sections
    ).toEqual([])
    // Missing memberships are consistently rendered at the root; no synthetic text
    // revisions are created by deleting navigation structure.
    expect(document.sectionId).toBe(sectionId)
    await expect(
      docs.commandDocument(f.actors[0], randomUUID(), {
        action: "create",
        id: randomUUID(),
        source: { kind: "team", id: f.teamId },
        fields,
      })
    ).rejects.toThrow("section is no longer available")
  })
  it("allows shared-document content edits without revealing or modifying private source navigation", async () => {
    const f = await fixture(),
      sectionId = randomUUID(),
      id = randomUUID()
    await pool.query(
      "UPDATE member SET role='admin' WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, users[0]]
    )
    await service.commandTeamResources(
      f.actors[0],
      randomUUID(),
      command(f.privateTeamId, 0, {
        ...blank(),
        sections: [{ id: sectionId, name: "Private plans" }],
      })
    )
    const fields = {
      title: "Explicitly shared",
      body: emptyDocumentBody(),
      icon: defaultDocumentIcon,
      sectionId,
    }
    await docs.commandDocument(f.actors[0], randomUUID(), {
      action: "create",
      id,
      source: { kind: "team", id: f.privateTeamId },
      fields,
    })
    await docs.commandDocument(f.actors[0], randomUUID(), {
      action: "share",
      id,
      expectedRevision: 1,
      shared: true,
    })
    expect((await docs.readDocuments(f.actors[1], { id }))[0].title).toBe(
      "Explicitly shared"
    )
    expect(
      await docs.commandDocument(f.actors[1], randomUUID(), {
        action: "save",
        id,
        expectedRevision: 2,
        fields: { ...fields, title: "Bob's authorized content edit" },
      })
    ).toMatchObject({ status: "saved", revision: 3 })
    await expect(
      docs.commandDocument(f.actors[1], randomUUID(), {
        action: "save",
        id,
        expectedRevision: 3,
        fields: { ...fields, sectionId: null },
      })
    ).rejects.toThrow()
    await expect(
      service.readTeamResources(f.actors[1], f.privateTeamId)
    ).rejects.toThrow()
    expect((await docs.readDocuments(f.actors[0], { id }))[0].sectionId).toBe(
      sectionId
    )
  })
  async function sourceLoopFixture(f: Awaited<ReturnType<typeof fixture>>) {
    const sourceId = randomUUID(),
      loopId = randomUUID(),
      runId = randomUUID(),
      threadId = randomUUID(),
      agentRunId = randomUUID()
    const fields = {
      name: "Source retention",
      description: "Independent saved configuration",
      instructions: "Keep these independently authored instructions.",
      trigger: {
        kind: "event" as const,
        entity: "issue" as const,
        event: "updated" as const,
      },
      conditions: [],
      reasoning: "auto" as const,
      teamAccess: "this-team" as const,
    }
    await pool.query(
      "INSERT INTO issues(id,workspace_id,team_id,number,title,properties) VALUES($1,$2,$3,1,'Owned source',$4)",
      [
        sourceId,
        f.workspaceId,
        f.teamId,
        { description: "Source text subject to permanent purge" },
      ]
    )
    const loopService = await import("../loops/loops.server")
    expect(
      await loopService.commandLoop(f.actors[0], f.teamId, randomUUID(), {
        action: "create",
        id: loopId,
        fields,
      })
    ).toMatchObject({ status: "saved" })
    await pool.query(
      "UPDATE team_loops SET enabled=true,enabled_by_id=$2,enabled_at=now() WHERE id=$1",
      [loopId, users[0]]
    )
    await pool.query(
      "INSERT INTO loop_runs(id,workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id,state,thread_id,agent_run_id,result,pending_decision) VALUES($1,$2,$3,1,'retention-source','source',$4,$5,$6,'running',$7,$8,'Sensitive derived output',$9)",
      [
        runId,
        f.workspaceId,
        loopId,
        {
          entity: "issue",
          entityId: sourceId,
          context: { description: "Source text subject to permanent purge" },
        },
        fields,
        users[0],
        threadId,
        agentRunId,
        { action: "approve", summary: "Old source decision" },
      ]
    )
    const { loopPrincipalId } = await import("../loops/loop-actor.server"),
      botId = loopPrincipalId(loopId)
    await pool.query(
      "INSERT INTO agent_threads(id,workspace_id,created_by_user_id,title) VALUES($1,$2,$3,'Independent Loop title')",
      [threadId, f.workspaceId, botId]
    )
    await pool.query(
      "INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'running','forge-native',$4)",
      [agentRunId, threadId, botId, { loopRunId: runId }]
    )
    const actor: Actor = {
      workspaceId: f.workspaceId,
      userId: botId,
      workspaceRole: "member",
      authentication: { kind: "loop", loopId, runId },
      scopes: null,
    }
    return {
      sourceId,
      loopId,
      runId,
      threadId,
      agentRunId,
      botId,
      actor,
      fields,
    }
  }
  async function deleteSource(sourceId: string) {
    await pool.query(
      "UPDATE issues SET deleted_at=now()-interval '31 days' WHERE id=$1",
      [sourceId]
    )
  }
  it("reserves Loop artifact byte ownership before upload and recovers a lost publication response", async () => {
    const f = await fixture(),
      source = await sourceLoopFixture(f)
    const { AgentArtifactService } =
        await import("../agents/artifact-service.server"),
      { DrizzleAgentStore } =
        await import("@/adapters/agents/drizzle-agent-store.server"),
      { DrizzleAgentEventStore } =
        await import("@/adapters/agents/drizzle-event-store.server"),
      { DrizzleAgentArtifactStore } =
        await import("@/adapters/agents/drizzle-artifact-store.server"),
      { loopArtifactPublication } =
        await import("@/adapters/agents/loop-artifact-publication.server"),
      { requireCurrentActor } =
        await import("@/application/resource-policy.server")
    const objects = new Map<string, Uint8Array>(),
      blobs = {
        put: vi.fn(async (reference: string, content: Uint8Array) => {
          expect(
            (
              await pool.query(
                "SELECT count(*)::int n FROM loop_artifact_intents WHERE storage_reference=$1",
                [reference]
              )
            ).rows[0].n
          ).toBe(1)
          objects.set(reference, content)
        }),
        get: async (reference: string) => objects.get(reference) ?? null,
        delete: vi.fn(async (reference: string) => {
          objects.delete(reference)
        }),
      }
    const publish = vi.fn(
      async (
        actor: Actor,
        record: Parameters<typeof loopArtifactPublication.publish>[1]
      ) => {
        await loopArtifactPublication.publish(actor, record)
        throw Error("Lost commit response")
      }
    )
    const artifacts = new AgentArtifactService({
      authorizeActor: requireCurrentActor,
      metadata: new DrizzleAgentArtifactStore(),
      agents: new DrizzleAgentStore(),
      events: new DrizzleAgentEventStore(),
      blobs,
      publication: { ...loopArtifactPublication, publish },
    })
    const artifact = await artifacts.create(source.actor, source.agentRunId, {
      kind: "text",
      name: "Source report.txt",
      contentType: "text/plain",
      encoding: "utf8",
      content: "Source text subject to permanent purge",
    })
    expect(artifact.id).toBeTruthy()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(blobs.delete).not.toHaveBeenCalled()
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_artifact_intents WHERE loop_run_id=$1",
          [source.runId]
        )
      ).rows[0].n
    ).toBe(0)
    expect((await artifacts.getMetadata(source.actor, artifact.id)).id).toBe(
      artifact.id
    )
    expect((await artifacts.getMetadata(f.actors[1], artifact.id)).id).toBe(
      artifact.id
    )
    // Scope cannot be discarded when the Loop's non-login user has no membership.
    expect((await artifacts.read(source.actor, artifact.id)).content).toEqual(
      new TextEncoder().encode("Source text subject to permanent purge")
    )
    const failing = new AgentArtifactService({
      authorizeActor: requireCurrentActor,
      metadata: new DrizzleAgentArtifactStore(),
      agents: new DrizzleAgentStore(),
      events: new DrizzleAgentEventStore(),
      blobs,
      publication: {
        ...loopArtifactPublication,
        publish: async () => {
          throw Error("Publication unavailable")
        },
      },
    })
    blobs.delete.mockRejectedValueOnce(Error("Delete unavailable"))
    await expect(
      failing.create(source.actor, source.agentRunId, {
        kind: "text",
        name: "Unpublished source.txt",
        contentType: "text/plain",
        encoding: "utf8",
        content: "Unpublished source bytes",
      })
    ).rejects.toThrow("Publication unavailable")
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_artifact_intents WHERE loop_run_id=$1",
          [source.runId]
        )
      ).rows[0].n
    ).toBe(1)
    expect(objects.size).toBe(2)
    await pool.query(
      "UPDATE loop_artifact_intents SET created_at=now()-interval '1 hour' WHERE loop_run_id=$1",
      [source.runId]
    )
    const abandoned = (
      await pool.query(
        "SELECT id,storage_reference FROM loop_artifact_intents WHERE loop_run_id=$1",
        [source.runId]
      )
    ).rows[0]
    await expect(
      loopArtifactPublication.publish(await requireCurrentActor(source.actor), {
        ...artifact,
        id: abandoned.id,
        storageReference: abandoned.storage_reference,
      })
    ).rejects.toThrow("publication can no longer")
    expect(
      await loopArtifactPublication.sweepExpired(new Date(), 100, blobs)
    ).toEqual({ examined: 1, deleted: 1, failures: [] })
    expect(objects.size).toBe(1)
    await deleteSource(source.sourceId)
    await expect(
      artifacts.getMetadata(f.actors[1], artifact.id)
    ).rejects.toThrow()
    const { purgeDeletedIssues } = await import("../issues/purge-issues.server")
    expect(await purgeDeletedIssues(blobs, 1)).toEqual({ purged: 1, failed: 0 })
    expect(objects.size).toBe(0)
  }, 30000)
  it("purges Loop copies and bytes resumably after a deletion fault and fences late callbacks", async () => {
    const f = await fixture(),
      source = await sourceLoopFixture(f),
      artifactId = randomUUID(),
      intentId = randomUUID(),
      reference = `${source.agentRunId}/${artifactId}`,
      orphan = `${source.agentRunId}/${intentId}`
    const objects = new Map([
      [reference, new TextEncoder().encode("Private artifact")],
      [orphan, new TextEncoder().encode("Abandoned upload")],
    ])
    await pool.query(
      "INSERT INTO agent_artifacts(id,run_id,kind,name,content_type,size_bytes,storage_reference,checksum) VALUES($1,$2,'text','Sensitive source.txt','text/plain',16,$3,$4)",
      [artifactId, source.agentRunId, reference, "0".repeat(64)]
    )
    await pool.query(
      "INSERT INTO loop_artifact_intents(id,workspace_id,loop_run_id,agent_run_id,storage_reference,created_at) VALUES($1,$2,$3,$4,$5,now()-interval '1 hour')",
      [intentId, f.workspaceId, source.runId, source.agentRunId, orphan]
    )
    await pool.query(
      "INSERT INTO loop_events(workspace_id,team_id,entity,entity_id,event,before,after) VALUES($1,$2,'issue',$3,'updated',$4,$4)",
      [
        f.workspaceId,
        f.teamId,
        source.sourceId,
        { title: "Private source snapshot" },
      ]
    )
    await pool.query(
      "INSERT INTO agent_events(thread_id,run_id,source,source_event_id,sequence,type,payload_json,occurred_at) VALUES($1,$2,'forge','retained-source',1,'assistant.message',$3,now())",
      [
        source.threadId,
        source.agentRunId,
        { text: "Sensitive copied source text" },
      ]
    )
    const approvalId = randomUUID()
    await pool.query(
      "INSERT INTO agent_approvals(id,workspace_id,run_id,requested_for_user_id,capability_id,risk,input_hash,redacted_input_summary,nonce,expires_at) VALUES($1,$2,$3,$4,'teams.update','reversible-write',$5,$6,$7,now()+interval '1 hour')",
      [
        approvalId,
        f.workspaceId,
        source.agentRunId,
        source.botId,
        "0".repeat(64),
        { summary: "Sensitive copied approval text" },
        randomUUID(),
      ]
    )
    await deleteSource(source.sourceId)
    const { purgeDeletedIssues } = await import("../issues/purge-issues.server")
    let fail = true
    const deletes: Array<string> = []
    const blobs = {
      delete: async (key: string) => {
        deletes.push(key)
        if (key === reference && fail) {
          fail = false
          throw Error("Storage unavailable")
        }
        objects.delete(key)
      },
    }
    expect(await purgeDeletedIssues(blobs, 1)).toEqual({ purged: 0, failed: 1 })
    expect(
      (
        await pool.query("SELECT purged_at FROM issues WHERE id=$1", [
          source.sourceId,
        ])
      ).rows[0].purged_at
    ).toBeNull()
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM agent_artifacts WHERE id=$1",
          [artifactId]
        )
      ).rows[0].n
    ).toBe(1)
    expect(
      (
        await pool.query(
          "SELECT result,event,state,error_code,pending_decision FROM loop_runs WHERE id=$1",
          [source.runId]
        )
      ).rows[0]
    ).toMatchObject({
      result: null,
      event: { entity: "issue", entityId: source.sourceId },
      state: "cancelled",
      error_code: "SOURCE_PURGED",
      pending_decision: null,
    })
    await pool.query("UPDATE issues SET purge_lease_until=NULL WHERE id=$1", [
      source.sourceId,
    ])
    expect(await purgeDeletedIssues(blobs, 1)).toEqual({ purged: 1, failed: 0 })
    expect(objects.size).toBe(0)
    expect(deletes.filter((key) => key === reference)).toHaveLength(2)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_artifact_intents WHERE loop_run_id=$1",
          [source.runId]
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_events WHERE entity='issue' AND entity_id=$1",
          [source.sourceId]
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT payload_json FROM agent_events WHERE run_id=$1",
          [source.agentRunId]
        )
      ).rows[0].payload_json
    ).toEqual({})
    expect(
      (
        await pool.query(
          "SELECT state,redacted_input_summary FROM agent_approvals WHERE id=$1",
          [approvalId]
        )
      ).rows[0]
    ).toEqual({ state: "expired", redacted_input_summary: {} })
    expect(
      (
        await pool.query("SELECT fields FROM loop_revisions WHERE loop_id=$1", [
          source.loopId,
        ])
      ).rows[0].fields
    ).toEqual(source.fields)
    // A process holding old generated output cannot refill any scrubbed family.
    await pool.query(
      "UPDATE loop_runs SET result='Rehydrated content',event=$2,pending_decision=$3,state='running' WHERE id=$1",
      [
        source.runId,
        {
          entity: "issue",
          entityId: source.sourceId,
          context: { title: "Old source" },
        },
        { action: "approve" },
      ]
    )
    await pool.query(
      "INSERT INTO agent_events(thread_id,run_id,source,source_event_id,sequence,type,payload_json,occurred_at) VALUES($1,$2,'forge','late-source',2,'assistant.message',$3,now())",
      [source.threadId, source.agentRunId, { text: "Rehydrated source" }]
    )
    await pool.query(
      "UPDATE agent_approvals SET state='approved',redacted_input_summary=$2 WHERE id=$1",
      [approvalId, { summary: "Rehydrated source" }]
    )
    await pool.query(
      "INSERT INTO loop_events(workspace_id,team_id,entity,entity_id,event,after) VALUES($1,$2,'issue',$3,'updated',$4)",
      [f.workspaceId, f.teamId, source.sourceId, { title: "Rehydrated source" }]
    )
    await expect(
      pool.query(
        "INSERT INTO agent_artifacts(id,run_id,kind,name,content_type,size_bytes,storage_reference,checksum) VALUES($1,$2,'text','late.txt','text/plain',1,$3,$4)",
        [
          randomUUID(),
          source.agentRunId,
          `${source.agentRunId}/${randomUUID()}`,
          "0".repeat(64),
        ]
      )
    ).rejects.toMatchObject({ code: "23514" })
    await expect(
      pool.query(
        "INSERT INTO loop_artifact_intents(id,workspace_id,loop_run_id,agent_run_id,storage_reference) VALUES($1,$2,$3,$4,$5)",
        [
          randomUUID(),
          f.workspaceId,
          source.runId,
          source.agentRunId,
          `${source.agentRunId}/${randomUUID()}`,
        ]
      )
    ).rejects.toMatchObject({ code: "23514" })
    expect(
      (
        await pool.query(
          "SELECT result,event,state,error_code,pending_decision FROM loop_runs WHERE id=$1",
          [source.runId]
        )
      ).rows[0]
    ).toMatchObject({
      result: null,
      event: { entity: "issue", entityId: source.sourceId },
      state: "cancelled",
      error_code: "SOURCE_PURGED",
      pending_decision: null,
    })
    expect(
      (
        await pool.query(
          "SELECT bool_and(payload_json='{}'::jsonb) scrubbed FROM agent_events WHERE run_id=$1",
          [source.agentRunId]
        )
      ).rows[0].scrubbed
    ).toBe(true)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_events WHERE entity_id=$1",
          [source.sourceId]
        )
      ).rows[0].n
    ).toBe(0)
  }, 30000)
  it("keeps an in-flight upload owned while its source purge waits and then compensates", async () => {
    const f = await fixture(),
      source = await sourceLoopFixture(f)
    const { AgentArtifactService } =
      await import("../agents/artifact-service.server")
    const { DrizzleAgentStore } =
      await import("@/adapters/agents/drizzle-agent-store.server")
    const { DrizzleAgentEventStore } =
      await import("@/adapters/agents/drizzle-event-store.server")
    const { DrizzleAgentArtifactStore } =
      await import("@/adapters/agents/drizzle-artifact-store.server")
    const { loopArtifactPublication } =
      await import("@/adapters/agents/loop-artifact-publication.server")
    const { requireCurrentActor } =
      await import("@/application/resource-policy.server")
    const { purgeDeletedIssues } = await import("../issues/purge-issues.server")
    let releaseUpload!: () => void, started!: () => void
    const uploaded = new Promise<void>((resolve) => {
      started = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      releaseUpload = resolve
    })
    const objects = new Map<string, Uint8Array>()
    const blobs = {
      put: async (reference: string, bytes: Uint8Array) => {
        started()
        await barrier
        objects.set(reference, bytes)
      },
      get: (_reference: string) => Promise.resolve(null),
      delete: (reference: string) => {
        objects.delete(reference)
        return Promise.resolve()
      },
    }
    const artifacts = new AgentArtifactService({
      authorizeActor: requireCurrentActor,
      metadata: new DrizzleAgentArtifactStore(),
      agents: new DrizzleAgentStore(),
      events: new DrizzleAgentEventStore(),
      blobs,
      publication: loopArtifactPublication,
    })
    const creation = artifacts
      .create(source.actor, source.agentRunId, {
        kind: "text",
        name: "In-flight.txt",
        contentType: "text/plain",
        encoding: "utf8",
        content: "Late source bytes",
      })
      .then(
        () => null,
        (error) => error
      )
    await uploaded
    try {
      await deleteSource(source.sourceId)
      expect(await purgeDeletedIssues(blobs, 1)).toEqual({
        purged: 0,
        failed: 0,
      })
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM loop_artifact_intents WHERE loop_run_id=$1",
            [source.runId]
          )
        ).rows[0].n
      ).toBe(1)
    } finally {
      releaseUpload()
    }
    expect(await creation).toBeInstanceOf(Error)
    expect(objects.size).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM agent_artifacts WHERE run_id=$1",
          [source.agentRunId]
        )
      ).rows[0].n
    ).toBe(0)
    expect(await purgeDeletedIssues(blobs, 1)).toEqual({ purged: 1, failed: 0 })
  }, 30000)
  it("bounds Loop purge groups and waits for an unfinished artifact reservation", async () => {
    const f = await fixture(),
      source = await sourceLoopFixture(f),
      intentId = randomUUID(),
      reference = `${source.agentRunId}/${intentId}`
    await pool.query(
      "INSERT INTO loop_artifact_intents(id,workspace_id,loop_run_id,agent_run_id,storage_reference) VALUES($1,$2,$3,$4,$5)",
      [intentId, f.workspaceId, source.runId, source.agentRunId, reference]
    )
    await pool.query(
      "INSERT INTO loop_events(workspace_id,team_id,entity,entity_id,event,after) SELECT $1,$2,'issue',$3,'updated',jsonb_build_object('title','Source copy') FROM generate_series(1,101)",
      [f.workspaceId, f.teamId, source.sourceId]
    )
    await pool.query(
      "INSERT INTO agent_events(thread_id,run_id,source,source_event_id,sequence,type,payload_json,occurred_at) SELECT $1,$2,'forge','source-'||n,n,'assistant.message',jsonb_build_object('text','Source copy'),now() FROM generate_series(1,101) n",
      [source.threadId, source.agentRunId]
    )
    await deleteSource(source.sourceId)
    const { purgeDeletedIssues } =
        await import("../issues/purge-issues.server"),
      deleted: Array<string> = [],
      blobs = {
        delete: async (reference: string) => {
          deleted.push(reference)
        },
      }
    expect(await purgeDeletedIssues(blobs, 1)).toEqual({ purged: 0, failed: 0 })
    expect(deleted).toEqual([])
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_events WHERE entity_id=$1",
          [source.sourceId]
        )
      ).rows[0].n
    ).toBe(1)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM agent_events WHERE run_id=$1 AND payload_json<>'{}'::jsonb",
          [source.agentRunId]
        )
      ).rows[0].n
    ).toBe(1)
    expect(
      (
        await pool.query("SELECT purged_at FROM issues WHERE id=$1", [
          source.sourceId,
        ])
      ).rows[0].purged_at
    ).toBeNull()
    // The live upload finishes its compensation. The owner waits rather than
    // claiming all bytes are gone while that reservation can still write.
    const { loopArtifactPublication } =
      await import("@/adapters/agents/loop-artifact-publication.server")
    await blobs.delete(reference)
    await loopArtifactPublication.abandon(source.actor, {
      id: intentId,
      runId: source.agentRunId,
      storageReference: reference,
    })
    expect(await purgeDeletedIssues(blobs, 1)).toEqual({ purged: 1, failed: 0 })
    await pool.query("DELETE FROM organization WHERE id=$1", [f.workspaceId])
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [
          source.botId,
        ])
      ).rows[0].n
    ).toBe(0)
  }, 30000)
})

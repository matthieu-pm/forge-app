// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import type { Actor } from "@/application/actor"
import type * as Service from "./documents.server"
import { defaultDocumentIcon } from "@/lib/team-documents"
import { documentFieldsSchema } from "@/lib/document-contract"

const file = process.env.FORGE_DOCUMENT_TEST_DATABASE_FILE
const fields = (text = "Shared writing") => ({
  title: "Shared document",
  icon: defaultDocumentIcon,
  sectionId: null,
  body: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text, marks: [{ type: "bold" }] }],
      },
    ],
  },
})
describe.skipIf(!file)("FOR-61 canonical documents on PostgreSQL", () => {
  const marker = `for61-${randomUUID()}`,
    userIds = [marker + "-alice", marker + "-bob", marker + "-cara"],
    workspaces: Array<string> = []
  let pool: Pool, service: typeof Service
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(file!, "utf8"))
    const target = {
      environment: "document-acceptance",
      ...DATABASE_TARGETS["document-acceptance"],
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
    vi.stubEnv("FORGE_SHARED_DOCUMENTS_ENABLED", "true")
    service = await import("./documents.server")
    for (const id of userIds)
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [id, id + "@example.test"]
      )
  }, 30000)
  afterAll(async () => {
    if (!pool) return
    for (const id of workspaces)
      await pool.query("DELETE FROM organization WHERE id=$1", [id])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [userIds])
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
    const actors: Array<Actor> = []
    for (const [i, userId] of userIds.entries()) {
      await pool.query(
        "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)",
        [randomUUID(), workspaceId, userId, i === 2 ? "admin" : "member"]
      )
      const sessionId = randomUUID()
      await pool.query(
        "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
        [sessionId, userId, workspaceId]
      )
      actors.push({
        workspaceId,
        userId,
        workspaceRole: i === 2 ? "admin" : "member",
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
          userIds[0],
        ]
      )
    await pool.query(
      "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member')",
      [randomUUID(), workspaceId, privateTeamId, userIds[0]]
    )
    return { actors, workspaceId, teamId, privateTeamId }
  }
  async function create(
    actor: Actor,
    teamId: string,
    key = randomUUID(),
    id = randomUUID()
  ) {
    const input = {
      action: "create",
      id,
      source: { kind: "team", id: teamId },
      fields: fields(),
    }
    expect(await service.commandDocument(actor, key, input)).toEqual({
      status: "saved",
      id,
      revision: 1,
    })
    return { id, key, input }
  }
  const read = async (actor: Actor, id: string) =>
    (await service.readDocuments(actor, { id }))[0]
  it("AT-01: Alice's confirmed content, projection, metadata and rich formatting are identical for Bob", async () => {
    const f = await fixture(),
      d = await create(f.actors[0], f.teamId)
    const a = await read(f.actors[0], d.id),
      b = await read(f.actors[1], d.id)
    expect(b.body).toEqual(a.body)
    expect(b.content).toBe("Shared writing")
    expect(b.revision).toBe(1)
    expect(b.owner?.id).toBe(userIds[0])
    expect(b.updatedAt).toBe(a.updatedAt)
    expect(b.canDelete).toBe(false)
    expect(
      (await service.readDocumentHistory(f.actors[1], d.id))[0].body
    ).toEqual(a.body)
  })
  it("AT-02: concurrent saves commit once; the loser gets the current content without any duplicate receipt or history", async () => {
    const f = await fixture(),
      d = await create(f.actors[0], f.teamId)
    const results = await Promise.all(
      f.actors.slice(0, 2).map((a, i) =>
        service.commandDocument(a, randomUUID(), {
          action: "save",
          id: d.id,
          expectedRevision: 1,
          fields: fields(String(i)),
        })
      )
    )
    expect(results.map((r) => r.status).sort()).toEqual(["conflict", "saved"])
    const conflict = results.find((r) => r.status === "conflict")!
    if (conflict.status === "conflict")
      expect(conflict.current?.revision).toBe(2)
    expect(await service.readDocumentHistory(f.actors[0], d.id)).toHaveLength(2)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE resource_id=$1",
          [d.id]
        )
      ).rows[0].n
    ).toBe(2)
  })
  it("replays a lost response once and rejects a changed input behind the same key", async () => {
    const f = await fixture(),
      d = await create(f.actors[0], f.teamId)
    expect(await service.commandDocument(f.actors[0], d.key, d.input)).toEqual({
      status: "saved",
      id: d.id,
      revision: 1,
    })
    await expect(
      service.commandDocument(f.actors[0], d.key, {
        ...d.input,
        fields: fields("changed"),
      })
    ).rejects.toThrow("different input")
    for (const table of [
      "command_receipts",
      "command_audit_events",
      "command_outbox_events",
    ]) {
      const q =
        table === "command_outbox_events"
          ? "payload->>'documentId'"
          : "resource_id"
      expect(
        (
          await pool.query(
            `SELECT count(*)::int n FROM ${table} WHERE ${q}=$1`,
            [d.id]
          )
        ).rows[0].n
      ).toBe(1)
    }
  })
  it("AT-03: executable nodes, attributes and links are rejected on create/import/save without changing content or history", async () => {
    const f = await fixture(),
      d = await create(f.actors[0], f.teamId)
    for (const body of [
      { type: "doc", content: [{ type: "script", text: "alert(1)" }] },
      {
        type: "doc",
        content: [{ type: "paragraph", attrs: { onclick: "alert(1)" } }],
      },
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "click",
                marks: [
                  { type: "link", attrs: { href: "javascript:alert(1)" } },
                ],
              },
            ],
          },
        ],
      },
    ]) {
      await expect(
        service.commandDocument(f.actors[0], randomUUID(), {
          action: "save",
          id: d.id,
          expectedRevision: 1,
          fields: { ...fields(), body },
        })
      ).rejects.toThrow()
      await expect(
        service.commandDocument(f.actors[0], randomUUID(), {
          ...d.input,
          id: randomUUID(),
          fields: { ...fields(), body },
        })
      ).rejects.toThrow()
    }
    expect((await read(f.actors[1], d.id)).revision).toBe(1)
    expect(await service.readDocumentHistory(f.actors[0], d.id)).toHaveLength(1)
  })
  it("private origin, admin-only sharing, redacted source metadata, revocation and receipt replay all use current access", async () => {
    const f = await fixture(),
      d = await create(f.actors[0], f.privateTeamId)
    await expect(read(f.actors[1], d.id)).rejects.toThrow()
    await expect(
      service.commandDocument(f.actors[0], randomUUID(), {
        action: "share",
        id: d.id,
        expectedRevision: 1,
        shared: true,
      })
    ).rejects.toThrow()
    expect(
      await service.commandDocument(f.actors[2], randomUUID(), {
        action: "share",
        id: d.id,
        expectedRevision: 1,
        shared: true,
      })
    ).toMatchObject({ status: "saved", revision: 2 })
    const shared = await read(f.actors[1], d.id)
    expect(shared).not.toHaveProperty("teamId")
    expect(shared).not.toHaveProperty("issueId")
    expect(
      (
        await service.readDocuments(f.actors[1], {
          source: { kind: "workspace" },
        })
      ).map((d) => d.id)
    ).toContain(d.id)
    await service.commandDocument(f.actors[2], randomUUID(), {
      action: "share",
      id: d.id,
      expectedRevision: 2,
      shared: false,
    })
    await expect(read(f.actors[1], d.id)).rejects.toThrow()
    await pool.query(
      "DELETE FROM team_members WHERE workspace_id=$1 AND user_id=$2",
      [f.workspaceId, userIds[0]]
    )
    await expect(
      service.commandDocument(f.actors[0], d.key, d.input)
    ).rejects.toThrow()
    await expect(
      service.readDocumentHistory(f.actors[0], d.id)
    ).rejects.toThrow()
  })
  it("all readable teammates can edit; creator/admin alone can delete; deleted files/history/listings are inaccessible", async () => {
    const f = await fixture(),
      d = await create(f.actors[0], f.teamId)
    await service.commandDocument(f.actors[1], randomUUID(), {
      action: "save",
      id: d.id,
      expectedRevision: 1,
      fields: fields("Bob wrote this"),
    })
    await expect(
      service.commandDocument(f.actors[1], randomUUID(), {
        action: "delete",
        id: d.id,
        expectedRevision: 2,
      })
    ).rejects.toThrow()
    const key = randomUUID(),
      input = { action: "delete", id: d.id, expectedRevision: 2 }
    expect(
      await service.commandDocument(f.actors[0], key, input)
    ).toMatchObject({ status: "saved", revision: 3 })
    expect(
      await service.commandDocument(f.actors[0], key, input)
    ).toMatchObject({ status: "saved", revision: 3 })
    await expect(read(f.actors[0], d.id)).rejects.toThrow()
    await expect(
      service.readDocumentHistory(f.actors[2], d.id)
    ).rejects.toThrow()
    expect(
      await service.readDocuments(f.actors[1], {
        source: { kind: "team", id: f.teamId },
      })
    ).toHaveLength(0)
  })
  it("restore appends a revision and stale restores leave newer text untouched", async () => {
    const f = await fixture(),
      d = await create(f.actors[0], f.teamId)
    await service.commandDocument(f.actors[1], randomUUID(), {
      action: "save",
      id: d.id,
      expectedRevision: 1,
      fields: fields("Bob"),
    })
    expect(
      await service.commandDocument(f.actors[0], randomUUID(), {
        action: "restore",
        id: d.id,
        expectedRevision: 1,
        revision: 1,
      })
    ).toMatchObject({ status: "conflict" })
    await service.commandDocument(f.actors[0], randomUUID(), {
      action: "restore",
      id: d.id,
      expectedRevision: 2,
      revision: 1,
    })
    expect((await read(f.actors[1], d.id)).content).toBe("Shared writing")
    expect(await service.readDocumentHistory(f.actors[0], d.id)).toHaveLength(3)
  })
  it("foreign workspace and undeclared API/agent adapters cannot read, create, replay or inspect revisions", async () => {
    const a = await fixture(),
      b = await fixture(),
      d = await create(a.actors[0], a.teamId)
    await expect(read(b.actors[2], d.id)).rejects.toThrow()
    await expect(
      service.commandDocument(b.actors[2], randomUUID(), d.input)
    ).rejects.toThrow()
    const api = {
      ...a.actors[0],
      authentication: { kind: "apiKey", credentialId: "key" },
      scopes: ["teams:read"],
    } as Actor
    await expect(read(api, d.id)).rejects.toThrow()
    await expect(service.commandDocument(api, d.key, d.input)).rejects.toThrow()
  })
  it("explicit legacy import consumes its source atomically; stale generic copies cannot resurrect a deleted document", async () => {
    const f = await fixture(),
      id = randomUUID(),
      key = `forge:team-home:v1:${f.teamId}`
    const snapshot = {
      favorite: false,
      sections: [],
      loops: [],
      resources: [
        {
          id,
          kind: "document",
          title: "Legacy writing",
          content: "Legacy text",
          sectionId: null,
          updatedAt: new Date().toISOString(),
        },
      ],
    }
    await pool.query(
      "INSERT INTO product_state(workspace_id,owner_id,owner_user_id,team_id,key,encoded_value) VALUES($1,$5,$6,$2,$3,$4)",
      [
        f.workspaceId,
        f.teamId,
        key,
        JSON.stringify(JSON.stringify(snapshot)),
        `user:${f.actors[0].userId}`,
        f.actors[0].userId,
      ]
    )
    const input = {
      action: "create",
      legacyImport: true,
      id,
      source: { kind: "team", id: f.teamId },
      fields: documentFieldsSchema.parse({
        title: "Legacy writing",
        icon: defaultDocumentIcon,
        sectionId: null,
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Legacy text" }],
            },
          ],
        },
      }),
    }
    await expect(
      service.commandDocument(f.actors[0], randomUUID(), {
        ...input,
        fields: {
          ...input.fields,
          body: { type: "doc", content: [{ type: "script" }] },
        },
      })
    ).rejects.toThrow()
    const source = async () =>
      (
        await pool.query(
          "SELECT encoded_value,revision FROM product_state WHERE workspace_id=$1 AND key=$2",
          [f.workspaceId, key]
        )
      ).rows[0]
    expect(
      JSON.parse(JSON.parse((await source()).encoded_value)).resources
    ).toHaveLength(1)
    await service.commandDocument(f.actors[0], randomUUID(), input)
    expect(
      JSON.parse(JSON.parse((await source()).encoded_value)).resources
    ).toEqual([])
    await service.commandDocument(f.actors[0], randomUUID(), {
      action: "delete",
      id,
      expectedRevision: 1,
    })
    const { saveProductState } =
      await import("@/application/product-state/product-state.server")
    await saveProductState(f.actors[0], {
      workspaceId: f.workspaceId,
      sessionId:
        f.actors[0].authentication.kind === "session"
          ? f.actors[0].authentication.sessionId
          : "",
      commandKey: randomUUID(),
      key,
      value: JSON.stringify(snapshot),
      expectedRevision: (await source()).revision,
    })
    expect(
      JSON.parse(JSON.parse((await source()).encoded_value)).resources
    ).toEqual([])
  })
  const legacyResource = (
    id: string,
    text: string,
    title = "Legacy writing"
  ) => ({
    id,
    kind: "document",
    title,
    content: text,
    sectionId: null,
    updatedAt: new Date().toISOString(),
  })
  const legacyFields = (resource: ReturnType<typeof legacyResource>) =>
    documentFieldsSchema.parse({
      title: resource.title,
      icon: defaultDocumentIcon,
      sectionId: null,
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: resource.content }],
          },
        ],
      },
    })
  const teamSnapshot = (
    resources: Array<unknown>,
    retainedDocumentDrafts?: Array<unknown>
  ) => ({
    favorite: false,
    sections: [],
    loops: [],
    resources,
    ...(retainedDocumentDrafts ? { retainedDocumentDrafts } : {}),
  })
  async function putTeamSource(actor: Actor, teamId: string, value: unknown) {
    const key = `forge:team-home:v1:${teamId}`
    await pool.query(
      "INSERT INTO product_state(workspace_id,owner_id,owner_user_id,team_id,key,encoded_value) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,owner_id,key) DO UPDATE SET encoded_value=excluded.encoded_value,revision=product_state.revision+1",
      [
        actor.workspaceId,
        `user:${actor.userId}`,
        actor.userId,
        teamId,
        key,
        JSON.stringify(JSON.stringify(value)),
      ]
    )
    return key
  }
  async function teamSource(actor: Actor, key: string) {
    const row = (
      await pool.query(
        "SELECT encoded_value,revision FROM product_state WHERE workspace_id=$1 AND owner_id=$2 AND key=$3",
        [actor.workspaceId, `user:${actor.userId}`, key]
      )
    ).rows[0]
    return {
      value: JSON.parse(JSON.parse(row.encoded_value)),
      revision: row.revision,
    }
  }
  it("a stale team import preserves a newer source and consumes only the selected reviewed copy", async () => {
    const f = await fixture(),
      id = randomUUID(),
      old = legacyResource(id, "Earlier text"),
      newer = legacyResource(id, "Newer text"),
      unrelated = legacyResource(randomUUID(), "Unrelated original")
    const key = await putTeamSource(
      f.actors[0],
      f.teamId,
      teamSnapshot([newer, unrelated])
    )
    const commandKey = randomUUID(),
      input = {
        action: "create",
        legacyImport: true,
        id,
        source: { kind: "team", id: f.teamId },
        fields: legacyFields(old),
      }
    expect(
      await service.commandDocument(f.actors[0], commandKey, input)
    ).toMatchObject({ status: "conflict", current: null })
    expect((await teamSource(f.actors[0], key)).value.resources).toEqual([
      newer,
      unrelated,
    ])
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE command_key=$1",
          [commandKey]
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (
        await pool.query("SELECT count(*)::int n FROM documents WHERE id=$1", [
          id,
        ])
      ).rows[0].n
    ).toBe(0)
    expect(
      await service.commandDocument(f.actors[0], randomUUID(), {
        ...input,
        fields: legacyFields(newer),
      })
    ).toMatchObject({ status: "saved" })
    expect((await teamSource(f.actors[0], key)).value.resources).toEqual([
      unrelated,
    ])
  })
  it("a removed team import source conflicts while fresh document creation remains available", async () => {
    const f = await fixture(),
      id = randomUUID(),
      old = legacyResource(id, "Removed original")
    await putTeamSource(f.actors[0], f.teamId, teamSnapshot([]))
    expect(
      await service.commandDocument(f.actors[0], randomUUID(), {
        action: "create",
        legacyImport: true,
        id,
        source: { kind: "team", id: f.teamId },
        fields: legacyFields(old),
      })
    ).toMatchObject({ status: "conflict", current: null })
    expect(
      await service.commandDocument(f.actors[0], randomUUID(), {
        action: "create",
        id,
        source: { kind: "team", id: f.teamId },
        fields: fields("Fresh writing"),
      })
    ).toMatchObject({ status: "saved" })
  })
  it("two actors' divergent same-ID sources remain scoped and recoverable through unrelated older-client saves", async () => {
    const f = await fixture(),
      id = randomUUID(),
      alice = legacyResource(id, "Alice's reviewed source"),
      bob = legacyResource(id, "Bob's divergent draft")
    const aKey = await putTeamSource(
      f.actors[0],
      f.teamId,
      teamSnapshot([alice])
    )
    const bKey = await putTeamSource(f.actors[1], f.teamId, teamSnapshot([bob]))
    await service.commandDocument(f.actors[0], randomUUID(), {
      action: "create",
      legacyImport: true,
      id,
      source: { kind: "team", id: f.teamId },
      fields: legacyFields(alice),
    })
    const { readProductState, saveProductState } =
      await import("@/application/product-state/product-state.server")
    const visible = (await readProductState(f.actors[1])).entries.find(
      (e) => e.key === bKey
    )!
    expect(JSON.parse(visible.value!).resources).toEqual([])
    expect(JSON.parse(visible.value!).retainedDocumentDrafts).toEqual([bob])
    expect(
      (await readProductState(f.actors[0])).entries.find((e) => e.key === aKey)
        ?.value
    ).not.toContain("Bob's divergent draft")
    for (let attempt = 0; attempt < 2; attempt++)
      await saveProductState(f.actors[1], {
        workspaceId: f.workspaceId,
        sessionId:
          f.actors[1].authentication.kind === "session"
            ? f.actors[1].authentication.sessionId
            : "",
        commandKey: randomUUID(),
        key: bKey,
        value: JSON.stringify(teamSnapshot([])),
        expectedRevision: (await teamSource(f.actors[1], bKey)).revision,
      })
    expect((await teamSource(f.actors[1], bKey)).value).toMatchObject({
      resources: [],
      retainedDocumentDrafts: [bob],
    })
    // Even a generic key deletion cannot silently discard retained authored writing.
    await saveProductState(f.actors[1], {
      workspaceId: f.workspaceId,
      sessionId:
        f.actors[1].authentication.kind === "session"
          ? f.actors[1].authentication.sessionId
          : "",
      commandKey: randomUUID(),
      key: bKey,
      value: null,
      expectedRevision: (await teamSource(f.actors[1], bKey)).revision,
    })
    expect(
      (await teamSource(f.actors[1], bKey)).value.retainedDocumentDrafts
    ).toEqual([bob])
  })
  it("an explicit import does not consume unrelated same-ID canonical recovery sources", async () => {
    const f = await fixture(),
      canonical = await create(f.actors[0], f.teamId),
      selected = legacyResource(randomUUID(), "Selected source"),
      divergent = legacyResource(canonical.id, "Unreviewed divergent writing")
    const key = await putTeamSource(
      f.actors[0],
      f.teamId,
      teamSnapshot([divergent, selected])
    )
    await service.commandDocument(f.actors[0], randomUUID(), {
      action: "create",
      legacyImport: true,
      id: selected.id,
      source: { kind: "team", id: f.teamId },
      fields: legacyFields(selected),
    })
    expect((await teamSource(f.actors[0], key)).value.resources).toEqual([
      divergent,
    ])
  })
  it("stale or removed project import sources conflict without replacing their latest text", async () => {
    const f = await fixture(),
      projectId = randomUUID(),
      id = randomUUID(),
      old = legacyResource(id, "Old project source"),
      newer = legacyResource(id, "New project source")
    const projectCopy = {
      id,
      title: newer.title,
      body: legacyFields(newer).body,
      icon: defaultDocumentIcon,
    }
    await pool.query(
      "INSERT INTO projects(id,workspace_id,name,properties) VALUES($1,$2,'Import project',$3)",
      [projectId, f.workspaceId, JSON.stringify({ resources: [projectCopy] })]
    )
    const input = {
      action: "create",
      legacyImport: true,
      id,
      source: { kind: "project", id: projectId },
      fields: legacyFields(old),
    }
    expect(
      await service.commandDocument(f.actors[1], randomUUID(), input)
    ).toMatchObject({ status: "conflict", current: null })
    expect(
      (
        await pool.query("SELECT properties FROM projects WHERE id=$1", [
          projectId,
        ])
      ).rows[0].properties.resources
    ).toEqual([projectCopy])
    await pool.query(
      "UPDATE projects SET properties='{\"resources\":[]}' WHERE id=$1",
      [projectId]
    )
    expect(
      await service.commandDocument(f.actors[1], randomUUID(), {
        ...input,
        fields: legacyFields(newer),
      })
    ).toMatchObject({ status: "conflict", current: null })
    await pool.query("UPDATE projects SET properties=$2 WHERE id=$1", [
      projectId,
      JSON.stringify({ resources: [projectCopy] }),
    ])
    expect(
      await service.commandDocument(f.actors[1], randomUUID(), {
        ...input,
        fields: legacyFields(newer),
      })
    ).toMatchObject({ status: "saved" })
    expect(
      (
        await pool.query("SELECT properties FROM projects WHERE id=$1", [
          projectId,
        ])
      ).rows[0].properties.resources
    ).toEqual([])
  })
  it("retained originals are hidden after private-team revocation", async () => {
    const f = await fixture(),
      key = await putTeamSource(
        f.actors[0],
        f.privateTeamId,
        teamSnapshot(
          [],
          [
            {
              title: "Private recovered writing",
              rawBody: { event: "never render" },
            },
          ]
        )
      )
    const { readProductState } =
      await import("@/application/product-state/product-state.server")
    expect(
      (await readProductState(f.actors[0])).entries.find((e) => e.key === key)
        ?.value
    ).toContain("Private recovered writing")
    await pool.query(
      "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
      [f.workspaceId, f.privateTeamId, f.actors[0].userId]
    )
    expect(
      (await readProductState(f.actors[0])).entries.some((e) => e.key === key)
    ).toBe(false)
  })
  it("a database history failure rolls document, receipt, audit and outbox back together", async () => {
    const f = await fixture(),
      id = randomUUID(),
      key = randomUUID(),
      constraint = `for61_fail_${id.replaceAll("-", "")}`
    // Dedicated acceptance database only; a fixture-specific constraint injects a real SQL fault.
    await pool.query(
      `ALTER TABLE document_revisions ADD CONSTRAINT "${constraint}" CHECK (document_id <> '${id}'::uuid)`
    )
    try {
      await expect(
        service.commandDocument(f.actors[0], key, {
          action: "create",
          id,
          source: { kind: "team", id: f.teamId },
          fields: fields(),
        })
      ).rejects.toThrow()
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM documents WHERE id=$1",
            [id]
          )
        ).rows[0].n
      ).toBe(0)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM command_receipts WHERE command_key=$1",
            [key]
          )
        ).rows[0].n
      ).toBe(0)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM command_audit_events WHERE resource_id=$1",
            [id]
          )
        ).rows[0].n
      ).toBe(0)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM command_outbox_events WHERE payload->>'documentId'=$1",
            [id]
          )
        ).rows[0].n
      ).toBe(0)
    } finally {
      await pool.query(
        `ALTER TABLE document_revisions DROP CONSTRAINT "${constraint}"`
      )
    }
    await create(f.actors[0], f.teamId, key, id)
  })
  it("the release gate denies document commands and reads when disabled", async () => {
    const f = await fixture()
    vi.stubEnv("FORGE_SHARED_DOCUMENTS_ENABLED", "false")
    try {
      await expect(
        service.readDocuments(f.actors[0], {
          source: { kind: "team", id: f.teamId },
        })
      ).rejects.toThrow("not enabled")
      await expect(
        service.commandDocument(f.actors[0], randomUUID(), {
          action: "create",
          id: randomUUID(),
          source: { kind: "team", id: f.teamId },
          fields: fields(),
        })
      ).rejects.toThrow("not enabled")
    } finally {
      vi.stubEnv("FORGE_SHARED_DOCUMENTS_ENABLED", "true")
    }
  })
  it("history pagination is stable and unsafe stored revisions stay recoverable but cannot be restored", async () => {
    const f = await fixture(),
      d = await create(f.actors[0], f.teamId)
    await pool.query(
      "INSERT INTO document_revisions(workspace_id,document_id,revision,snapshot,author_id) SELECT $1,$2::uuid,n,$3::jsonb,$4 FROM generate_series(2,35) n",
      [f.workspaceId, d.id, JSON.stringify(fields()), f.actors[0].userId]
    )
    await pool.query("UPDATE documents SET revision=35 WHERE id=$1", [d.id])
    const first = await service.readDocumentHistory(f.actors[1], d.id)
    const second = await service.readDocumentHistory(
      f.actors[1],
      d.id,
      first.at(-1)!.revision
    )
    expect(first.map((r) => r.revision)).toEqual(
      Array.from({ length: 30 }, (_, i) => 35 - i)
    )
    expect(second.map((r) => r.revision)).toEqual([5, 4, 3, 2, 1])
    const unsafe = {
      ...fields(),
      body: { type: "doc", content: [{ type: "script", text: "alert(1)" }] },
    }
    await pool.query(
      "INSERT INTO document_revisions(workspace_id,document_id,revision,snapshot,author_id) VALUES($1,$2,36,$3,$4)",
      [f.workspaceId, d.id, JSON.stringify(unsafe), f.actors[0].userId]
    )
    const revision = (await service.readDocumentHistory(f.actors[1], d.id))[0]
    expect(revision.unsafeBody).toBe(true)
    expect(revision.body).toEqual(unsafe.body)
    await expect(
      service.commandDocument(f.actors[1], randomUUID(), {
        action: "restore",
        id: d.id,
        expectedRevision: 35,
        revision: 36,
      })
    ).rejects.toThrow()
    expect((await read(f.actors[1], d.id)).revision).toBe(35)
  })
  it("the earlier sharing seam delegates to canonical revisioned commands", async () => {
    const f = await fixture(),
      d = await create(f.actors[0], f.privateTeamId)
    const { shareDocumentWithWorkspace } =
      await import("../planning/queries.server")
    await expect(
      shareDocumentWithWorkspace(f.actors[0], d.id, true)
    ).rejects.toThrow()
    expect(await shareDocumentWithWorkspace(f.actors[2], d.id, true)).toEqual({
      id: d.id,
    })
    expect((await read(f.actors[1], d.id)).revision).toBe(2)
    expect(await service.readDocumentHistory(f.actors[1], d.id)).toHaveLength(2)
  })
  it("creation receipt replay confirms a later deleted identity without reopening content or recreating it", async () => {
    const f = await fixture(),
      d = await create(f.actors[0], f.teamId)
    await service.commandDocument(f.actors[0], randomUUID(), {
      action: "delete",
      id: d.id,
      expectedRevision: 1,
    })
    expect(await service.commandDocument(f.actors[0], d.key, d.input)).toEqual({
      status: "saved",
      id: d.id,
      revision: 1,
    })
    await expect(read(f.actors[0], d.id)).rejects.toThrow()
    await expect(
      service.readDocumentHistory(f.actors[0], d.id)
    ).rejects.toThrow()
    expect(
      (
        await pool.query(
          "SELECT revision,deleted_at FROM documents WHERE id=$1",
          [d.id]
        )
      ).rows[0]
    ).toMatchObject({ revision: 2, deleted_at: expect.any(Date) })
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE resource_id=$1",
          [d.id]
        )
      ).rows[0].n
    ).toBe(2)
    expect(
      await service.commandDocument(f.actors[0], randomUUID(), d.input)
    ).toMatchObject({ status: "conflict", current: null })
  })
})

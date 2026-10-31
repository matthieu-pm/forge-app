// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import type { Actor } from "@/application/actor"
import type * as Imports from "./imports.server"
import type { ImportSnapshot } from "@/lib/import-execution-contract"
import { blankIssueDraft } from "@/lib/issue-record-contract"

const file = process.env.FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE

describe.skipIf(!file)("FOR-56 real PostgreSQL imports", () => {
  const marker = `for56-${randomUUID()}`,
    userIds = [`${marker}-alice`, `${marker}-bob`],
    workspaces: Array<string> = []
  let pool: Pool, service: typeof Imports
  beforeAll(async () => {
    const { connection, applicationConnection } = JSON.parse(
        readFileSync(file!, "utf8")
      ),
      target = {
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
    service = await import("./imports.server")
    for (const id of userIds)
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [id, `${id}@example.test`]
      )
  }, 30000)
  afterAll(async () => {
    if (!pool) return
    for (const id of workspaces) {
      await pool.query(
        "DELETE FROM file_upload_intents WHERE workspace_id=$1",
        [id]
      )
      await pool.query("DELETE FROM organization WHERE id=$1", [id])
    }
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [userIds])
    await pool.end()
    const { databaseClient } = await import("@/db")
    await databaseClient.end()
    vi.unstubAllEnvs()
  }, 30000)
  async function fixture() {
    const workspaceId = `${marker}-${workspaces.length}`,
      teamId = randomUUID()
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
        userId,
        workspaceId,
        workspaceRole: index ? "member" : "admin",
        authentication: { kind: "session", sessionId },
        scopes: null,
      })
    }
    await pool.query(
      "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1::uuid,$2,$1::text,$1::text,$3,'workspace','emoji','x','#94a3b8','Europe/Paris',$4)",
      [teamId, workspaceId, teamId.slice(0, 5).toUpperCase(), userIds[0]]
    )
    return { workspaceId, teamId, actors }
  }
  const issue = (id: string, extra = {}) => ({
    ...blankIssueDraft("todo"),
    id,
    number: 1,
    title: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    statusChangedAt: "2026-01-01T00:00:00.000Z",
    creator: "historic",
    suggestedLabel: "",
    completedAt: null,
    recurrenceSpawned: false,
    ...extra,
  })
  async function source(
    f: Awaited<ReturnType<typeof fixture>>,
    records: Array<unknown>,
    actor = f.actors[0]
  ) {
    await pool.query(
      "INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,owner_id,key) DO UPDATE SET encoded_value=excluded.encoded_value",
      [
        f.workspaceId,
        `user:${actor.userId}`,
        actor.userId,
        `forge:team-issues:v1:${f.teamId}`,
        JSON.stringify(JSON.stringify({ version: 1, issues: records })),
      ]
    )
    return (await service.prepareImport(actor))!
  }
  const run = (actor: Actor, m: ImportSnapshot) =>
    service.runImportBatch(actor, {
      workspaceId: actor.workspaceId,
      sessionId:
        actor.authentication.kind === "session"
          ? actor.authentication.sessionId
          : "",
      id: m.id,
      revision: m.revision,
    })
  async function finish(actor: Actor, m: ImportSnapshot) {
    let safety = 20
    while (m.entries.some((e) => e.state === "pending") && safety-- > 0)
      m = await run(actor, m)
    return m
  }
  it("AT-01 commits ordered batches and exact replay once, including a deep parent chain", async () => {
    const f = await fixture(),
      records = Array.from({ length: 14 }, (_, i) =>
        issue(`issue-${i}`, { parentId: i ? `issue-${i - 1}` : "" })
      )
    records.reverse()
    const manifest = await source(f, records),
      first = await run(f.actors[0], manifest)
    expect(first.entries.filter((e) => e.state === "saved")).toHaveLength(10)
    const replay = await run(f.actors[0], manifest)
    expect(replay.revision).toBe(first.revision)
    const final = await finish(
      f.actors[0],
      await service.readImport(f.actors[0], manifest.id)
    )
    expect(final.entries.every((e) => e.state === "saved")).toBe(true)
    const rows = (
      await pool.query(
        "SELECT id,parent_id,legacy_id FROM issues WHERE workspace_id=$1",
        [f.workspaceId]
      )
    ).rows
    expect(rows).toHaveLength(14)
    for (let i = 1; i < 14; i++)
      expect(rows.find((r) => r.legacy_id === `issue-${i}`).parent_id).toBe(
        rows.find((r) => r.legacy_id === `issue-${i - 1}`).id
      )
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_outbox_events WHERE workspace_id=$1 AND topic='issue.created'",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(14)
  }, 30000)
  it("AT-02 changed snapshots and overlapping profiles require review and preserve shared edits", async () => {
    const f = await fixture(),
      initial = await finish(f.actors[0], await source(f, [issue("overlap")]))
    const id = initial.entries[0].canonicalId!
    await pool.query(
      "UPDATE issues SET title='A newer shared edit' WHERE id=$1",
      [id]
    )
    const changed = await finish(
      f.actors[1],
      await source(
        f,
        [issue("overlap", { description: "changed source" })],
        f.actors[1]
      )
    )
    expect(changed.entries[0].state).toBe("review")
    const conflict = changed.entries[0].conflict!
    const chosen = await service.chooseImportConflict(f.actors[1], {
      workspaceId: f.workspaceId,
      sessionId: (f.actors[1].authentication as { sessionId: string })
        .sessionId,
      id: changed.id,
      revision: changed.revision,
      entryId: changed.entries[0].id,
      choice: "keep-both",
      conflictFingerprint: conflict.fingerprint,
    })
    await pool.query(
      "UPDATE issues SET title='Another shared edit' WHERE id=$1",
      [id]
    )
    const raced = await finish(f.actors[1], chosen)
    expect(raced.entries[0].state).toBe("review")
    const reviewed = await service.chooseImportConflict(f.actors[1], {
      workspaceId: f.workspaceId,
      sessionId: (f.actors[1].authentication as { sessionId: string })
        .sessionId,
      id: raced.id,
      revision: raced.revision,
      entryId: raced.entries[0].id,
      choice: "keep-both",
      conflictFingerprint: raced.entries[0].conflict!.fingerprint,
    })
    const final = await finish(f.actors[1], reviewed)
    expect(final.entries[0].state).toBe("saved")
    expect(final.entries[0].canonicalId).not.toBe(id)
    expect(
      (await pool.query("SELECT title FROM issues WHERE id=$1", [id])).rows[0]
        .title
    ).toBe("Another shared edit")
  }, 30000)
  it("cross-account exact sources reuse canonical IDs, with no second issue or event", async () => {
    const f = await fixture(),
      records = [issue("same")],
      a = await finish(f.actors[0], await source(f, records)),
      b = await finish(f.actors[1], await source(f, records, f.actors[1]))
    expect(b.entries[0].canonicalId).toBe(a.entries[0].canonicalId)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(1)
  }, 30000)
  it("revoked membership denies manifest reads, batch replay and private source payloads", async () => {
    const f = await fixture(),
      manifest = await source(f, [issue("private")])
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, userIds[0]]
    )
    await expect(service.readImport(f.actors[0], manifest.id)).rejects.toThrow()
    await expect(run(f.actors[0], manifest)).rejects.toThrow()
    await expect(service.readImport(f.actors[1], manifest.id)).rejects.toThrow()
  }, 30000)
  it("does not recreate deleted targets and stores no source content in manifest metadata", async () => {
    const f = await fixture(),
      a = await finish(
        f.actors[0],
        await source(f, [issue("deleted", { description: "private body" })])
      )
    await pool.query("UPDATE issues SET deleted_at=now() WHERE id=$1", [
      a.entries[0].canonicalId,
    ])
    const b = await finish(
      f.actors[1],
      await source(
        f,
        [issue("deleted", { description: "private body" })],
        f.actors[1]
      )
    )
    expect(b.entries[0].state).toBe("review")
    expect(b.entries[0].conflict?.candidates).toEqual([])
    const metadata = (
      await pool.query(
        "SELECT encoded_manifest FROM legacy_imports WHERE id=$1",
        [a.id]
      )
    ).rows[0].encoded_manifest
    expect(metadata).not.toContain("private body")
    expect(metadata).not.toContain('"raw":')
  }, 30000)
  it("AT-01 verifies bytes through the upload service and atomically resumes file binding once", async () => {
    const f = await fixture(),
      body = "FOR-56 verified attachment",
      bytes = new TextEncoder().encode(body)
    const m = await finish(
      f.actors[0],
      await source(f, [
        issue("with-file", {
          attachments: [
            {
              name: "evidence.txt",
              data: `data:text/plain;base64,${Buffer.from(bytes).toString("base64")}`,
            },
          ],
        }),
      ])
    )
    const entry = m.entries[0],
      issueId = entry.canonicalId!
    const [
      { DrizzleUploadStore },
      { UploadService },
      { LocalFileBlobStore },
      { mkdtemp, rm },
      { tmpdir },
      { join },
    ] = await Promise.all([
      import("@/adapters/files/drizzle-upload-store.server"),
      import("@/application/files/upload-service.server"),
      import("@/adapters/files/local-file-blob-store.server"),
      import("node:fs/promises"),
      import("node:os"),
      import("node:path"),
    ])
    const directory = await mkdtemp(join(tmpdir(), "for56-")),
      blobs = new LocalFileBlobStore(directory)
    vi.stubEnv(
      "FORGE_AGENT_ARTIFACT_SECRET",
      "for56-isolated-acceptance-secret"
    )
    const upload = new UploadService(new DrizzleUploadStore(), {
      grant: async () => {
        throw new Error("Not used")
      },
      read: async (ref) => {
        const content = await blobs.get(ref)
        return content ? new Blob([content]).stream() : null
      },
      delete: (ref) => blobs.delete(ref),
    })
    try {
      const intent = await upload.create(f.actors[0], {
        commandKey: randomUUID(),
        target: { kind: "issue", id: issueId },
        name: "evidence.txt",
        contentType: "text/plain",
        sizeBytes: bytes.length,
        checksum: entry.files[0].checksum,
      })
      const ref = (
        await pool.query(
          "SELECT storage_reference FROM file_upload_intents WHERE id=$1",
          [intent.id]
        )
      ).rows[0].storage_reference
      await blobs.put(ref, bytes)
      const input = {
        workspaceId: f.workspaceId,
        sessionId: (f.actors[0].authentication as { sessionId: string })
          .sessionId,
        id: m.id,
        revision: m.revision,
        entryId: entry.id,
        index: 0,
        fileId: intent.id,
      }
      await expect(
        service.finalizeImportFile(f.actors[0], input)
      ).rejects.toThrow()
      await upload.finalize(f.actors[0], intent.id)
      const saved = await service.finalizeImportFile(f.actors[0], input)
      expect(saved.entries[0].files[0].fileId).toBe(intent.id)
      const replay = await service.finalizeImportFile(f.actors[0], input)
      expect(replay.revision).toBe(saved.revision)
      const row = (
        await pool.query("SELECT properties FROM issues WHERE id=$1", [issueId])
      ).rows[0]
      expect(row.properties.attachments).toHaveLength(1)
      expect(row.properties.attachments[0]).toMatchObject({
        fileId: intent.id,
        data: "",
        checksum: entry.files[0].checksum,
      })
      expect(
        new TextDecoder().decode(
          (await new LocalFileBlobStore(directory).get(ref))!
        )
      ).toBe(body)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM command_outbox_events WHERE workspace_id=$1 AND topic='issue.file.attached'",
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
  it("concurrent tabs and profiles serialize aliases without duplicate effects", async () => {
    const f = await fixture(),
      records = [issue("concurrent")],
      a = await source(f, records),
      b = await source(f, records, f.actors[1])
    const results = await Promise.all([
      run(f.actors[0], a),
      run(f.actors[0], a),
      run(f.actors[1], b),
    ])
    expect(new Set(results.map((m) => m.entries[0].canonicalId)).size).toBe(1)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(1)
  }, 30000)
  it("core projects precede issue links and dated cycles use saved team duration/timezone", async () => {
    const f = await fixture(),
      project = {
        id: "legacy-project",
        name: "Imported project",
        teamIds: [f.teamId],
        status: "Planned",
        health: "On track",
      }
    await pool.query(
      "INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5)",
      [
        f.workspaceId,
        `user:${f.actors[0].userId}`,
        f.actors[0].userId,
        `forge:workspace:${f.workspaceId}:initiatives:v1`,
        JSON.stringify(
          JSON.stringify({
            version: 1,
            initiatives: [],
            workspaceProjects: [project],
          })
        ),
      ]
    )
    const { initialTeamCycles } = await import("@/lib/team-cycles-contract")
    await pool.query(
      "INSERT INTO product_state(workspace_id,owner_id,key,encoded_value) VALUES($1,'workspace',$2,$3)",
      [
        f.workspaceId,
        `forge:team-cycles:v1:${f.teamId}`,
        JSON.stringify(
          JSON.stringify({
            ...initialTeamCycles(),
            duration: 3,
            timezone: "Asia/Tokyo",
          })
        ),
      ]
    )
    const saved = await finish(
      f.actors[0],
      await source(f, [
        issue("linked", { project: "legacy-project", cycle: "2026-01-05" }),
        issue("relative", { cycle: "current" }),
      ])
    )
    const imported = saved.entries.find((e) => e.legacyId === "linked")!
    expect(imported.state).toBe("saved")
    expect(saved.entries.find((e) => e.legacyId === "relative")?.state).toBe(
      "quarantined"
    )
    const row = (
      await pool.query(
        "SELECT i.project_id,c.start_date,c.end_date,c.timezone FROM issues i JOIN issue_cycles c ON c.id=i.cycle_id WHERE i.id=$1",
        [imported.canonicalId]
      )
    ).rows[0]
    expect(row).toMatchObject({
      project_id: saved.entries.find((e) => e.kind === "project")?.canonicalId,
      start_date: "2026-01-05",
      end_date: "2026-01-25",
      timezone: "Asia/Tokyo",
    })
  }, 30000)
  it("rolls back aliases, entities, numbering and checkpoints if command audit fails", async () => {
    const f = await fixture(),
      m = await source(f, [issue("atomic")]),
      name = `for56_fault_${randomUUID().replaceAll("-", "")}`
    await pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FOR56 audit fault'; END $$`
    )
    await pool.query(
      `CREATE TRIGGER ${name} BEFORE INSERT ON command_audit_events FOR EACH ROW WHEN (NEW.workspace_id = '${f.workspaceId}') EXECUTE FUNCTION ${name}()`
    )
    try {
      await expect(run(f.actors[0], m)).rejects.toThrow()
    } finally {
      await pool.query(`DROP TRIGGER ${name} ON command_audit_events`)
      await pool.query(`DROP FUNCTION ${name}()`)
    }
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM legacy_import_aliases WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(0)
    expect((await service.readImport(f.actors[0], m.id)).revision).toBe(
      m.revision
    )
    expect((await finish(f.actors[0], m)).entries[0].state).toBe("saved")
  }, 30000)
  it("bounds review payloads while retaining the complete server manifest", async () => {
    const f = await fixture(),
      m = await source(
        f,
        Array.from({ length: 105 }, (_, i) => issue(`bounded-${i}`))
      )
    expect(m.entries).toHaveLength(100)
    expect(m.totalCount).toBe(105)
    expect(m.pendingCount).toBe(105)
    const next = await run(f.actors[0], m)
    expect(next.totalCount).toBe(105)
    expect(next.pendingCount).toBe(95)
    expect(next.entries.length).toBeLessThanOrEqual(100)
  }, 30000)
  it("cannot bypass invalid file quarantine through explicit retry", async () => {
    const f = await fixture(),
      m = await source(f, [
        issue("invalid-file", {
          attachments: [
            {
              name: "bad.txt",
              data: "data:text/plain;base64,aGVsbG8=",
              checksum: "a".repeat(64),
            },
          ],
        }),
      ])
    expect(m.entries[0].state).toBe("quarantined")
    const retried = await service.retryImportRecords(f.actors[0], {
      workspaceId: f.workspaceId,
      sessionId: (f.actors[0].authentication as { sessionId: string })
        .sessionId,
      id: m.id,
      revision: m.revision,
    })
    expect(retried.entries[0].state).toBe("quarantined")
    expect((await run(f.actors[0], retried)).entries[0].state).toBe(
      "quarantined"
    )
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(0)
  }, 30000)
  it.each([false, true])(
    "converts already-published inline files safely; removed=%s",
    async (removed) => {
      const f = await fixture(),
        attachment = {
          id: "legacy-file-anchor",
          name: "evidence.txt",
          data: "data:text/plain;base64,aGVsbG8=",
          width: 60,
        }
      const { createCanonicalIssue } = await import("../issues/issues.server")
      const original = await createCanonicalIssue(f.actors[0], {
        commandKey: randomUUID(),
        teamId: f.teamId,
        legacyId: "published",
        draft: {
          ...blankIssueDraft("todo"),
          title: "Published legacy issue",
          description: "Shared body",
          attachments: [attachment],
        },
      })
      const m = await finish(
        f.actors[0],
        await source(f, [
          issue("published", {
            title: "Published legacy issue",
            description: "Source body",
            attachments: [attachment],
          }),
        ])
      )
      expect(m.entries[0].state).toBe("review")
      expect(m.entries[0].conflict?.candidates[0].canMigrateFiles).toBe(true)
      const chosen = await service.chooseImportConflict(f.actors[0], {
        workspaceId: f.workspaceId,
        sessionId: (f.actors[0].authentication as { sessionId: string })
          .sessionId,
        id: m.id,
        revision: m.revision,
        entryId: m.entries[0].id,
        choice: "migrate-files",
        conflictFingerprint: m.entries[0].conflict!.fingerprint,
      })
      const pending = await finish(f.actors[0], chosen)
      expect(pending.entries[0].canonicalId).toBe(original.issue.id)
      const [{ DrizzleUploadStore }, { UploadService }] = await Promise.all([
        import("@/adapters/files/drizzle-upload-store.server"),
        import("@/application/files/upload-service.server"),
      ])
      vi.stubEnv(
        "FORGE_AGENT_ARTIFACT_SECRET",
        "for56-isolated-acceptance-secret"
      )
      const upload = new UploadService(new DrizzleUploadStore(), {
        grant: async () => {
          throw new Error("Not used")
        },
        read: async () => new Blob(["hello"]).stream(),
        delete: async () => {},
      })
      const intent = await upload.create(f.actors[0], {
        commandKey: randomUUID(),
        target: { kind: "issue", id: original.issue.id },
        name: attachment.name,
        contentType: "text/plain",
        sizeBytes: 5,
        checksum: pending.entries[0].files[0].checksum,
      })
      await upload.finalize(f.actors[0], intent.id)
      await pool.query(
        "UPDATE issues SET properties=properties || jsonb_build_object('description','A newer shared edit') WHERE id=$1",
        [original.issue.id]
      )
      const input = {
        workspaceId: f.workspaceId,
        sessionId: (f.actors[0].authentication as { sessionId: string })
          .sessionId,
        id: pending.id,
        revision: pending.revision,
        entryId: pending.entries[0].id,
        index: 0,
        fileId: intent.id,
      }
      if (removed) {
        await pool.query(
          "UPDATE issues SET properties=jsonb_set(properties,'{attachments}','[]'::jsonb) WHERE id=$1",
          [original.issue.id]
        )
        const review = await service.finalizeImportFile(f.actors[0], input)
        expect(review.entries[0].state).toBe("review")
        const keep = await service.chooseImportConflict(f.actors[0], {
          ...input,
          entryId: review.entries[0].id,
          revision: review.revision,
          choice: "keep-server",
          conflictFingerprint: review.entries[0].conflict!.fingerprint,
        })
        expect((await finish(f.actors[0], keep)).entries[0].state).toBe("saved")
        expect(
          (
            await pool.query(
              "SELECT properties->'attachments' files FROM issues WHERE id=$1",
              [original.issue.id]
            )
          ).rows[0].files
        ).toEqual([])
        return
      }
      await service.finalizeImportFile(f.actors[0], input)
      await service.finalizeImportFile(f.actors[0], input)
      const row = (
        await pool.query("SELECT properties FROM issues WHERE id=$1", [
          original.issue.id,
        ])
      ).rows[0]
      expect(row.properties.description).toBe("A newer shared edit")
      expect(row.properties.attachments).toHaveLength(1)
      expect(row.properties.attachments[0]).toMatchObject({
        id: "legacy-file-anchor",
        fileId: intent.id,
        data: "",
        width: 60,
      })
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
})

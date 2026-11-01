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
            attachments: [{ ...attachment, id: "source-profile-anchor" }],
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
  async function decide(
    actor: Actor,
    m: ImportSnapshot,
    entryId: string,
    choice: "keep-both" | "keep-server"
  ) {
    const entry = m.entries.find((e) => e.id === entryId)!
    return service.chooseImportConflict(actor, {
      workspaceId: actor.workspaceId,
      sessionId: (actor.authentication as { sessionId: string }).sessionId,
      id: m.id,
      revision: m.revision,
      entryId,
      choice,
      conflictFingerprint: entry.conflict!.fingerprint,
    })
  }
  async function retry(actor: Actor, m: ImportSnapshot) {
    return service.retryImportRecords(actor, {
      workspaceId: actor.workspaceId,
      sessionId: (actor.authentication as { sessionId: string }).sessionId,
      id: m.id,
      revision: m.revision,
    })
  }
  it("PR38 review: maps children within their exact preserved source snapshot", async () => {
    const f = await fixture(),
      key = `forge:team-issues:v1:${f.teamId}`
    const old = [
      issue("parent", { title: "Old parent", description: "old parent body" }),
      issue("old-child", { title: "Old child", parentId: "parent" }),
    ]
    const newer = [
      issue("parent", { title: "New parent", description: "new parent body" }),
      issue("new-child", { title: "New child", parentId: "parent" }),
    ]
    await source(f, old)
    await pool.query(
      "INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5)",
      [
        f.workspaceId,
        `user:${f.actors[0].userId}`,
        f.actors[0].userId,
        `forge:legacy-conflict:v1:${randomUUID()}`,
        JSON.stringify(
          JSON.stringify({
            key,
            value: JSON.stringify({ version: 1, issues: newer }),
            importedAt: new Date().toISOString(),
          })
        ),
      ]
    )
    let m = await finish(
      f.actors[0],
      (await service.prepareImport(f.actors[0]))!
    )
    const conflict = m.entries.find(
      (e) => e.legacyId === "parent" && e.state === "review"
    )!
    m = await finish(
      f.actors[0],
      await decide(f.actors[0], m, conflict.id, "keep-both")
    )
    m = await finish(f.actors[0], await retry(f.actors[0], m))
    for (const child of m.entries.filter((e) => e.legacyId.endsWith("child"))) {
      expect(child.state).toBe("saved")
      const parent = m.entries.find(
        (e) =>
          e.legacyId === "parent" && e.sourceChecksum === child.sourceChecksum
      )!
      expect(
        (
          await pool.query("SELECT parent_id FROM issues WHERE id=$1", [
            child.canonicalId,
          ])
        ).rows[0].parent_id
      ).toBe(parent.canonicalId)
    }
  }, 30000)
  it("PR38 review: unchanged child aliases require review when the remapped parent changes", async () => {
    const f = await fixture(),
      child = issue("child", { title: "Stable child", parentId: "parent" })
    const old = await finish(
      f.actors[0],
      await source(f, [issue("parent", { title: "Parent one" }), child])
    )
    let m = await finish(
      f.actors[0],
      await source(f, [issue("parent", { title: "Parent two" }), child])
    )
    const parent = m.entries.find((e) => e.legacyId === "parent")!
    m = await finish(
      f.actors[0],
      await decide(f.actors[0], m, parent.id, "keep-both")
    )
    m = await finish(f.actors[0], await retry(f.actors[0], m))
    const childEntry = m.entries.find((e) => e.legacyId === "child")!
    expect(childEntry.state).toBe("review")
    m = await finish(
      f.actors[0],
      await decide(f.actors[0], m, childEntry.id, "keep-both")
    )
    const savedChild = m.entries.find((e) => e.legacyId === "child")!
    expect(savedChild.canonicalId).not.toBe(
      old.entries.find((e) => e.legacyId === "child")!.canonicalId
    )
    expect(
      (
        await pool.query("SELECT parent_id FROM issues WHERE id=$1", [
          savedChild.canonicalId,
        ])
      ).rows[0].parent_id
    ).toBe(m.entries.find((e) => e.legacyId === "parent")!.canonicalId)
  }, 30000)
  it("PR38 review: conflict details redact inaccessible parent identities", async () => {
    const f = await fixture(),
      privateTeam = randomUUID(),
      { createCanonicalIssue } = await import("../issues/issues.server")
    await pool.query(
      "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Secret','secret','SEC','private','emoji','x','#94a3b8','UTC',$3)",
      [privateTeam, f.workspaceId, userIds[0]]
    )
    const parent = await createCanonicalIssue(f.actors[0], {
      teamId: privateTeam,
      commandKey: randomUUID(),
      draft: { ...blankIssueDraft("todo"), title: "Hidden parent" },
    })
    await createCanonicalIssue(f.actors[0], {
      teamId: f.teamId,
      commandKey: randomUUID(),
      legacyId: "public-child",
      draft: {
        ...blankIssueDraft("todo"),
        title: "Public child",
        parentId: parent.issue.id,
      },
    })
    const m = await finish(
      f.actors[1],
      await source(
        f,
        [issue("public-child", { title: "Public child" })],
        f.actors[1]
      )
    )
    expect(m.entries[0].state).toBe("review")
    expect(JSON.stringify(m)).not.toContain(parent.issue.id)
  }, 30000)
  async function readyImportFiles(
    f: Awaited<ReturnType<typeof fixture>>,
    m: ImportSnapshot
  ) {
    const [{ DrizzleUploadStore }, { UploadService }] = await Promise.all([
      import("@/adapters/files/drizzle-upload-store.server"),
      import("@/application/files/upload-service.server"),
    ])
    vi.stubEnv(
      "FORGE_AGENT_ARTIFACT_SECRET",
      "for56-isolated-acceptance-secret"
    )
    const contents = new Map<string, Uint8Array>()
    const upload = new UploadService(new DrizzleUploadStore(), {
      grant: async () => {
        throw new Error("Not used")
      },
      read: async (ref) =>
        new Blob([contents.get(ref)! as Uint8Array<ArrayBuffer>]).stream(),
      delete: async () => {},
    })
    const entry = m.entries[0],
      inputs = []
    for (const [index, file] of entry.files.entries()) {
      const intent = await upload.create(f.actors[0], {
        commandKey: randomUUID(),
        target: { kind: "issue", id: entry.canonicalId! },
        name: file.name,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        checksum: file.checksum,
      })
      const ref = (
        await pool.query(
          "SELECT storage_reference FROM file_upload_intents WHERE id=$1",
          [intent.id]
        )
      ).rows[0].storage_reference
      contents.set(ref, Buffer.from(file.data.split(",")[1], "base64"))
      await upload.finalize(f.actors[0], intent.id)
      inputs.push({
        workspaceId: f.workspaceId,
        sessionId: (f.actors[0].authentication as { sessionId: string })
          .sessionId,
        id: m.id,
        revision: m.revision,
        entryId: entry.id,
        index,
        fileId: intent.id,
      })
    }
    return inputs
  }
  it.each([true, false])(
    "PR38 review: concurrent file finalization avoids target-lock deadlock; same=%s",
    async (same) => {
      const f = await fixture(),
        m = await finish(
          f.actors[0],
          await source(f, [
            issue("files", {
              attachments: [
                {
                  name: "a.txt",
                  data: `data:text/plain;base64,${Buffer.from("hello-one").toString("base64")}`,
                },
                {
                  name: "b.txt",
                  data: `data:text/plain;base64,${Buffer.from("hello-two").toString("base64")}`,
                },
              ],
            }),
          ])
        )
      const inputs = await readyImportFiles(f, m),
        barrier = await pool.connect()
      await barrier.query("BEGIN")
      await barrier.query("SELECT public.forge_lock_issue_graph($1)", [
        f.workspaceId,
      ])
      const calls = [
        service.finalizeImportFile(f.actors[0], inputs[0]),
        service.finalizeImportFile(f.actors[0], inputs[same ? 0 : 1]),
      ]
      const outcomes = Promise.allSettled(calls)
      try {
        await vi.waitFor(
          async () =>
            expect(
              (
                await pool.query(
                  "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'"
                )
              ).rows[0].n
            ).toBeGreaterThanOrEqual(2),
          { timeout: 10000 }
        )
      } finally {
        await barrier.query("ROLLBACK")
        barrier.release()
      }
      const results = await outcomes
      for (const result of results)
        if (result.status === "rejected")
          expect(String(result.reason?.message)).toContain(
            "Import progress changed"
          )
      if (same)
        expect(results.every((r) => r.status === "fulfilled")).toBe(true)
      let latest = await service.readImport(f.actors[0], m.id)
      if (!same)
        for (const input of inputs) {
          if (!latest.entries[0].files[input.index].fileId)
            latest = await service.finalizeImportFile(f.actors[0], {
              ...input,
              revision: latest.revision,
            })
        }
      expect(
        (
          await pool.query(
            "SELECT jsonb_array_length(properties->'attachments') n FROM issues WHERE id=$1",
            [m.entries[0].canonicalId]
          )
        ).rows[0].n
      ).toBe(same ? 1 : 2)
    },
    30000
  )
  it("PR38 review: file checkpoints do not acknowledge unrelated shared edits", async () => {
    const f = await fixture(),
      record = issue("edited-file", {
        attachments: [
          {
            name: "a.txt",
            data: `data:text/plain;base64,${Buffer.from("hello-one").toString("base64")}`,
          },
        ],
      })
    const m = await finish(f.actors[0], await source(f, [record])),
      [input] = await readyImportFiles(f, m)
    await pool.query(
      "UPDATE issues SET title='Newer shared title' WHERE id=$1",
      [m.entries[0].canonicalId]
    )
    await service.finalizeImportFile(f.actors[0], input)
    const overlap = await finish(
      f.actors[1],
      await source(f, [record], f.actors[1])
    )
    expect(overlap.entries[0].state).toBe("review")
  }, 30000)
  const settle = (
    actor: Actor,
    m: ImportSnapshot,
    action: "reconcile" | "complete" | "cleanup",
    acknowledgeExclusions = false
  ) =>
    service.cutoverImport(actor, {
      workspaceId: actor.workspaceId,
      sessionId: (actor.authentication as { sessionId: string }).sessionId,
      id: m.id,
      revision: m.revision,
      action,
      acknowledgeExclusions,
      reportFingerprint: m.reconciliation?.fingerprint,
    })
  it("FOR-57 AT-01 reconciles counts and relationships, completes and explicitly cleans redundant sources", async () => {
    const f = await fixture()
    const saved = await finish(
      f.actors[0],
      await source(f, [
        issue("gate-parent", { cycle: "2026-01-05", favorite: true }),
        issue("gate-child", { parentId: "gate-parent" }),
      ])
    )
    const report = await settle(f.actors[0], saved, "reconcile")
    expect(report.reconciliation).toMatchObject({
      ready: true,
      counts: { sources: 1, records: 2, saved: 2, unresolved: 0, files: 0 },
    })
    await expect(settle(f.actors[0], report, "complete")).rejects.toThrow(
      /Acknowledge/
    )
    const completed = await settle(f.actors[0], report, "complete", true)
    expect(completed.completedAt).toBeTruthy()
    const cleaned = await settle(f.actors[0], completed, "cleanup", true)
    expect(cleaned.cleanedSources).toHaveLength(1)
    expect(
      (await settle(f.actors[0], completed, "cleanup", true)).revision
    ).toBe(cleaned.revision)
    const rows = (
      await pool.query(
        "SELECT key,encoded_value FROM product_state WHERE workspace_id=$1",
        [f.workspaceId]
      )
    ).rows
    expect(
      JSON.parse(
        JSON.parse(
          rows.find((r) => r.key === `forge:team-issues:v1:${f.teamId}`)
            .encoded_value
        )
      ).issues
    ).toEqual([])
    const backup = rows.find((r) =>
      r.key.startsWith(`forge:legacy-conflict:v1:import-${saved.id}-`)
    )
    expect(JSON.parse(JSON.parse(backup.encoded_value)).value).toContain(
      "gate-child"
    )
    const star = (
      await pool.query(
        "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2",
        [f.workspaceId, `forge:team-issue-favorites:v1:${f.teamId}`]
      )
    ).rows[0]
    expect(JSON.parse(JSON.parse(star.encoded_value))).toEqual([
      saved.entries.find((e) => e.legacyId === "gate-parent")!.canonicalId,
    ])
    expect(await service.prepareImport(f.actors[0])).toBeNull()
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(2)
  }, 30000)
  it("FOR-57 AT-02 quarantined records and pending files block completion without source cleanup", async () => {
    const f = await fixture()
    const m = await finish(
      f.actors[0],
      await source(f, [
        issue("good"),
        { id: "bad", title: 42 },
        issue("file", {
          attachments: [
            { name: "a.txt", data: "data:text/plain;base64,aGVsbG8=" },
          ],
        }),
      ])
    )
    const report = await settle(f.actors[0], m, "reconcile")
    expect(report.reconciliation).toMatchObject({
      ready: false,
      counts: {
        records: 3,
        saved: 2,
        unresolved: 1,
        files: 1,
        verifiedFiles: 0,
      },
    })
    for (const action of ["complete", "cleanup"] as const)
      await expect(settle(f.actors[0], report, action, true)).rejects.toThrow(
        /discrepancies/
      )
    expect(
      (await service.readImport(f.actors[0], m.id)).completedAt
    ).toBeUndefined()
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM product_state WHERE workspace_id=$1 AND key LIKE 'forge:legacy-conflict:v1:import-%'",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(1)
  }, 30000)
  it("FOR-57 corrupt backups and malformed envelopes cannot pass an empty count gate", async () => {
    const f = await fixture()
    const m = await finish(f.actors[0], await source(f, [issue("backup")]))
    await pool.query(
      "UPDATE product_state SET encoded_value=$1 WHERE workspace_id=$2 AND key LIKE 'forge:legacy-conflict:v1:import-%'",
      [
        JSON.stringify(JSON.stringify({ key: "wrong", value: "corrupt" })),
        f.workspaceId,
      ]
    )
    expect(
      (await settle(f.actors[0], m, "reconcile")).reconciliation?.ready
    ).toBe(false)
    const g = await fixture()
    await source(g, [])
    await pool.query(
      "UPDATE product_state SET encoded_value=$1 WHERE workspace_id=$2 AND key=$3",
      [
        JSON.stringify('{"version":99,"issues":[]}'),
        g.workspaceId,
        `forge:team-issues:v1:${g.teamId}`,
      ]
    )
    const malformed = (await service.prepareImport(g.actors[0]))!
    expect(malformed.entries).toEqual([])
    const report = await settle(g.actors[0], malformed, "reconcile")
    expect(report.reconciliation?.ready).toBe(false)
    await expect(settle(g.actors[0], report, "complete", true)).rejects.toThrow(
      /discrepancies/
    )
  }, 30000)
  it("FOR-57 newer shared edits invalidate the report and require reviewed Keep server", async () => {
    const f = await fixture()
    const saved = await finish(f.actors[0], await source(f, [issue("changed")]))
    const report = await settle(f.actors[0], saved, "reconcile")
    await pool.query("UPDATE issues SET title='New shared title' WHERE id=$1", [
      saved.entries[0].canonicalId,
    ])
    await expect(settle(f.actors[0], report, "complete", true)).rejects.toThrow(
      /discrepancies/
    )
    let review = await finish(f.actors[0], await retry(f.actors[0], report))
    expect(review.entries[0].state).toBe("review")
    review = await finish(
      f.actors[0],
      await decide(f.actors[0], review, review.entries[0].id, "keep-server")
    )
    const fresh = await settle(f.actors[0], review, "reconcile")
    expect(fresh.reconciliation?.ready).toBe(true)
    expect(
      (await settle(f.actors[0], fresh, "complete", true)).completedAt
    ).toBeTruthy()
    expect(
      (
        await pool.query("SELECT title FROM issues WHERE id=$1", [
          saved.entries[0].canonicalId,
        ])
      ).rows[0].title
    ).toBe("New shared title")
  }, 30000)
  it("FOR-57 verifies live file bindings and denies revoked and different actors", async () => {
    const f = await fixture()
    let m = await finish(
      f.actors[0],
      await source(f, [
        issue("bound", {
          attachments: [
            { name: "a.txt", data: "data:text/plain;base64,aGVsbG8=" },
          ],
        }),
      ])
    )
    const [input] = await readyImportFiles(f, m)
    m = await service.finalizeImportFile(f.actors[0], input)
    const report = await settle(f.actors[0], m, "reconcile")
    expect(report.reconciliation).toMatchObject({
      ready: true,
      counts: { files: 1, verifiedFiles: 1 },
    })
    const reused = await finish(
      f.actors[1],
      await source(
        f,
        [
          issue("bound", {
            attachments: [
              { name: "a.txt", data: "data:text/plain;base64,aGVsbG8=" },
            ],
          }),
        ],
        f.actors[1]
      )
    )
    expect(reused.entries[0].canonicalId).toBe(m.entries[0].canonicalId)
    expect(
      (await settle(f.actors[1], reused, "reconcile")).reconciliation
    ).toMatchObject({ ready: true, counts: { files: 1, verifiedFiles: 1 } })
    await pool.query(
      "UPDATE resource_files SET attachment_state='detached' WHERE id=$1",
      [input.fileId]
    )
    expect(
      (await settle(f.actors[0], report, "reconcile")).reconciliation?.ready
    ).toBe(false)
    await expect(
      settle(f.actors[1], report, "complete", true)
    ).rejects.toThrow()
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, f.actors[0].userId]
    )
    await expect(
      settle(f.actors[0], report, "complete", true)
    ).rejects.toThrow()
  }, 30000)
  it("FOR-57 UI limits cannot hide failures after the first hundred records", async () => {
    const f = await fixture()
    const records = [
      ...Array.from({ length: 101 }, (_, i) => issue(`gate-${i}`)),
      { id: "bad", title: 42 },
    ]
    let m = await source(f, records)
    for (let i = 0; i < 11; i++) m = await run(f.actors[0], m)
    const report = await settle(f.actors[0], m, "reconcile")
    expect(report.reconciliation).toMatchObject({
      ready: false,
      counts: { records: 102, saved: 101, unresolved: 1 },
    })
  }, 60000)
  it("FOR-57 stale manifests and changed source strings cannot erase later data", async () => {
    const f = await fixture()
    const m = await finish(f.actors[0], await source(f, [issue("old-source")]))
    const report = await settle(f.actors[0], m, "reconcile")
    await expect(settle(f.actors[0], m, "complete", true)).rejects.toThrow(
      /changed/
    )
    const completed = await settle(f.actors[0], report, "complete", true)
    await source(f, [issue("new-source")])
    const cleaned = await settle(f.actors[0], completed, "cleanup", true)
    expect(cleaned.cleanedSources).toEqual([])
    expect(
      (
        await pool.query(
          "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2",
          [f.workspaceId, `forge:team-issues:v1:${f.teamId}`]
        )
      ).rows[0].encoded_value
    ).toContain("new-source")
  }, 30000)
  it("FOR-57 full reject download covers every record and excludes raw bodies", async () => {
    const f = await fixture(),
      m = await source(
        f,
        Array.from({ length: 102 }, (_, i) => ({
          id: `invalid-${i}`,
          title: 42,
          description: "private raw body",
        }))
      )
    const report = await settle(f.actors[0], m, "reconcile")
    expect(report.reconciliation?.discrepancies).toHaveLength(100)
    expect(report.reconciliation?.discrepancyCount).toBe(102)
    const exported = await service.downloadImportReport(f.actors[0], m.id)
    expect(exported.report.discrepancies).toHaveLength(102)
    expect(exported.records).toHaveLength(102)
    expect(JSON.stringify(exported)).not.toContain("private raw body")
    await expect(
      service.downloadImportReport(f.actors[1], m.id)
    ).rejects.toThrow()
  }, 30000)
  it("FOR-57 audit failure rolls back settlement and cleanup with backups intact", async () => {
    const f = await fixture(),
      saved = await finish(
        f.actors[0],
        await source(f, [issue("atomic-cutover")])
      )
    const report = await settle(f.actors[0], saved, "reconcile")
    const name = `for57_fault_${randomUUID().replaceAll("-", "")}`
    await pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FOR57 audit fault'; END $$`
    )
    await pool.query(
      `CREATE TRIGGER ${name} BEFORE INSERT ON command_audit_events FOR EACH ROW WHEN (NEW.workspace_id = '${f.workspaceId}') EXECUTE FUNCTION ${name}()`
    )
    try {
      await expect(
        settle(f.actors[0], report, "cleanup", true)
      ).rejects.toThrow()
    } finally {
      await pool.query(`DROP TRIGGER ${name} ON command_audit_events`)
      await pool.query(`DROP FUNCTION ${name}()`)
    }
    expect(
      (await service.readImport(f.actors[0], saved.id)).completedAt
    ).toBeUndefined()
    expect(
      (
        await pool.query(
          "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2",
          [f.workspaceId, `forge:team-issues:v1:${f.teamId}`]
        )
      ).rows[0].encoded_value
    ).toContain("atomic-cutover")
    expect(
      (await settle(f.actors[0], report, "cleanup", true)).completedAt
    ).toBeTruthy()
  }, 30000)
  it("FOR-57 remapped parents require fresh child review even when the child row is unchanged", async () => {
    const f = await fixture()
    let m = await finish(
      f.actors[0],
      await source(f, [issue("parent"), issue("child", { parentId: "parent" })])
    )
    const parent = m.entries.find((e) => e.legacyId === "parent")!
    await pool.query(
      "UPDATE issues SET title='Shared parent edit' WHERE id=$1",
      [parent.canonicalId]
    )
    m = await finish(f.actors[0], await retry(f.actors[0], m))
    m = await finish(
      f.actors[0],
      await decide(f.actors[0], m, parent.id, "keep-both")
    )
    m = await settle(f.actors[0], m, "reconcile")
    expect(m.reconciliation?.ready).toBe(false)
    m = await finish(f.actors[0], await retry(f.actors[0], m))
    const child = m.entries.find((e) => e.legacyId === "child")!
    expect(child.state).toBe("review")
    m = await finish(
      f.actors[0],
      await decide(f.actors[0], m, child.id, "keep-server")
    )
    expect(
      (await settle(f.actors[0], m, "reconcile")).reconciliation?.ready
    ).toBe(true)
  }, 30000)
  it("PR39 review: revision markers cannot hide unmigrated core records from reconciliation", async () => {
    const f = await fixture()
    const m = await source(f, [issue("legacy-with-revision", { revision: 0 })])
    const report = await settle(
      f.actors[0],
      await finish(f.actors[0], m),
      "reconcile"
    )
    expect(report.totalCount).toBe(1)
    expect(report.reconciliation).toMatchObject({
      ready: false,
      counts: { records: 1, unresolved: 1 },
    })
    await expect(settle(f.actors[0], report, "cleanup", true)).rejects.toThrow(
      /discrepancies/
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
  it("PR39 review: actual canonical projections require live-target review instead of disappearing", async () => {
    const f = await fixture()
    const { createCanonicalIssue } = await import("../issues/issues.server")
    const canonical = await createCanonicalIssue(f.actors[0], {
      commandKey: randomUUID(),
      teamId: f.teamId,
      draft: {
        ...blankIssueDraft("todo"),
        title: "Existing canonical projection",
      },
    })
    let m = await finish(
      f.actors[0],
      await source(f, [
        issue(canonical.issue.id, {
          revision: canonical.issue.revision,
          title: "Existing canonical projection",
        }),
      ])
    )
    expect(m.totalCount).toBe(1)
    expect(m.entries[0].state).toBe("review")
    m = await finish(
      f.actors[0],
      await decide(f.actors[0], m, m.entries[0].id, "keep-both")
    )
    expect(m.entries[0].state).toBe("review")
    m = await finish(
      f.actors[0],
      await decide(f.actors[0], m, m.entries[0].id, "keep-server")
    )
    expect(m.entries[0].canonicalId).toBe(canonical.issue.id)
    expect(
      (await settle(f.actors[0], m, "reconcile")).reconciliation?.ready
    ).toBe(true)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(1)
  }, 30000)
  it("PR39 review: settled Keep-both project mappings remain authoritative for later issue imports", async () => {
    const f = await fixture(),
      key = `forge:workspace:${f.workspaceId}:initiatives:v1`
    const project = {
      id: "settled-project",
      name: "Original project",
      teamIds: [f.teamId],
      status: "Planned",
      health: "On track",
    }
    const put = async (value: unknown) =>
      pool.query(
        "INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,owner_id,key) DO UPDATE SET encoded_value=excluded.encoded_value",
        [
          f.workspaceId,
          `user:${f.actors[0].userId}`,
          f.actors[0].userId,
          key,
          JSON.stringify(
            JSON.stringify({
              version: 1,
              initiatives: [],
              workspaceProjects: [value],
            })
          ),
        ]
      )
    await put(project)
    const original = await finish(f.actors[0], await source(f, []))
    const originalId = original.entries[0].canonicalId
    await put({ ...project, name: "Reviewed project copy" })
    let m = await finish(
      f.actors[0],
      (await service.prepareImport(f.actors[0]))!
    )
    const entry = m.entries.find((e) => e.kind === "project")!
    m = await finish(
      f.actors[0],
      await decide(f.actors[0], m, entry.id, "keep-both")
    )
    const selectedId = m.entries.find((e) => e.kind === "project")!.canonicalId!
    expect(selectedId).not.toBe(originalId)
    m = await settle(f.actors[0], m, "reconcile")
    await settle(f.actors[0], m, "complete", true)
    const later = await finish(
      f.actors[0],
      await source(f, [issue("later-child", { project: "settled-project" })])
    )
    expect(later.entries[0].state).toBe("saved")
    expect(later).not.toHaveProperty("referenceContext")
    expect(
      (
        await pool.query("SELECT project_id FROM issues WHERE id=$1", [
          later.entries[0].canonicalId,
        ])
      ).rows[0].project_id
    ).toBe(selectedId)
    expect(
      (await settle(f.actors[0], later, "reconcile")).reconciliation?.ready
    ).toBe(true)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM projects WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(2)
  }, 30000)
  it("PR39 review: pre-cutover manifests inventory omitted projections and reauthorize their teams", async () => {
    const f = await fixture()
    const m = await source(f, [issue("omitted", { revision: 0 })], f.actors[1])
    const stored = JSON.parse(
      (
        await pool.query(
          "SELECT encoded_manifest FROM legacy_imports WHERE id=$1",
          [m.id]
        )
      ).rows[0].encoded_manifest
    )
    stored.entries = []
    await pool.query(
      "UPDATE legacy_imports SET encoded_manifest=$1 WHERE id=$2",
      [JSON.stringify(stored), m.id]
    )
    expect((await service.readImport(f.actors[1], m.id)).totalCount).toBe(1)
    expect(
      (await settle(f.actors[1], m, "reconcile")).reconciliation?.ready
    ).toBe(false)
    const old = JSON.parse(
      (
        await pool.query(
          "SELECT encoded_manifest FROM legacy_imports WHERE id=$1",
          [m.id]
        )
      ).rows[0].encoded_manifest
    )
    old.entries = []
    await pool.query(
      "UPDATE legacy_imports SET encoded_manifest=$1 WHERE id=$2",
      [JSON.stringify(old), m.id]
    )
    await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
      f.teamId,
    ])
    await expect(service.readImport(f.actors[1], m.id)).rejects.toThrow()
  }, 30000)
})

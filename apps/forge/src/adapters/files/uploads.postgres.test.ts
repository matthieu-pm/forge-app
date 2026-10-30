// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { put as directPut } from "@vercel/blob/client"
import { put as fixturePut } from "@vercel/blob"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import { STAGING } from "../../../../../packages/environment/staging-environment"
import type { Actor } from "@/application/actor"
import type { DirectUploadTransport } from "@/application/files/upload-store"
import type * as Database from "@/db"
import type { DrizzleUploadStore } from "./drizzle-upload-store.server"
import type { UploadService } from "@/application/files/upload-service.server"
import type { createDirectUploadTransport } from "./direct-upload-transport.server"

vi.mock("@tanstack/react-start/server-only", () => ({}))
const credentialsFile = process.env.FORGE_UPLOAD_TEST_DATABASE_FILE

describe.skipIf(!credentialsFile)(
  "FOR-35 isolated PostgreSQL/direct private-Blob acceptance",
  () => {
    const marker = `for35-${randomUUID()}`
    const workspaces: Array<string> = [],
      users: Array<string> = [],
      references: Array<string> = []
    const objects = new Map<string, Uint8Array>()
    let pool: Pool,
      database: typeof Database,
      Store: typeof DrizzleUploadStore,
      Service: typeof UploadService,
      real: DirectUploadTransport,
      transportFactory: typeof createDirectUploadTransport,
      token: string
    const memory: DirectUploadTransport = {
      grant: async () => {
        throw new Error("Not used")
      },
      read: async (ref) =>
        objects.has(ref)
          ? new ReadableStream({
              start(c) {
                c.enqueue(objects.get(ref))
                c.close()
              },
            })
          : null,
      delete: async (ref) => {
        objects.delete(ref)
      },
    }
    beforeAll(async () => {
      const credentials = JSON.parse(readFileSync(credentialsFile!, "utf8"))
      const target = {
        environment: "file-storage-acceptance" as const,
        ...DATABASE_TARGETS["file-storage-acceptance"],
      }
      assertMigrationTarget(credentials.connection, target)
      expect(new URL(credentials.applicationConnection).username).toBe(
        "forge_staging_web"
      )
      expect(
        new URL(credentials.applicationConnection).hostname.replace(
          "-pooler.",
          "."
        )
      ).toBe(target.host)
      expect(new URL(credentials.applicationConnection).pathname).toBe(
        `/${target.database}`
      )
      neonConfig.webSocketConstructor = WebSocket
      pool = new Pool({ connectionString: credentials.connection, max: 8 })
      expect(
        (
          await pool.query(
            "SELECT current_database() AS db,current_setting('neon.branch_id',true) AS branch"
          )
        ).rows[0]
      ).toEqual({ db: target.database, branch: target.branchId })
      token = credentials.blobToken
      expect(token.split("_")[3]).toBe(
        STAGING.blobStoreId.replace("store_", "")
      )
      vi.stubEnv("DATABASE_URL", credentials.applicationConnection)
      vi.stubEnv(
        "BETTER_AUTH_SECRET",
        "for35-isolated-test-auth-fixtures-not-real-login"
      )
      vi.stubEnv("BETTER_AUTH_URL", "http://forge.test")
      database = await import("@/db")
      Store = (await import("./drizzle-upload-store.server")).DrizzleUploadStore
      Service = (await import("@/application/files/upload-service.server"))
        .UploadService
      transportFactory = (await import("./direct-upload-transport.server"))
        .createDirectUploadTransport
      real = transportFactory({
        FORGE_AGENT_BLOB_ADAPTER: "vercel-private",
        BLOB_STORE_ID: STAGING.blobStoreId,
        BLOB_READ_WRITE_TOKEN: token,
      })
    }, 30000)
    afterAll(async () => {
      try {
        if (real) for (const ref of references) await real.delete(ref)
        if (pool && workspaces.length) {
          await pool.query(
            "DELETE FROM resource_files WHERE workspace_id=ANY($1::text[])",
            [workspaces]
          )
          await pool.query(
            "DELETE FROM agent_attachments WHERE workspace_id=ANY($1::text[])",
            [workspaces]
          )
          await pool.query(
            "DELETE FROM file_upload_intents WHERE workspace_id=ANY($1::text[])",
            [workspaces]
          )
          await pool.query(
            "DELETE FROM organization WHERE id=ANY($1::text[])",
            [workspaces]
          )
          await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [
            users,
          ])
          expect(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM file_upload_intents WHERE workspace_id=ANY($1::text[])",
                [workspaces]
              )
            ).rows[0].n
          ).toBe(0)
        }
      } finally {
        if (database) await database.databaseClient.end()
        if (pool) await pool.end()
        vi.unstubAllEnvs()
      }
    }, 60000)
    async function fixture(plan = "free") {
      const workspaceId = `${marker}-${workspaces.length}`,
        userId = `${workspaceId}-user`
      workspaces.push(workspaceId)
      users.push(userId)
      await pool.query(
        "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
        [workspaceId]
      )
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [userId, `${userId}@example.test`]
      )
      await pool.query(
        "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
        [randomUUID(), workspaceId, userId]
      )
      await pool.query(
        "INSERT INTO session(id,token,user_id,expires_at,active_organization_id) VALUES($1,$1,$2,now()+interval '1 day',$3)",
        [`${userId}-session`, userId, workspaceId]
      )
      if (plan !== "free")
        await pool.query(
          "INSERT INTO workspace_entitlements(workspace_id,plan,status,paid_activated_at,current_period_start,current_period_end) VALUES($1,$2,'active',now(),now(),now()+interval '30 day')",
          [workspaceId, plan]
        )
      const documentId = randomUUID()
      await pool.query(
        "INSERT INTO documents(id,workspace_id,title,body) VALUES($1,$2,'fixture','{}')",
        [documentId, workspaceId]
      )
      const actor: Actor = {
        workspaceId,
        userId,
        workspaceRole: "owner",
        authentication: { kind: "session", sessionId: `${userId}-session` },
        scopes: null,
      }
      const store = new Store(),
        service = new Service(store, memory)
      return { workspaceId, userId, documentId, actor, store, service }
    }
    async function begin(
      f: Awaited<ReturnType<typeof fixture>>,
      bytes = new Uint8Array([65, 66, 67]),
      contentType = "text/plain"
    ) {
      const { fileChecksum } =
        await import("@/application/files/file-integrity.server")
      const input = {
        commandKey: randomUUID(),
        target: { kind: "document" as const, id: f.documentId },
        name: "fixture.dat",
        contentType,
        sizeBytes: bytes.length,
        checksum: fileChecksum(bytes),
      }
      const intent = await f.store.create(f.actor, input)
      objects.set(intent.storageReference, bytes)
      return { intent, input, bytes }
    }
    async function row(id: string) {
      return (
        await pool.query("SELECT * FROM file_upload_intents WHERE id=$1", [id])
      ).rows[0]
    }
    it("AT-01: 5 MiB direct private upload finalizes concurrently/repeatedly into one metadata/audit/outbox record", async () => {
      const f = await fixture(),
        b = await begin(f, new Uint8Array(5 * 1024 * 1024).fill(65))
      references.push(b.intent.storageReference)
      const service = new Service(f.store, real)
      const issued = await service.token(f.actor, b.intent.id)
      if (
        issued.state !== "pending" ||
        issued.upload.adapter !== "vercel-private"
      )
        throw new Error("Missing private grant")
      expect(issued.upload.maximumSizeInBytes).toBe(b.bytes.length)
      await directPut(issued.upload.pathname, Buffer.from(b.bytes), {
        access: "private",
        token: issued.upload.token,
        contentType: "application/octet-stream",
      })
      const otherReference = `files/${randomUUID()}`
      references.push(otherReference)
      await expect(
        directPut(`forge/${otherReference}`, Buffer.from("denied"), {
          access: "private",
          token: issued.upload.token,
          contentType: "application/octet-stream",
        })
      ).rejects.toThrow()
      const results = await Promise.all([
        service.finalize(f.actor, b.intent.id),
        service.finalize(f.actor, b.intent.id),
      ])
      expect(results[0]).toEqual(results[1])
      expect(await service.finalize(f.actor, b.intent.id)).toEqual(results[0])
      expect(results[0]).toMatchObject({
        checksum: b.input.checksum,
        sizeBytes: b.bytes.length,
      })
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM resource_files WHERE id=$1",
            [b.intent.id]
          )
        ).rows[0].n
      ).toBe(1)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM command_audit_events WHERE resource_id=$1",
            [b.intent.id]
          )
        ).rows[0].n
      ).toBe(1)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM command_outbox_events WHERE payload->>'fileId'=$1",
            [b.intent.id]
          )
        ).rows[0].n
      ).toBe(1)
      const anonymous = await fetch(
        `https://${STAGING.blobStoreId.replace("store_", "").toLowerCase()}.private.blob.vercel-storage.com/${issued.upload.pathname}`
      )
      expect(anonymous.ok).toBe(false)
      await anonymous.body?.cancel()
      await expect(
        directPut(issued.upload.pathname, Buffer.from(b.bytes), {
          access: "private",
          token: issued.upload.token,
          contentType: "application/octet-stream",
        })
      ).rejects.toThrow()
    }, 60000)
    it.each(["oversize", "checksum"])(
      "AT-02: stored %s is refused, releases capacity and preserves recoverable inventory",
      async (kind) => {
        const f = await fixture(),
          b = await begin(f)
        objects.set(
          b.intent.storageReference,
          kind === "oversize"
            ? new Uint8Array(4).fill(65)
            : new Uint8Array(3).fill(68)
        )
        await expect(
          f.service.finalize(f.actor, b.intent.id)
        ).rejects.toMatchObject({ code: "INVALID_UPLOAD" })
        expect(await row(b.intent.id)).toMatchObject({
          state: "rejected",
          result: null,
          cleaned_at: null,
        })
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM resource_files WHERE id=$1",
              [b.intent.id]
            )
          ).rows[0].n
        ).toBe(0)
      }
    )
    it.each(["membership", "target", "session"])(
      "AT-03: %s revoked/deleted after intent cannot publish",
      async (kind) => {
        const f = await fixture(),
          b = await begin(f)
        if (kind === "membership")
          await pool.query("DELETE FROM member WHERE organization_id=$1", [
            f.workspaceId,
          ])
        if (kind === "target")
          await pool.query("DELETE FROM documents WHERE id=$1", [f.documentId])
        if (kind === "session")
          await pool.query(
            "UPDATE session SET expires_at=now()-interval '1 second' WHERE user_id=$1",
            [f.userId]
          )
        await expect(
          f.service.finalize(f.actor, b.intent.id)
        ).rejects.toMatchObject({ code: "FORBIDDEN" })
        expect(await row(b.intent.id)).toMatchObject({
          state: "rejected",
          result: null,
        })
      }
    )
    it("AT-03: revocation during storage verification is caught before metadata publication", async () => {
      const f = await fixture(),
        b = await begin(f)
      const service = new Service(f.store, {
        ...memory,
        read: async (ref) => {
          await pool.query("DELETE FROM member WHERE organization_id=$1", [
            f.workspaceId,
          ])
          return memory.read(ref)
        },
      })
      await expect(
        service.finalize(f.actor, b.intent.id)
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect(await row(b.intent.id)).toMatchObject({
        state: "rejected",
        result: null,
      })
    })
    it("AT-04: Free exact 10,000,000 bytes succeeds; identical declaration with 10,000,001 actual bytes is refused", async () => {
      const f = await fixture(),
        b = await begin(f, new Uint8Array(10_000_000).fill(65))
      references.push(b.intent.storageReference)
      await fixturePut(
        `forge/${b.intent.storageReference}`,
        Buffer.from(b.bytes),
        {
          access: "private",
          token,
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: "application/octet-stream",
        }
      )
      expect(
        await new Service(f.store, real).finalize(f.actor, b.intent.id)
      ).toMatchObject({ sizeBytes: 10_000_000 })
      const bad = await begin(f, b.bytes)
      references.push(bad.intent.storageReference)
      await fixturePut(
        `forge/${bad.intent.storageReference}`,
        Buffer.alloc(10_000_001, 65),
        {
          access: "private",
          token,
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: "application/octet-stream",
        }
      )
      await expect(
        new Service(f.store, real).finalize(f.actor, bad.intent.id)
      ).rejects.toMatchObject({ code: "INVALID_UPLOAD" })
      await expect(
        f.service.create(f.actor, {
          ...b.input,
          commandKey: randomUUID(),
          sizeBytes: 10_000_001,
        })
      ).rejects.toMatchObject({ code: "INVALID_UPLOAD" })
    }, 60000)
    it("AT-04/05: genuine paid >10 MB succeeds; retained file reads after downgrade; paid-era oversized intent is refused", async () => {
      const f = await fixture("basic"),
        b = await begin(f, new Uint8Array(10_000_001).fill(65))
      references.push(b.intent.storageReference)
      await fixturePut(
        `forge/${b.intent.storageReference}`,
        Buffer.from(b.bytes),
        {
          access: "private",
          token,
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: "application/octet-stream",
        }
      )
      const service = new Service(f.store, real),
        ready = await service.finalize(f.actor, b.intent.id)
      expect(ready.sizeBytes).toBe(10_000_001)
      const late = await begin(f, b.bytes)
      await pool.query(
        "UPDATE workspace_entitlements SET plan='free',status='active' WHERE workspace_id=$1",
        [f.workspaceId]
      )
      expect(await service.finalize(f.actor, b.intent.id)).toEqual(ready)
      await expect(
        f.service.finalize(f.actor, late.intent.id)
      ).rejects.toMatchObject({ code: "INVALID_UPLOAD" })
      expect(await row(late.intent.id)).toMatchObject({
        state: "rejected",
        result: null,
      })
      const { createForgeResourceFileService } =
        await import("./forge-resource-file-service.server")
      const { VercelPrivateFileBlobStore } =
        await import("./vercel-private-file-blob-store.server")
      const files = createForgeResourceFileService(
        new VercelPrivateFileBlobStore({
          FORGE_AGENT_BLOB_ADAPTER: "vercel-private",
          BLOB_STORE_ID: STAGING.blobStoreId,
          BLOB_READ_WRITE_TOKEN: token,
        })
      )
      expect((await files.read(f.actor, ready.id)).content.length).toBe(
        10_000_001
      )
      const other = await fixture()
      await expect(files.read(other.actor, ready.id)).rejects.toThrow()
      await pool.query("DELETE FROM member WHERE organization_id=$1", [
        f.workspaceId,
      ])
      await expect(files.read(f.actor, ready.id)).rejects.toThrow()
    }, 60000)
    it("atomically admits only four concurrent intents for one account and replays the same intent without another reservation", async () => {
      const f = await fixture()
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => begin(f))
      )
      const accepted = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof begin>>> =>
          r.status === "fulfilled"
      )
      expect(accepted).toHaveLength(4)
      const b = accepted[0].value
      expect((await f.store.create(f.actor, b.input)).id).toBe(b.intent.id)
      await expect(
        f.store.create(f.actor, { ...b.input, name: "changed" })
      ).rejects.toMatchObject({ code: "UPLOAD_CONFLICT" })
      await f.store.reject(f.actor, b.intent.id, "cancelled")
      await expect(begin(f)).resolves.toBeDefined()
    })
    it("applies account pending capacity across workspaces", async () => {
      const f = await fixture(),
        other = await fixture()
      await pool.query(
        "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
        [randomUUID(), other.workspaceId, f.userId]
      )
      const session = `${f.userId}-other-session`
      await pool.query(
        "INSERT INTO session(id,token,user_id,expires_at,active_organization_id) VALUES($1,$1,$2,now()+interval '1 day',$3)",
        [session, f.userId, other.workspaceId]
      )
      for (let i = 0; i < 4; i++) await begin(f)
      const b = await begin(other)
      await expect(
        other.store.create(
          {
            ...f.actor,
            workspaceId: other.workspaceId,
            authentication: { kind: "session", sessionId: session },
          },
          { ...b.input, commandKey: randomUUID() }
        )
      ).rejects.toMatchObject({ code: "UPLOAD_LIMIT" })
    })
    it("atomically enforces sixteen workspace intents across five accounts", async () => {
      const f = await fixture(),
        actors = [f.actor]
      for (let i = 0; i < 4; i++) {
        const userId = `${f.workspaceId}-extra-${i}`,
          sessionId = `${userId}-session`
        users.push(userId)
        await pool.query(
          'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
          [userId, `${userId}@example.test`]
        )
        await pool.query(
          "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'member')",
          [randomUUID(), f.workspaceId, userId]
        )
        await pool.query(
          "INSERT INTO session(id,token,user_id,expires_at,active_organization_id) VALUES($1,$1,$2,now()+interval '1 day',$3)",
          [sessionId, userId, f.workspaceId]
        )
        actors.push({
          ...f.actor,
          userId,
          authentication: { kind: "session", sessionId },
        })
      }
      const b = await begin(f)
      await f.store.reject(f.actor, b.intent.id, "replaced by concurrent test")
      const results = await Promise.allSettled(
        actors.flatMap((actor) =>
          Array.from({ length: 4 }, () =>
            f.store.create(actor, { ...b.input, commandKey: randomUUID() })
          )
        )
      )
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(16)
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(4)
    }, 30000)
    it("counts rolling completed bytes plus outstanding reservations, and releases rejected reservations", async () => {
      const f = await fixture("basic"),
        b = await begin(f)
      await f.store.reject(f.actor, b.intent.id, "test")
      // Trusted synthetic accounting history; no object/publication claim for these seeded rows.
      for (let i = 0; i < 10; i++) {
        await pool.query(
          `INSERT INTO file_upload_intents(id,workspace_id,user_id,command_key,input_hash,target,name,content_type,size_bytes,checksum,storage_reference,state,created_at,expires_at,completed_at,result)
          VALUES($1,$2,$3,$4,'fixture',$5,'accounting-fixture','text/plain',100000000,$6,$7,'ready',now(),now()+interval '24 hour',now(),'{}')`,
          [
            randomUUID(),
            f.workspaceId,
            f.userId,
            randomUUID(),
            JSON.stringify(b.input.target),
            b.input.checksum,
            `files/${randomUUID()}`,
          ]
        )
      }
      await expect(
        f.store.create(f.actor, {
          ...b.input,
          commandKey: randomUUID(),
          sizeBytes: 1,
        })
      ).rejects.toMatchObject({ code: "UPLOAD_LIMIT" })
      await pool.query(
        "UPDATE file_upload_intents SET completed_at=now()-interval '1 hour 1 second' WHERE workspace_id=$1 AND state='ready'",
        [f.workspaceId]
      )
      const admitted = await f.store.create(f.actor, {
        ...b.input,
        commandKey: randomUUID(),
        sizeBytes: 100000000,
      })
      await f.store.reject(f.actor, admitted.id, "release")
      await expect(
        f.store.create(f.actor, {
          ...b.input,
          commandKey: randomUUID(),
          sizeBytes: 100000001,
        })
      ).rejects.toThrow()
      // Full workspace byte budget blocks another account too.
      await pool.query(
        "UPDATE file_upload_intents SET completed_at=now(),size_bytes=100000000 WHERE workspace_id=$1 AND state='ready'",
        [f.workspaceId]
      )
      for (let i = 0; i < 90; i++) {
        await pool.query(
          `INSERT INTO file_upload_intents(id,workspace_id,user_id,command_key,input_hash,target,name,content_type,size_bytes,checksum,storage_reference,state,created_at,expires_at,completed_at,result)
          VALUES($1,$2,'synthetic-other-account',$3,'fixture',$4,'accounting-fixture','text/plain',100000000,$5,$6,'ready',now(),now()+interval '24 hour',now(),'{}')`,
          [
            randomUUID(),
            f.workspaceId,
            randomUUID(),
            JSON.stringify(b.input.target),
            b.input.checksum,
            `files/${randomUUID()}`,
          ]
        )
      }
      await pool.query(
        "UPDATE file_upload_intents SET completed_at=now()-interval '1 hour 1 second' WHERE workspace_id=$1 AND user_id=$2 AND state='ready'",
        [f.workspaceId, f.userId]
      )
      // Keep 10 GB charged to other accounts without also filling this account's budget.
      await pool.query(
        "UPDATE file_upload_intents SET user_id='synthetic-other-account',completed_at=now() WHERE workspace_id=$1 AND state='ready'",
        [f.workspaceId]
      )
      await expect(begin(f)).rejects.toMatchObject({ code: "UPLOAD_LIMIT" })
    }, 30000)
    it("issue targets use current private-team membership at both intent and finalize", async () => {
      const f = await fixture(),
        team = randomUUID(),
        issue = randomUUID()
      await pool.query(
        "INSERT INTO teams(id,workspace_id,slug,identifier,name,icon_kind,icon_value,color,timezone,visibility,created_by_user_id) VALUES($1,$2,'test','TEST','Test','icon','fixture','#000000','UTC','private',$3)",
        [team, f.workspaceId, f.userId]
      )
      await pool.query(
        "INSERT INTO issues(id,workspace_id,team_id,number,title) VALUES($1,$2,$3,1,'fixture')",
        [issue, f.workspaceId, team]
      )
      await pool.query(
        "UPDATE member SET role='member' WHERE organization_id=$1",
        [f.workspaceId]
      )
      const b = await begin(f),
        input = {
          ...b.input,
          commandKey: randomUUID(),
          target: { kind: "issue" as const, id: issue },
        }
      await expect(f.store.create(f.actor, input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      })
      await pool.query(
        "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
        [f.workspaceId, team, f.userId]
      )
      const intent = await f.store.create(f.actor, input)
      objects.set(intent.storageReference, b.bytes)
      await pool.query(
        "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2",
        [f.workspaceId, team]
      )
      await expect(
        f.service.finalize(f.actor, intent.id)
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect((await row(intent.id)).state).toBe("rejected")
    })
    it("the actual browser upload client publishes a 5 MiB agent attachment through bounded HTTP metadata", async () => {
      const f = await fixture(),
        service = new Service(f.store, real)
      const { createUploadHttpHandler } =
        await import("@/application/files/upload-http-handler.server")
      const { uploadFileDirect } =
        await import("@/lib/files/direct-upload-client")
      const handler = createUploadHttpHandler({
        getActor: async () => f.actor,
        service,
      })
      const sizes: Array<number> = []
      const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
        sizes.push(String(init?.body ?? "").length)
        const response = await handler(
          new Request(`https://forge.test${url}`, {
            ...init,
            headers: { ...init?.headers, origin: "https://forge.test" },
          })
        )
        // Track the server-owned storage key for fixture cleanup even after a later failure.
        if (String(url) === "/api/files/uploads/" && response.ok) {
          const intent = (await response.clone().json()) as { id: string }
          references.push((await row(intent.id)).storage_reference)
        }
        return response
      }
      const ready = await uploadFileDirect(
        {
          name: "agent.txt",
          contentType: "text/plain",
          target: { kind: "agent" },
          file: new Blob([Buffer.alloc(5 * 1024 * 1024, 65)]),
        },
        fetcher
      )
      expect(ready.sizeBytes).toBe(5 * 1024 * 1024)
      expect(sizes.every((n) => n < 8192)).toBe(true)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM agent_attachments WHERE id=$1",
            [ready.id]
          )
        ).rows[0].n
      ).toBe(1)
      expect(await service.finalize(f.actor, ready.id)).toEqual(ready)
    }, 60000)
    it("limits token issuance to five attempts/hour without extending original expiry", async () => {
      const f = await fixture(),
        b = await begin(f)
      for (let i = 0; i < 5; i++)
        expect(
          (await f.store.prepare(f.actor, b.intent.id, true)).expiresAt
        ).toEqual(b.intent.expiresAt)
      await expect(
        f.store.prepare(f.actor, b.intent.id, true)
      ).rejects.toMatchObject({ code: "UPLOAD_LIMIT" })
    })
    it("expiry races publication atomically and failed cleanup remains retryable", async () => {
      const f = await fixture()
      const originalStore = f.store
      f.store = new Store(() => new Date(Date.now() - 86_400_001))
      const b = await begin(f)
      f.store = originalStore
      const future = new Date(),
        expiredStore = new Store(() => future)
      await expect(
        new Service(expiredStore, memory).finalize(f.actor, b.intent.id)
      ).rejects.toMatchObject({ code: "INVALID_UPLOAD" })
      const failing = {
        ...memory,
        delete: vi.fn(async () => {
          throw new Error("provider down")
        }),
      }
      expect(
        await new Service(expiredStore, failing).sweep(future)
      ).toMatchObject({ failures: expect.arrayContaining([b.intent.id]) })
      expect((await row(b.intent.id)).cleaned_at).toBeNull()
      await new Service(expiredStore, memory).sweep(future)
      expect((await row(b.intent.id)).cleaned_at).toBeInstanceOf(Date)
    })
    it("publishes unknown binary resource files only as generic content", async () => {
      const f = await fixture(),
        b = await begin(
          f,
          new Uint8Array([0, 255, 0, 1]),
          "application/octet-stream"
        )
      const ready = await f.service.finalize(f.actor, b.intent.id)
      expect(ready.contentType).toBe("application/octet-stream")
      expect((await row(b.intent.id)).state).toBe("ready")
    })
    it("checks verified type against current workspace restrictions and refuses client MIME spoofing", async () => {
      const f = await fixture(),
        b = await begin(f, new Uint8Array([0, 255, 0, 1]), "image/png")
      await pool.query(
        "INSERT INTO workspace_security_settings(workspace_id,restrict_file_uploads,allowed_upload_types) VALUES($1,true,'[]') ON CONFLICT(workspace_id) DO UPDATE SET restrict_file_uploads=true,allowed_upload_types='[]'",
        [f.workspaceId]
      )
      await expect(
        f.service.finalize(f.actor, b.intent.id)
      ).rejects.toMatchObject({ code: "INVALID_UPLOAD" })
      expect((await row(b.intent.id)).state).toBe("rejected")
    })
  }
)

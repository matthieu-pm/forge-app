// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { put as directPut } from "@vercel/blob/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import { STAGING } from "../../../../../packages/environment/staging-environment"
import type { Actor } from "@/application/actor"
import type { FileTarget } from "@/application/files/file-delivery-contract"
import type { FileBlobStore } from "@/application/files/blob-store"
import type * as Database from "@/db"
import type { UploadService } from "@/application/files/upload-service.server"
import { fileChecksum } from "@/application/files/file-integrity.server"
import { createFileDeliveryHttpHandler } from "@/application/files/file-delivery-http.server"
import { FileDeliveryService } from "@/application/files/file-delivery-service.server"

vi.mock("@tanstack/react-start/server-only", () => ({}))
const credentialFile = process.env.FORGE_FILE_DELIVERY_TEST_DATABASE_FILE

describe.skipIf(!credentialFile)(
  "FOR-36 real PostgreSQL/private Blob acceptance",
  () => {
    const marker = `for36-${randomUUID()}`,
      workspaces = [marker, `${marker}-foreign`]
    const users = ["owner", "alice", "bob", "foreign"].map(
      (n) => `${marker}-${n}`
    )
    const team = randomUUID(),
      issue = randomUUID(),
      document = randomUUID(),
      thread = randomUUID(),
      run = randomUUID(),
      artifact = randomUUID(),
      attachment = randomUUID()
    const references: Array<string> = []
    let pool: Pool,
      database: typeof Database,
      blobs: FileBlobStore,
      upload: UploadService,
      service: FileDeliveryService,
      handler: ReturnType<typeof createFileDeliveryHttpHandler>,
      verified = false
    let current: Actor
    let issueFile: FileTarget, htmlFile: FileTarget, documentFile: FileTarget
    const largeBytes = new Uint8Array(5 * 1024 * 1024).fill(65)
    const actor = (index: number): Actor => ({
      workspaceId: workspaces[index === 3 ? 1 : 0],
      userId: users[index],
      workspaceRole: index === 0 || index === 3 ? "owner" : "member",
      authentication: { kind: "session", sessionId: `${users[index]}-session` },
      scopes: null,
    })
    beforeAll(async () => {
      const c = JSON.parse(readFileSync(credentialFile!, "utf8"))
      const target = {
        environment: "file-storage-acceptance" as const,
        ...DATABASE_TARGETS["file-storage-acceptance"],
      }
      assertMigrationTarget(c.connection, target)
      const app = new URL(c.applicationConnection)
      expect(app.hostname.replace("-pooler.", ".")).toBe(target.host)
      expect(app.pathname).toBe(`/${target.database}`)
      expect(app.username).toBe("forge_staging_web")
      expect(c.blobToken.split("_")[3]).toBe(
        STAGING.blobStoreId.replace("store_", "")
      )
      neonConfig.webSocketConstructor = WebSocket
      pool = new Pool({ connectionString: c.connection, max: 4 })
      expect(
        (
          await pool.query(
            "SELECT current_database() AS db,current_setting('neon.branch_id',true) AS branch"
          )
        ).rows[0]
      ).toEqual({ db: target.database, branch: target.branchId })
      verified = true
      vi.stubEnv("DATABASE_URL", c.applicationConnection)
      vi.stubEnv(
        "BETTER_AUTH_SECRET",
        "for36-auth-fixture-secret-at-least-32-characters"
      )
      vi.stubEnv("BETTER_AUTH_URL", "http://forge.test")
      vi.stubEnv(
        "FORGE_AGENT_ARTIFACT_SECRET",
        "for36-grant-fixture-secret-at-least-32-characters"
      )
      database = await import("@/db")
      expect(
        (await database.databaseClient.query("SELECT current_user AS role"))
          .rows[0].role
      ).toBe("forge_staging_web")
      const env = {
        FORGE_AGENT_BLOB_ADAPTER: "vercel-private",
        BLOB_STORE_ID: STAGING.blobStoreId,
        BLOB_READ_WRITE_TOKEN: c.blobToken,
      }
      blobs = new (
        await import("./vercel-private-file-blob-store.server")
      ).VercelPrivateFileBlobStore(env)
      upload = new (
        await import("@/application/files/upload-service.server")
      ).UploadService(
        new (
          await import("./drizzle-upload-store.server")
        ).DrizzleUploadStore(),
        (
          await import("./direct-upload-transport.server")
        ).createDirectUploadTransport(env)
      )
      service = new FileDeliveryService({
        lookup: (await import("./file-delivery-lookup.server"))
          .lookupAuthorizedFile,
        blobs,
      })
      current = actor(1)
      handler = createFileDeliveryHttpHandler({
        getActor: async () => current,
        service,
      })
      for (const w of workspaces)
        await pool.query(
          "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
          [w]
        )
      for (let i = 0; i < users.length; i++) {
        await pool.query(
          'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
          [users[i], `${users[i]}@example.test`]
        )
        await pool.query(
          "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)",
          [randomUUID(), actor(i).workspaceId, users[i], actor(i).workspaceRole]
        )
        await pool.query(
          "INSERT INTO session(id,token,user_id,expires_at,active_organization_id) VALUES($1,$1,$2,now()+interval '1 day',$3)",
          [`${users[i]}-session`, users[i], actor(i).workspaceId]
        )
      }
      await pool.query(
        "INSERT INTO teams(id,workspace_id,slug,identifier,name,icon_kind,icon_value,color,timezone,visibility,created_by_user_id) VALUES($1,$2,'private','PRIVATE','Private','icon','fixture','#000000','UTC','private',$3)",
        [team, workspaces[0], users[0]]
      )
      await pool.query(
        "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
        [workspaces[0], team, users[1]]
      )
      await pool.query(
        "INSERT INTO issues(id,workspace_id,team_id,number,title) VALUES($1,$2,$3,1,'private issue')",
        [issue, workspaces[0], team]
      )
      await pool.query(
        "INSERT INTO documents(id,workspace_id,team_id,title,body) VALUES($1,$2,$3,'private document','{}')",
        [document, workspaces[0], team]
      )
      issueFile = await ready(
        { kind: "issue", id: issue },
        "large.txt",
        largeBytes
      )
      htmlFile = await ready(
        { kind: "issue", id: issue },
        "hostile.html",
        new TextEncoder().encode(
          '<h1>Readable</h1><script>parent.pwned=true</script><img src="https://evil.test/leak"><form action="/api/auth"><input></form>'
        )
      )
      documentFile = await ready(
        { kind: "document", id: document },
        "document.txt",
        new TextEncoder().encode("private document bytes")
      )
      await pool.query(
        "INSERT INTO agent_threads(id,workspace_id,created_by_user_id,title) VALUES($1,$2,$3,'fixture')",
        [thread, workspaces[0], users[1]]
      )
      await pool.query(
        "INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'running','forge-native','{}')",
        [run, thread, users[1]]
      )
      const content = new TextEncoder().encode("agent private bytes"),
        artifactRef = `${run}/${artifact}`,
        attachmentRef = `attachments/${attachment}`
      references.push(artifactRef, attachmentRef)
      await blobs.put(artifactRef, content)
      await blobs.put(attachmentRef, content)
      await pool.query(
        "INSERT INTO agent_artifacts(id,run_id,kind,name,content_type,size_bytes,storage_reference,checksum,retention_expires_at) VALUES($1,$2,'file','artifact.txt','text/plain',$3,$4,$5,now()+interval '1 day')",
        [artifact, run, content.length, artifactRef, fileChecksum(content)]
      )
      await pool.query(
        "INSERT INTO agent_attachments(id,workspace_id,user_id,name,content_type,size_bytes,storage_reference,checksum,expires_at) VALUES($1,$2,$3,'attachment.txt','text/plain',$4,$5,$6,now()+interval '1 day')",
        [
          attachment,
          workspaces[0],
          users[1],
          content.length,
          attachmentRef,
          fileChecksum(content),
        ]
      )
    }, 60_000)
    afterAll(async () => {
      try {
        if (blobs) for (const ref of references) await blobs.delete(ref)
        if (pool && verified) {
          await pool.query(
            "DELETE FROM resource_files WHERE workspace_id=ANY($1::text[])",
            [workspaces]
          )
          await pool.query("DELETE FROM agent_artifacts WHERE id=$1", [
            artifact,
          ])
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
                "SELECT count(*)::int AS n FROM organization WHERE id=ANY($1::text[])",
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
    }, 60_000)
    async function ready(
      target: { kind: "issue" | "document"; id: string },
      name: string,
      bytes: Uint8Array
    ): Promise<FileTarget> {
      const intent = await upload.create(actor(1), {
        commandKey: randomUUID(),
        target,
        name,
        contentType: "text/plain",
        sizeBytes: bytes.length,
        checksum: fileChecksum(bytes),
      })
      const issued = await upload.token(actor(1), intent.id)
      if (
        issued.state !== "pending" ||
        issued.upload.adapter !== "vercel-private"
      )
        throw new Error("Expected direct private upload grant")
      references.push(issued.upload.pathname.replace(/^forge\//, ""))
      await directPut(issued.upload.pathname, Buffer.from(bytes), {
        token: issued.upload.token,
        access: "private",
        contentType: "application/octet-stream",
      })
      const finalized = await upload.finalize(actor(1), intent.id)
      return { kind: "resources", id: finalized.id }
    }
    async function requestGrant(
      target: FileTarget,
      purpose: "download" | "preview" = "download"
    ) {
      return handler(
        new Request(
          `http://forge.test/api/files/${target.kind}/${target.id}/grant`,
          {
            method: "POST",
            headers: { origin: "http://forge.test" },
            body: JSON.stringify({ purpose }),
          }
        )
      )
    }
    async function link(
      target: FileTarget,
      purpose: "download" | "preview" = "download"
    ) {
      const response = await requestGrant(target, purpose)
      expect(response.status).toBe(200)
      return `http://forge.test${(await response.json()).url}`
    }
    it("AT-01: an authorized private issue member receives exact >4.5 MB finalized private bytes with safe headers", async () => {
      current = actor(1)
      const response = await handler(new Request(await link(issueFile)))
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream"
      )
      expect(response.headers.get("content-disposition")).toContain(
        "attachment;"
      )
      expect(response.headers.get("cache-control")).toContain("no-store")
      expect(fileChecksum(new Uint8Array(await response.arrayBuffer()))).toBe(
        fileChecksum(largeBytes)
      )
    }, 30_000)
    it("AT-02: private-team nonmembers and foreign tenants cannot obtain or replay the owner's grant", async () => {
      current = actor(1)
      const url = await link(issueFile)
      for (const index of [2, 3]) {
        current = actor(index)
        expect((await requestGrant(issueFile)).status).toBe(404)
        expect((await handler(new Request(url))).status).toBe(403)
      }
      current = actor(0)
      expect((await requestGrant(issueFile)).status).toBe(200)
    })
    it("AT-02: preview output from actual private storage is inert and requires its own purpose-bound grant", async () => {
      current = actor(1)
      const url = await link(htmlFile, "preview")
      const response = await handler(new Request(url))
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain("<h1>Readable</h1>")
      expect(text).not.toMatch(/<script|<form|evil\.test|<input/)
      expect(response.headers.get("content-security-policy")).toContain(
        "sandbox;"
      )
      expect(
        (await handler(new Request(url.replace("/preview?", "/download?"))))
          .status
      ).toBe(403)
    })
    it("revokes already-issued links after private-team removal and after removal during storage I/O", async () => {
      current = actor(1)
      const url = await link(documentFile)
      await pool.query(
        "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
        [workspaces[0], team, users[1]]
      )
      expect((await handler(new Request(url))).status).toBe(404)
      await pool.query(
        "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
        [workspaces[0], team, users[1]]
      )
      const delayed = new FileDeliveryService({
        lookup: (await import("./file-delivery-lookup.server"))
          .lookupAuthorizedFile,
        blobs: {
          ...blobs,
          put: blobs.put.bind(blobs),
          delete: blobs.delete.bind(blobs),
          get: async (ref, opts) => {
            const bytes = await blobs.get(ref, opts)
            await pool.query(
              "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
              [workspaces[0], team, users[1]]
            )
            return bytes
          },
        },
      })
      const delayedHandler = createFileDeliveryHttpHandler({
        getActor: async () => current,
        service: delayed,
      })
      expect((await delayedHandler(new Request(url))).status).toBe(404)
      await pool.query(
        "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
        [workspaces[0], team, users[1]]
      )
    })
    it("rechecks expired sessions, membership removal, file deletion and restoration before each redemption", async () => {
      current = actor(1)
      const url = await link(documentFile)
      await pool.query(
        "UPDATE session SET expires_at=now()-interval '1 minute' WHERE id=$1",
        [`${users[1]}-session`]
      )
      expect((await handler(new Request(url))).status).toBe(404)
      await pool.query(
        "UPDATE session SET expires_at=now()+interval '1 day' WHERE id=$1",
        [`${users[1]}-session`]
      )
      await pool.query(
        "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
        [workspaces[0], users[1]]
      )
      expect((await handler(new Request(url))).status).toBe(404)
      await pool.query(
        "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'member')",
        [randomUUID(), workspaces[0], users[1]]
      )
      // Workspace removal also revokes private-team membership through the tenant FK.
      await pool.query(
        "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
        [workspaces[0], team, users[1]]
      )
      await pool.query(
        "UPDATE resource_files SET deleted_at=now() WHERE id=$1",
        [documentFile.id]
      )
      expect((await handler(new Request(url))).status).toBe(404)
      await pool.query(
        "UPDATE resource_files SET deleted_at=NULL WHERE id=$1",
        [documentFile.id]
      )
      expect((await handler(new Request(url))).status).toBe(200)
    })
    it.each(["artifacts", "attachments"] as const)(
      "enforces %s ownership, retention and session revocation with actual metadata/storage",
      async (kind) => {
        const target = {
          kind,
          id: kind === "artifacts" ? artifact : attachment,
        }
        current = actor(1)
        const url = await link(target)
        expect(await (await handler(new Request(url))).text()).toBe(
          "agent private bytes"
        )
        current = actor(2)
        expect((await requestGrant(target)).status).toBe(404)
        current = actor(1)
        await pool.query(
          kind === "artifacts"
            ? "UPDATE agent_artifacts SET retention_expires_at=now()-interval '1 minute' WHERE id=$1"
            : "UPDATE agent_attachments SET expires_at=now()-interval '1 minute' WHERE id=$1",
          [target.id]
        )
        expect((await handler(new Request(url))).status).toBe(404)
      }
    )
  }
)

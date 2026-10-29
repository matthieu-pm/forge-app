// @vitest-environment node
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { STAGING } from "../../../../../packages/environment/staging-environment"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import { VercelPrivateFileBlobStore } from "./vercel-private-file-blob-store.server"
import type { Actor } from "@/application/actor"
import type * as Database from "@/db"
import { fileChecksum } from "@/application/files/file-integrity.server"

vi.mock("@tanstack/react-start/server-only", () => ({}))
const credentialsFile = process.env.FORGE_FILE_STORAGE_TEST_DATABASE_FILE
const manifestFile = process.env.FORGE_FILE_STORAGE_TEST_MANIFEST
const phase = process.env.FORGE_FILE_STORAGE_TEST_PHASE
const token = process.env.FORGE_STAGING_BLOB_TEST_TOKEN

type Manifest = {
  workspace: string
  user: string
  team: string
  issue: string
  document: string
  thread: string
  run: string
  artifact?: string
  attachment?: string
  files: Array<string>
  references: Array<string>
  writerPid: number
}
const content = new TextEncoder().encode(
  "FOR-34 private durable synthetic bytes\u0000\u00ff"
)

describe.skipIf(!credentialsFile || !manifestFile || !token)(
  "FOR-34 isolated independent-process acceptance",
  () => {
    let pool: Pool,
      database: typeof Database,
      manifest: Manifest,
      blobs: VercelPrivateFileBlobStore
    let verified = false
    const target = {
      environment: "file-storage-acceptance" as const,
      ...DATABASE_TARGETS["file-storage-acceptance"],
    }
    const save = () =>
      writeFileSync(manifestFile!, JSON.stringify(manifest), { mode: 0o600 })
    const actor = (): Actor => ({
      userId: manifest.user,
      workspaceId: manifest.workspace,
      workspaceRole: "owner",
      authentication: {
        kind: "session",
        sessionId: `${manifest.user}-session`,
      },
      scopes: null,
    })
    beforeAll(async () => {
      const { connection, applicationConnection } = JSON.parse(
        readFileSync(credentialsFile!, "utf8")
      )
      assertMigrationTarget(connection, target)
      const appUrl = new URL(applicationConnection)
      expect(appUrl.username).toBe("forge_staging_web")
      expect(appUrl.hostname).toBe(target.host.replace(".", "-pooler."))
      expect(appUrl.pathname).toBe(`/${target.database}`)
      expect(token!.split("_")[3]).toBe(
        STAGING.blobStoreId.replace("store_", "")
      )
      neonConfig.webSocketConstructor = WebSocket
      pool = new Pool({ connectionString: connection, max: 2 })
      const identity = (
        await pool.query(
          "SELECT current_database() AS database,current_setting('neon.branch_id',true) AS branch"
        )
      ).rows[0]
      expect(identity).toEqual({
        database: target.database,
        branch: target.branchId,
      })
      verified = true
      vi.stubEnv("DATABASE_URL", applicationConnection)
      vi.stubEnv("BLOB_STORE_ID", STAGING.blobStoreId)
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", token)
      database = await import("@/db")
      blobs = new VercelPrivateFileBlobStore()
      if (phase === "writer") {
        const marker = `for34-${randomUUID()}`
        manifest = {
          workspace: marker,
          user: marker,
          team: randomUUID(),
          issue: randomUUID(),
          document: randomUUID(),
          thread: randomUUID(),
          run: randomUUID(),
          files: [],
          references: [],
          writerPid: process.pid,
        }
        save()
      } else manifest = JSON.parse(readFileSync(manifestFile!, "utf8"))
    }, 30_000)
    afterAll(async () => {
      if (verified) await database?.databaseClient.end()
      await pool?.end()
      vi.unstubAllEnvs()
    })
    async function services() {
      const [
        { DrizzleAgentStore },
        { DrizzleAgentEventStore },
        { DrizzleAgentArtifactStore },
        { DrizzleAgentAttachmentStore },
        { AgentArtifactService },
        { AgentAttachmentService },
        { createForgeResourceFileService },
        { requireCurrentActor },
      ] = await Promise.all([
        import("@/adapters/agents/drizzle-agent-store.server"),
        import("@/adapters/agents/drizzle-event-store.server"),
        import("@/adapters/agents/drizzle-artifact-store.server"),
        import("@/adapters/agents/drizzle-attachment-store.server"),
        import("@/application/agents/artifact-service.server"),
        import("@/application/agents/attachment-service.server"),
        import("./forge-resource-file-service.server"),
        import("@/application/resource-policy.server"),
      ])
      return {
        artifacts: new AgentArtifactService({
          authorizeActor: requireCurrentActor,
          metadata: new DrizzleAgentArtifactStore(),
          blobs,
          agents: new DrizzleAgentStore(),
          events: new DrizzleAgentEventStore(),
        }),
        attachments: new AgentAttachmentService({
          authorizeActor: requireCurrentActor,
          metadata: new DrizzleAgentAttachmentStore(),
          blobs,
        }),
        resources: createForgeResourceFileService(blobs),
      }
    }
    it.skipIf(phase !== "writer")(
      "instance A persists artifacts, attachments, issue and document files through real application metadata adapters",
      async () => {
        await pool.query(
          "INSERT INTO public.organization(id,name,slug) VALUES($1,$1,$1)",
          [manifest.workspace]
        )
        await pool.query(
          'INSERT INTO public."user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
          [manifest.user, `${manifest.user}@example.test`]
        )
        await pool.query(
          "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
          [randomUUID(), manifest.workspace, manifest.user]
        )
        await pool.query(
          "INSERT INTO public.session(id,token,user_id,expires_at,active_organization_id) VALUES($1,$1,$2,now()+interval '1 hour',$3)",
          [`${manifest.user}-session`, manifest.user, manifest.workspace]
        )
        await pool.query(
          "INSERT INTO public.teams(id,workspace_id,slug,identifier,name,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'F34','F34','Fixture','icon','fixture','#000000','UTC',$3)",
          [manifest.team, manifest.workspace, manifest.user]
        )
        await pool.query(
          "INSERT INTO public.issues(id,workspace_id,team_id,number,title) VALUES($1,$2,$3,1,'Fixture')",
          [manifest.issue, manifest.workspace, manifest.team]
        )
        await pool.query(
          "INSERT INTO public.documents(id,workspace_id,title) VALUES($1,$2,'Fixture')",
          [manifest.document, manifest.workspace]
        )
        await pool.query(
          "INSERT INTO public.agent_threads(id,workspace_id,created_by_user_id) VALUES($1,$2,$3)",
          [manifest.thread, manifest.workspace, manifest.user]
        )
        await pool.query(
          "INSERT INTO public.agent_runs(id,thread_id,initiated_by_user_id,execution_kind,requested_selection) VALUES($1,$2,$3,'forge-native','{}')",
          [manifest.run, manifest.thread, manifest.user]
        )
        const s = await services()
        manifest.artifact = (
          await s.artifacts.create(actor(), manifest.run, {
            kind: "file",
            name: "fixture.bin",
            contentType: "text/plain",
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
          })
        ).id
        save()
        manifest.attachment = (
          await s.attachments.upload(actor(), {
            name: "fixture.bin",
            contentType: "text/plain",
            contentBase64: Buffer.from(content).toString("base64"),
          })
        ).id
        save()
        for (const kind of ["issue", "document"] as const) {
          manifest.files.push(
            (
              await s.resources.create(
                actor(),
                { kind, id: manifest[kind] },
                {
                  name: "fixture.bin",
                  contentType: "text/plain",
                  content,
                }
              )
            ).id
          )
          save()
        }
        const rows = await pool.query(
          "SELECT storage_reference,checksum,size_bytes FROM public.agent_artifacts WHERE run_id=$1 UNION ALL SELECT storage_reference,checksum,size_bytes FROM public.agent_attachments WHERE workspace_id=$2 UNION ALL SELECT storage_reference,checksum,size_bytes FROM public.resource_files WHERE workspace_id=$2",
          [manifest.run, manifest.workspace]
        )
        expect(rows.rows).toHaveLength(4)
        for (const row of rows.rows)
          expect(row).toMatchObject({
            checksum: fileChecksum(content),
            size_bytes: content.byteLength,
          })
        manifest.references = rows.rows.map((row) => row.storage_reference)
        save()
      },
      60_000
    )
    it.skipIf(phase !== "writer")(
      "migrates remaining legacy local bytes through the operator CLI with verified retry",
      async () => {
        const { LocalFileBlobStore } =
          await import("./local-file-blob-store.server")
        const directory = await mkdtemp(join(tmpdir(), "forge-legacy-files-"))
        try {
          const reference = `attachments/${manifest.attachment}`
          const local = new LocalFileBlobStore(directory)
          await local.put(reference, content)
          await blobs.delete(reference)
          const invoke = (mode: string) =>
            spawnSync("bun", ["scripts/migrate-local-files.ts", mode], {
              cwd: new URL("../../..", import.meta.url),
              env: {
                ...process.env,
                FORGE_AGENT_BLOB_ADAPTER: "vercel-private",
                FORGE_AGENT_ARTIFACT_DIRECTORY: directory,
              },
              encoding: "utf8",
            })
          const check = invoke("--check")
          expect(check.status).toBe(1)
          expect(JSON.parse(check.stdout).requiresCopy).toBe(1)
          const apply = invoke("--apply")
          expect(apply.status, apply.stderr).toBe(0)
          expect(JSON.parse(apply.stdout).copied).toBe(1)
          expect(await local.get(reference)).toEqual(content)
          const retry = invoke("--apply")
          expect(retry.status, retry.stderr).toBe(0)
          expect(JSON.parse(retry.stdout)).toMatchObject({
            copied: 0,
            alreadyDurable: 2,
            requiresCopy: 0,
          })
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      },
      30_000
    )
    it.skipIf(phase !== "reader")(
      "AT-01: fresh instance B reads identical content/checksums after writer process has exited",
      async () => {
        expect(process.pid).not.toBe(manifest.writerPid)
        const s = await services()
        const artifact = await s.artifacts.read(actor(), manifest.artifact!)
        expect(artifact.content).toEqual(content)
        expect(artifact.artifact.checksum).toBe(fileChecksum(content))
        const [attachment] = await s.attachments.resolve(actor(), [
          manifest.attachment!,
        ])
        expect(Buffer.from(attachment.contentBase64, "base64")).toEqual(
          Buffer.from(content)
        )
        expect(attachment.checksum).toBe(fileChecksum(content))
        for (const id of manifest.files) {
          const file = await s.resources.read(actor(), id)
          expect(file.content).toEqual(content)
          expect(file.file.checksum).toBe(fileChecksum(content))
        }
      },
      30_000
    )
    it.skipIf(phase !== "reader")(
      "AT-02: anonymous direct private URLs deny all four existing objects; immutable writes cannot replace them",
      async () => {
        for (const reference of manifest.references) {
          const response = await fetch(
            `https://${STAGING.blobStoreId.replace("store_", "").toLowerCase()}.private.blob.vercel-storage.com/forge/${reference}`,
            { redirect: "error", signal: AbortSignal.timeout(10_000) }
          )
          expect([401, 403, 404]).toContain(response.status)
          await response.body?.cancel()
          await expect(blobs.put(reference, content)).rejects.toThrow()
          expect(await blobs.get(reference)).toEqual(content)
        }
      },
      60_000
    )
    it.skipIf(phase !== "reader")(
      "database rejects foreign resource/workspace links, repointing keys/checksums, malformed keys and dangling resource removal",
      async () => {
        for (const [column, value] of [
          ["workspace_id", "foreign"],
          ["issue_id", randomUUID()],
          ["storage_reference", `files/${randomUUID()}`],
          ["checksum", "a".repeat(64)],
          ["size_bytes", 1],
        ]) {
          await expect(
            pool.query(
              `UPDATE public.resource_files SET ${column}=$1 WHERE id=$2`,
              [value, manifest.files[0]]
            )
          ).rejects.toMatchObject({ code: "23514" })
        }
        await expect(
          pool.query(
            "INSERT INTO public.resource_files(workspace_id,created_by_user_id,issue_id,name,content_type,size_bytes,checksum,storage_reference) VALUES('foreign',$1,$2,'fixture','text/plain',1,$3,$4)",
            [
              manifest.user,
              manifest.issue,
              "a".repeat(64),
              `files/${randomUUID()}`,
            ]
          )
        ).rejects.toMatchObject({ code: "23503" })
        await expect(
          pool.query("DELETE FROM public.issues WHERE id=$1", [manifest.issue])
        ).rejects.toMatchObject({ code: "23503" })
        await expect(
          pool.query(
            "UPDATE public.resource_files SET storage_reference='../bad' WHERE id=$1",
            [manifest.files[0]]
          )
        ).rejects.toMatchObject({ code: "23514" })
      },
      30_000
    )
    it.skipIf(phase !== "reader")(
      "revoked sessions cannot read any file class",
      async () => {
        const s = await services()
        await pool.query(
          "UPDATE public.session SET expires_at=now()-interval '1 second' WHERE id=$1",
          [`${manifest.user}-session`]
        )
        try {
          await expect(
            s.artifacts.read(actor(), manifest.artifact!)
          ).rejects.toThrow()
          await expect(
            s.attachments.resolve(actor(), [manifest.attachment!])
          ).rejects.toThrow()
          for (const id of manifest.files)
            await expect(s.resources.read(actor(), id)).rejects.toThrow()
        } finally {
          await pool.query(
            "UPDATE public.session SET expires_at=now()+interval '1 hour' WHERE id=$1",
            [`${manifest.user}-session`]
          )
        }
      },
      30_000
    )
    it.skipIf(phase !== "cleanup")(
      "removes only this fixture's objects and metadata, verifying empty fixture state",
      async () => {
        // Query even if the writer failed after byte persistence but before saving its reference list.
        const rows = await pool.query(
          "SELECT storage_reference FROM public.agent_artifacts WHERE run_id=$1 UNION ALL SELECT storage_reference FROM public.agent_attachments WHERE workspace_id=$2 UNION ALL SELECT storage_reference FROM public.resource_files WHERE workspace_id=$2",
          [manifest.run, manifest.workspace]
        )
        for (const reference of new Set([
          ...manifest.references,
          ...rows.rows.map((r) => r.storage_reference),
        ])) {
          await blobs.delete(reference)
          expect(await blobs.get(reference)).toBeNull()
        }
        await pool.query(
          "DELETE FROM public.resource_files WHERE workspace_id=$1",
          [manifest.workspace]
        )
        await pool.query("DELETE FROM public.organization WHERE id=$1", [
          manifest.workspace,
        ])
        await pool.query('DELETE FROM public."user" WHERE id=$1', [
          manifest.user,
        ])
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM public.organization WHERE id=$1",
              [manifest.workspace]
            )
          ).rows[0].n
        ).toBe(0)
      },
      60_000
    )
  }
)

import assert from "node:assert/strict"
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { VercelPrivateFileBlobStore } from "../src/adapters/files/vercel-private-file-blob-store.server"
import { STAGING } from "../../../packages/environment/staging-environment"
import { EnvelopeModelSecretVault } from "../src/application/agents/model-secret-vault.server"
import { recoveryPool, verifyDatabase } from "./lib/recovery-database"
import { digest } from "./lib/recovery-archive"

// Only this dedicated rehearsal database pair is admitted, including cleanup.
const [phase, directoryArg] = process.argv.slice(2)
const directory = resolve(directoryArg)
if (
  ![
    "seed",
    "validate",
    "destroy-source",
    "cleanup",
    "mutate",
    "crash-commit",
    "publish-committed",
    "export-keys",
  ].includes(phase)
)
  throw new Error("RECOVERY_JOURNEY_PHASE")
const target = phase === "validate" || phase === "cleanup"
const connection = (
  await readFile(join(directory, target ? "target-url" : "source-url"), "utf8")
).trim()
const identity = {
  ...STAGING.database,
  database: target ? "forge_recovery_target" : "forge_recovery_source",
  storeId: STAGING.blobStoreId,
}
const { connectionEnvironment } = await import("./lib/recovery-database")
connectionEnvironment(connection, identity, target ? "target" : "source")
const pool = recoveryPool(connection)
await verifyDatabase(pool, identity)
const blobEnv = JSON.parse(
  await readFile(join(directory, "staging-blob.json"), "utf8")
)
assert.equal(blobEnv.BLOB_STORE_ID, STAGING.blobStoreId)
const blobs = new VercelPrivateFileBlobStore(blobEnv)
const file = join(directory, "fixture.json")
const authSecret =
  "for38-synthetic-session-auth-secret-independent-from-production"
const bytes = Buffer.from(
  "FOR-38 synthetic issue/document/agent file\u0000\u00ff"
)
const credentialKey = (
  await readFile(
    join(directory, target ? "restored-credential-key" : "credential-key"),
    "utf8"
  )
).trim()
const vault = new EnvelopeModelSecretVault(credentialKey)

type Fixture = {
  workspace: string
  foreignWorkspace: string
  user: string
  foreignUser: string
  team: string
  issue: string
  deletedIssue: string
  document: string
  thread: string
  run: string
  artifact?: string
  attachment?: string
  files: Array<string>
  references: Array<string>
  model: string
  meeting: string
  revokedSession: string
  crashSession: string
  deletedModel: string
  deletedWorkspace: string
  postBackupIssue: string
  postBackupFile?: string
  postBackupReference?: string
  retainedCall: string
}
let fixture: Fixture
if (phase === "seed") {
  const marker = `for38-${randomUUID()}`
  fixture = {
    workspace: marker,
    foreignWorkspace: `${marker}-foreign`,
    user: marker,
    foreignUser: `${marker}-foreign`,
    team: randomUUID(),
    issue: randomUUID(),
    deletedIssue: randomUUID(),
    document: randomUUID(),
    thread: randomUUID(),
    run: randomUUID(),
    model: randomUUID(),
    meeting: randomUUID(),
    files: [],
    references: [],
    revokedSession: `${marker}-revoked`,
    crashSession: `${marker}-crash`,
    deletedModel: randomUUID(),
    deletedWorkspace: `${marker}-deleted-workspace`,
    postBackupIssue: randomUUID(),
    retainedCall: randomUUID(),
  }
  await writeFile(file, JSON.stringify(fixture), { flag: "wx", mode: 0o600 })
} else fixture = JSON.parse(await readFile(file, "utf8"))
const save = () => writeFile(file, JSON.stringify(fixture), { mode: 0o600 })
try {
  if (phase === "destroy-source" || phase === "cleanup") {
    for (const reference of fixture.references) {
      await blobs.delete(reference)
      assert.equal(await blobs.get(reference), null)
    }
    await pool.query(
      "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public"
    )
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM pg_tables WHERE schemaname IN ('public','drizzle')"
        )
      ).rows[0].n,
      0
    )
    console.log(
      JSON.stringify({
        phase,
        sourceUnavailable: phase === "destroy-source",
        objectsRemoved: fixture.references.length,
        database: identity.database,
      })
    )
  } else {
    // Application journeys run as an ordinary, pre-existing staging role.
    await pool.query(
      "GRANT USAGE ON SCHEMA public TO forge_staging_web; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO forge_staging_web; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO forge_staging_web"
    )
    await pool.query(
      "GRANT EXECUTE ON FUNCTION forge_effective_workspace_plan(text),forge_adjust_workspace_member_capacity(text,integer),forge_adjust_workspace_team_capacity(text,integer) TO forge_staging_web"
    )
    process.env.DATABASE_URL = (
      await readFile(
        join(directory, target ? "target-app-url" : "source-app-url"),
        "utf8"
      )
    ).trim()
    process.env.BETTER_AUTH_URL = "http://forge-recovery.test"
    process.env.BETTER_AUTH_SECRET = authSecret
    process.env.FORGE_MODEL_CREDENTIAL_KEK = credentialKey
    process.env.FORGE_AGENT_BLOB_ADAPTER = "vercel-private"
    process.env.BLOB_STORE_ID = blobEnv.BLOB_STORE_ID
    process.env.BLOB_READ_WRITE_TOKEN = blobEnv.BLOB_READ_WRITE_TOKEN
    if (
      ["mutate", "crash-commit", "publish-committed", "export-keys"].includes(
        phase
      )
    ) {
      const r2 = JSON.parse(await readFile(join(directory, "r2.json"), "utf8"))
      process.env.FORGE_RECOVERY_JOURNAL_ENABLED = "true"
      process.env.FORGE_RECOVERY_R2_ACCOUNT_ID = r2.accountId
      process.env.FORGE_RECOVERY_JOURNAL_BUCKET =
        "forge-recovery-deletion-journal"
      process.env.FORGE_RECOVERY_JOURNAL_ACCESS_KEY_ID = r2.accessKeyId
      process.env.FORGE_RECOVERY_JOURNAL_SECRET_ACCESS_KEY = r2.secretAccessKey
      process.env.FORGE_RECOVERY_JOURNAL_SIGNING_KEY = (
        await readFile(join(directory, "journal-key"), "utf8")
      ).trim()
    }
    // Prevent ambient developer credentials from giving restored jobs authority.
    for (const name of Object.keys(process.env))
      if (/_API_KEY$|_CLIENT_SECRET$|POLAR_ACCESS_TOKEN/.test(name))
        delete process.env[name]
    const database = await import("../src/db")
    const { requireSessionActor } =
      await import("../src/adapters/auth/session-actor.server")
    const { getPlanningResource, listPlanningResources } =
      await import("../src/application/planning/queries.server")
    const { createForgeResourceFileService } =
      await import("../src/adapters/files/forge-resource-file-service.server")
    const { AgentArtifactService } =
      await import("../src/application/agents/artifact-service.server")
    const { AgentAttachmentService } =
      await import("../src/application/agents/attachment-service.server")
    const { DrizzleAgentArtifactStore } =
      await import("../src/adapters/agents/drizzle-artifact-store.server")
    const { DrizzleAgentAttachmentStore } =
      await import("../src/adapters/agents/drizzle-attachment-store.server")
    const { DrizzleAgentStore } =
      await import("../src/adapters/agents/drizzle-agent-store.server")
    const { DrizzleAgentEventStore } =
      await import("../src/adapters/agents/drizzle-event-store.server")
    const { requireCurrentActor } =
      await import("../src/application/resource-policy.server")
    const artifacts = new AgentArtifactService({
      authorizeActor: requireCurrentActor,
      metadata: new DrizzleAgentArtifactStore(),
      agents: new DrizzleAgentStore(),
      events: new DrizzleAgentEventStore(),
      blobs,
    })
    const attachments = new AgentAttachmentService({
      authorizeActor: requireCurrentActor,
      metadata: new DrizzleAgentAttachmentStore(),
      blobs,
    })
    const resources = createForgeResourceFileService(blobs)
    async function actor(user: string, session = `${user}-session`) {
      const signature = createHmac("sha256", authSecret)
        .update(session)
        .digest("base64")
      const request = new Request("http://forge-recovery.test/api/planning", {
        headers: {
          cookie: `better-auth.session_token=${encodeURIComponent(`${session}.${signature}`)}`,
        },
      })
      return requireSessionActor(request)
    }
    try {
      if (phase === "seed") {
        for (const [workspace, user] of [
          [fixture.workspace, fixture.user],
          [fixture.foreignWorkspace, fixture.foreignUser],
        ]) {
          await pool.query(
            "INSERT INTO public.organization(id,name,slug) VALUES($1,$1,$1)",
            [workspace]
          )
          await pool.query(
            'INSERT INTO public."user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
            [user, `${user}@example.test`]
          )
          await pool.query(
            "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
            [randomUUID(), workspace, user]
          )
          await pool.query(
            "INSERT INTO public.session(id,token,user_id,expires_at,active_organization_id) VALUES($1,$1,$2,now()+interval '2 hours',$3)",
            [`${user}-session`, user, workspace]
          )
        }
        await pool.query(
          "INSERT INTO public.session(id,token,user_id,expires_at,active_organization_id) VALUES($1,$1,$2,now()+interval '2 hours',$3)",
          [fixture.revokedSession, fixture.user, fixture.workspace]
        )

        await pool.query(
          "INSERT INTO public.teams(id,workspace_id,slug,identifier,name,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'F38','F38','Recovery fixture','icon','fixture','#000000','UTC',$3)",
          [fixture.team, fixture.workspace, fixture.user]
        )
        await pool.query(
          `INSERT INTO public.calls(id,workspace_id,team_id,provider,external_id,title,started_at,transcript,summary,decisions) VALUES($1,$2,$3,'zoom',$4,'Retention recovery fixture',now()-interval '8 days','[{"text":"expired synthetic transcript"}]'::jsonb,'Retained derived summary','["Retained derived decision"]'::jsonb)`,
          [
            fixture.retainedCall,
            fixture.workspace,
            fixture.team,
            fixture.retainedCall,
          ]
        )
        await pool.query(
          "INSERT INTO public.issues(id,workspace_id,team_id,number,title) VALUES($1,$3,$4,1,'Recovered issue'),($2,$3,$4,2,'Deleted after backup')",
          [fixture.issue, fixture.deletedIssue, fixture.workspace, fixture.team]
        )
        await pool.query(
          "INSERT INTO public.documents(id,workspace_id,title) VALUES($1,$2,'Recovered document')",
          [fixture.document, fixture.workspace]
        )
        await pool.query(
          "INSERT INTO public.agent_threads(id,workspace_id,created_by_user_id) VALUES($1,$2,$3)",
          [fixture.thread, fixture.workspace, fixture.user]
        )
        await pool.query(
          "INSERT INTO public.agent_runs(id,thread_id,initiated_by_user_id,execution_kind,requested_selection) VALUES($1,$2,$3,'forge-native','{}')",
          [fixture.run, fixture.thread, fixture.user]
        )
        const a = await actor(fixture.user)
        fixture.artifact = (
          await artifacts.create(a, fixture.run, {
            kind: "file",
            name: "recovery.bin",
            contentType: "text/plain",
            encoding: "base64",
            content: bytes.toString("base64"),
          })
        ).id
        await save()
        fixture.attachment = (
          await attachments.upload(a, {
            name: "recovery.bin",
            contentType: "text/plain",
            contentBase64: bytes.toString("base64"),
          })
        ).id
        await save()
        for (const kind of ["issue", "document"] as const) {
          fixture.files.push(
            (
              await resources.create(
                a,
                { kind, id: fixture[kind] },
                {
                  name: "recovery.bin",
                  contentType: "text/plain",
                  content: bytes,
                }
              )
            ).id
          )
          await save()
        }
        fixture.references = (
          await pool.query(
            "SELECT storage_reference FROM public.agent_artifacts WHERE run_id=$1 UNION ALL SELECT storage_reference FROM public.agent_attachments WHERE workspace_id=$2 UNION ALL SELECT storage_reference FROM public.resource_files WHERE workspace_id=$2",
            [fixture.run, fixture.workspace]
          )
        ).rows.map((r) => r.storage_reference)
        await save()
        await pool.query(
          "INSERT INTO public.model_connections(id,workspace_id,scope,provider,kind,execution_kind,locality,billing_mode,credential_owner,display_name,created_by_user_id,secret_reference) VALUES($1,$2,'workspace','openai','api-key','forge-native','server-capable','pay-as-you-go','forge-server-vault','Synthetic recovery credential',$3,$4)",
          [
            fixture.model,
            fixture.workspace,
            fixture.user,
            await vault.seal(
              "synthetic-for38-model-secret",
              `${fixture.workspace}:${fixture.model}`
            ),
          ]
        )
        await pool.query(
          "INSERT INTO public.call_connections(id,workspace_id,user_id,team_id,provider,secret) VALUES($1,$2,$3,$4,'zoom',$5)",
          [
            fixture.meeting,
            fixture.workspace,
            fixture.user,
            fixture.team,
            await vault.seal(
              JSON.stringify({
                access_token: "synthetic-for38-meeting-secret",
              }),
              `meeting:${fixture.workspace}:${fixture.meeting}`
            ),
          ]
        )
        await pool.query(
          "INSERT INTO public.session(id,token,user_id,expires_at,active_organization_id) VALUES($1,$1,$2,now()+interval '2 hours',$3)",
          [fixture.crashSession, fixture.user, fixture.workspace]
        )
        await pool.query(
          "INSERT INTO public.organization(id,name,slug) VALUES($1,$1,$1)",
          [fixture.deletedWorkspace]
        )
        await pool.query(
          "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
          [randomUUID(), fixture.deletedWorkspace, fixture.user]
        )
        await pool.query(
          "INSERT INTO public.model_connections(id,workspace_id,scope,provider,kind,execution_kind,locality,billing_mode,credential_owner,display_name,created_by_user_id,secret_reference) VALUES($1,$2,'workspace','openai','api-key','forge-native','server-capable','pay-as-you-go','forge-server-vault','Deleted credential fixture',$3,$4)",
          [
            fixture.deletedModel,
            fixture.workspace,
            fixture.user,
            await vault.seal(
              "synthetic-deleted-model-secret",
              `${fixture.workspace}:${fixture.deletedModel}`
            ),
          ]
        )
        await pool.query(
          "INSERT INTO public.workspace_security_settings(workspace_id,mcp_servers_enabled) VALUES($1,true) ON CONFLICT(workspace_id) DO UPDATE SET mcp_servers_enabled=true",
          [fixture.workspace]
        )
        await pool.query(
          "UPDATE public.recovery_journal_state SET enabled=true WHERE id='singleton'"
        )
        await assert.rejects(
          pool.query("DELETE FROM public.issues WHERE id=$1", [
            fixture.deletedIssue,
          ]),
          (error) =>
            error instanceof Error &&
            error.message.includes("RECOVERY_JOURNAL_REQUIRED")
        )
        const seededIssue = await getPlanningResource(a, "issue", fixture.issue)
        assert.ok(seededIssue)
        assert.equal(seededIssue.title, "Recovered issue")
        console.log(
          JSON.stringify({
            phase,
            authenticated: true,
            fileClasses: 4,
            credentialClasses: 2,
            checksum: digest(bytes),
          })
        )
      } else if (phase === "export-keys") {
        const { collectRecoveryKeyCapsule, handleRecoveryKeyExport } =
          await import("../src/application/recovery/key-capsule.server")
        const token = randomBytes(32).toString("base64url"),
          challenge = randomBytes(16).toString("hex")
        const env: Record<string, string | undefined> = {
          ...process.env,
          FORGE_SOURCE_REVISION: execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          FORGE_RECOVERY_PUBLIC_KEY: await readFile(
            join(directory, "fixture-public.pem"),
            "utf8"
          ),
          FORGE_RECOVERY_KEY_EXPORT_TOKEN_SHA256: createHash("sha256")
            .update(token)
            .digest("hex"),
          FORGE_RECOVERY_KEY_EXPORT_EXPIRES_AT: new Date(
            Date.now() + 900000
          ).toISOString(),
        }
        let initialized = false
        const denied = await handleRecoveryKeyExport(
          new Request(
            "http://forge-recovery.test/api/internal/recovery-key-export",
            { method: "POST" }
          ),
          env,
          () => {
            initialized = true
            return Promise.resolve({})
          }
        )
        assert.equal(denied.status, 404)
        assert.equal(initialized, false)
        const response = await handleRecoveryKeyExport(
          new Request(
            "http://forge-recovery.test/api/internal/recovery-key-export",
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "x-environment-check-challenge": challenge,
              },
            }
          ),
          env,
          async (exportChallenge) => {
            const client = await database.databaseClient.connect()
            try {
              await client.query(
                "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
              )
              const value = await collectRecoveryKeyCapsule(
                env,
                client,
                exportChallenge
              )
              await client.query("COMMIT")
              return value
            } finally {
              client.release()
            }
          }
        )
        assert.equal(response.status, 200)
        const text = await response.text()
        assert.equal(text.includes(credentialKey), false)
        const signingKey = env.FORGE_RECOVERY_JOURNAL_SIGNING_KEY
        assert.ok(signingKey)
        assert.equal(text.includes(signingKey), false)
        await writeFile(join(directory, "keys-capsule.json"), text, {
          flag: "wx",
          mode: 0o600,
        })
        console.log(
          JSON.stringify({
            phase,
            authorizedEncryptedExport: true,
            anonymousDenied: true,
            rawKeysAbsent: true,
          })
        )
      } else if (phase === "mutate") {
        const a = await actor(fixture.user)
        assert.equal(a.workspaceId, fixture.workspace)
        const { eq } = await import("drizzle-orm")
        // The source can die after policy commit and before its normal sweeper.
        // Replay must recover a first policy row before enforcing deadlines.
        await database.db
          .insert(database.callSettings)
          .values({ workspaceId: fixture.workspace, retentionDays: 7 })
          .onConflictDoUpdate({
            target: database.callSettings.workspaceId,
            set: { retentionDays: 7 },
          })
        // Existing provider reconnects use this same conflict-update SQL path.
        await database.db
          .insert(database.callConnections)
          .values({
            id: fixture.meeting,
            workspaceId: fixture.workspace,
            userId: fixture.user,
            teamId: fixture.team,
            provider: "zoom",
            oauthVerifier: "synthetic-reconnect-verifier",
          })
          .onConflictDoUpdate({
            target: database.callConnections.id,
            set: { oauthVerifier: "synthetic-reconnect-verifier" },
          })
        await database.db
          .delete(database.sessions)
          .where(eq(database.sessions.id, fixture.revokedSession))
        await database.db
          .delete(database.issues)
          .where(eq(database.issues.id, fixture.deletedIssue))
        const { ModelConnectionService } =
          await import("../src/application/agents/model-connection-service.server")
        await new ModelConnectionService().delete(a, fixture.deletedModel)
        await database.db
          .delete(database.organizations)
          .where(eq(database.organizations.id, fixture.deletedWorkspace))
        await database.db
          .update(database.workspaceSecuritySettings)
          .set({ mcpServersEnabled: false, version: 2 })
          .where(
            eq(
              database.workspaceSecuritySettings.workspaceId,
              fixture.workspace
            )
          )
        await database.db.insert(database.issues).values({
          id: fixture.postBackupIssue,
          workspaceId: fixture.workspace,
          teamId: fixture.team,
          number: 3,
          title: "Acknowledged after backup checkpoint",
        })
        fixture.postBackupFile = (
          await resources.create(
            a,
            { kind: "issue", id: fixture.issue },
            {
              name: "post-checkpoint.bin",
              contentType: "text/plain",
              content: Buffer.from("acknowledged-after-backup"),
            }
          )
        ).id
        fixture.postBackupReference = (
          await pool.query(
            "SELECT storage_reference FROM resource_files WHERE id=$1",
            [fixture.postBackupFile]
          )
        ).rows[0].storage_reference
        fixture.references.push(fixture.postBackupReference!)
        await save()
        console.log(
          JSON.stringify({
            phase,
            ordinaryDatabaseRole: true,
            sessionRevoked: true,
            issueDeleted: true,
            credentialDeleted: true,
            workspaceCascadeDeleted: true,
            securityPolicyChanged: true,
            firstRetentionPolicyCommitted: true,
            providerReconnectUpsert: true,
            postBackupIssueAcknowledged: true,
            postBackupFileAcknowledged: true,
            acknowledgedAt: new Date().toISOString(),
          })
        )
      } else if (phase === "crash-commit" || phase === "publish-committed") {
        const { configuredDeletionJournal } =
          await import("../src/adapters/recovery/r2-deletion-journal.server")
        const { journalDatabasePool, publishCommittedRecoveryOperation } =
          await import("../src/adapters/recovery/journaled-pool.server")
        const backend = configuredDeletionJournal()!
        try {
          if (phase === "publish-committed") {
            const operation = (
              await readFile(join(directory, "crashed-operation"), "utf8")
            ).trim()
            await publishCommittedRecoveryOperation(
              pool,
              backend,
              connection,
              STAGING.blobStoreId,
              operation
            )
            console.log(
              JSON.stringify({ phase, operation, receiptVerified: true })
            )
          } else {
            const crashPool = recoveryPool(process.env.DATABASE_URL)
            journalDatabasePool(
              crashPool,
              {
                prepare: async (id, source) => {
                  await backend.prepare(id, source)
                  await writeFile(join(directory, "crashed-operation"), id, {
                    mode: 0o600,
                  })
                },
                complete: () => {
                  process.exit(86)
                },
                abort: (id, source) => backend.abort(id, source),
              },
              process.env.DATABASE_URL,
              STAGING.blobStoreId
            )
            await crashPool.query("DELETE FROM public.session WHERE id=$1", [
              fixture.crashSession,
            ])
            throw new Error("RECOVERY_CRASH_BOUNDARY_NOT_REACHED")
          }
        } finally {
          backend.close()
        }
      } else {
        const a = await actor(fixture.user),
          foreign = await actor(fixture.foreignUser)
        const restoredIssue = await getPlanningResource(
          a,
          "issue",
          fixture.issue
        )
        assert.ok(restoredIssue)
        assert.equal(restoredIssue.title, "Recovered issue")
        const listed = await listPlanningResources(a, "issue", { limit: 100 })
        assert.ok(JSON.stringify(listed).includes(fixture.issue))
        assert.equal(
          await getPlanningResource(a, "issue", fixture.deletedIssue),
          null
        )
        assert.equal(
          await getPlanningResource(a, "issue", fixture.postBackupIssue),
          null
        )
        await assert.rejects(resources.read(a, fixture.postBackupFile!))
        assert.equal(await blobs.get(fixture.postBackupReference!), null)
        assert.equal(
          await getPlanningResource(foreign, "issue", fixture.issue),
          null
        )
        await assert.rejects(actor(fixture.user, fixture.revokedSession))
        await assert.rejects(actor(fixture.user, fixture.crashSession))
        assert.equal(
          (
            await pool.query("SELECT id FROM model_connections WHERE id=$1", [
              fixture.deletedModel,
            ])
          ).rows.length,
          0
        )
        assert.equal(
          (
            await pool.query("SELECT id FROM organization WHERE id=$1", [
              fixture.deletedWorkspace,
            ])
          ).rows.length,
          0
        )
        assert.equal(
          (
            await pool.query(
              "SELECT mcp_servers_enabled FROM workspace_security_settings WHERE workspace_id=$1",
              [fixture.workspace]
            )
          ).rows[0].mcp_servers_enabled,
          false
        )
        assert.equal(
          digest((await artifacts.read(a, fixture.artifact!)).content),
          digest(bytes)
        )
        const retainedCall = (
          await pool.query(
            "SELECT transcript,summary,decisions FROM public.calls WHERE id=$1",
            [fixture.retainedCall]
          )
        ).rows[0]
        assert.deepEqual(retainedCall.transcript, [])
        assert.equal(retainedCall.summary, "Retained derived summary")
        assert.deepEqual(retainedCall.decisions, ["Retained derived decision"])
        assert.equal(
          (
            await pool.query(
              "SELECT retention_days FROM public.call_settings WHERE workspace_id=$1",
              [fixture.workspace]
            )
          ).rows[0].retention_days,
          7
        )
        assert.equal(
          digest(
            Buffer.from(
              (await attachments.resolve(a, [fixture.attachment!]))[0]
                .contentBase64,
              "base64"
            )
          ),
          digest(bytes)
        )
        for (const id of fixture.files) {
          assert.equal(
            digest((await resources.read(a, id)).content),
            digest(bytes)
          )
          await assert.rejects(resources.read(foreign, id))
        }
        const model = (
          await pool.query(
            "SELECT secret_reference FROM public.model_connections WHERE id=$1",
            [fixture.model]
          )
        ).rows[0]
        assert.equal(
          await vault.open(
            model.secret_reference,
            `${fixture.workspace}:${fixture.model}`
          ),
          "synthetic-for38-model-secret"
        )
        const meeting = (
          await pool.query(
            "SELECT secret FROM public.call_connections WHERE id=$1",
            [fixture.meeting]
          )
        ).rows[0]
        assert.deepEqual(
          JSON.parse(
            await vault.open(
              meeting.secret,
              `meeting:${fixture.workspace}:${fixture.meeting}`
            )
          ),
          { access_token: "synthetic-for38-meeting-secret" }
        )
        await assert.rejects(
          new EnvelopeModelSecretVault(
            Buffer.alloc(32).toString("base64")
          ).open(
            model.secret_reference,
            `${fixture.workspace}:${fixture.model}`
          )
        )
        console.log(
          JSON.stringify({
            phase,
            authenticated: true,
            issueListAndGet: true,
            fileClasses: 4,
            credentialClasses: 2,
            foreignWorkspaceDenied: true,
            revokedSessionDenied: true,
            deletedIssueSuppressed: true,
            wrongKeyDenied: true,
            firstRetentionPolicyReplayed: true,
            expiredTranscriptRemoved: true,
            derivedCallDataRetained: true,
            expectedPostCheckpointLoss: { issues: 1, files: 1 },
            validatedAt: new Date().toISOString(),
            processId: process.pid,
          })
        )
      }
    } finally {
      await database.databaseClient.end()
    }
  }
} finally {
  await pool.end()
}

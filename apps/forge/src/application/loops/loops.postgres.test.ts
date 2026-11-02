// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import type { Actor } from "@/application/actor"
import type { LoopFields } from "@/lib/loop-contract"
import type * as Service from "./loops.server"
import type * as LoopActor from "./loop-actor.server"
import type { ClaimedLoopRun, LoopExecutor } from "./loop-execution.server"

const file =
  process.env.FORGE_LOOP_TEST_DATABASE_FILE ??
  process.env.FORGE_RESOURCE_TEST_DATABASE_FILE
const fields = (name = "Review new issues"): LoopFields => ({
  name,
  description: "Shared automation",
  instructions: "Review the triggering issue and summarize next steps.",
  trigger: { kind: "event", entity: "issue", event: "created" },
  conditions: [],
  reasoning: "auto",
  teamAccess: "this-team",
})
describe.skipIf(!file)("FOR-62 shared Loops on PostgreSQL", () => {
  const marker = `for62-loops-${randomUUID()}`,
    users = [marker + "-alice", marker + "-bob"],
    workspaces: Array<string> = []
  let pool: Pool, service: typeof Service
  let loopPrincipalId: typeof LoopActor.loopPrincipalId
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
    vi.stubEnv("FORGE_LOOPS_ENABLED", "true")
    vi.stubEnv("AGENT_FAKE_RUNTIME_ENABLED", "true")
    vi.stubEnv("EVE_AGENT_RUNTIME_URL", "")
    vi.stubEnv("OPENAI_API_KEY", "")
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3162")
    vi.stubEnv(
      "BETTER_AUTH_SECRET",
      "for62-acceptance-auth-signing-secret-only"
    )
    vi.stubEnv(
      "FORGE_LOOP_WEBHOOK_SECRET",
      "for62-acceptance-webhook-signing-material-only"
    )
    service = await import("./loops.server")
    loopPrincipalId = (await import("./loop-actor.server")).loopPrincipalId
    for (const id of users)
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [id, id + "@example.test"]
      )
  }, 30000)
  afterAll(async () => {
    if (!pool) return
    const botIds = (
      await pool.query(
        "SELECT id FROM team_loops WHERE workspace_id=ANY($1::text[])",
        [workspaces]
      )
    ).rows.map((row) => loopPrincipalId(row.id))
    for (const id of workspaces)
      await pool.query("DELETE FROM organization WHERE id=$1", [id])
    const leftoverBots = botIds.length
      ? (
          await pool.query('SELECT id FROM "user" WHERE id=ANY($1::text[])', [
            botIds,
          ])
        ).rows
      : []
    // Last-resort fixture cleanup; the assertion below still detects a broken
    // cascade. Never delete by the broad internal-user prefix.
    if (botIds.length)
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [botIds])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    await pool.end()
    await (await import("@/db")).databaseClient.end()
    vi.unstubAllEnvs()
    expect(leftoverBots).toEqual([])
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
      "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'enterprise','active')",
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
        userId,
        workspaceId,
        workspaceRole: "member",
        authentication: { kind: "session", sessionId },
        scopes: null,
      })
    }
    for (const id of [teamId, privateTeamId])
      await pool.query(
        "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1::uuid,$2,$1::text,$1::text,$3,$4,'emoji','🔥','#94a3b8','Europe/Paris',$5)",
        [
          id,
          workspaceId,
          id.slice(0, 5),
          id === teamId ? "workspace" : "private",
          users[0],
        ]
      )
    await pool.query(
      "INSERT INTO team_members(workspace_id,team_id,user_id,role) VALUES($1,$2,$3,'member')",
      [workspaceId, privateTeamId, users[0]]
    )
    return { workspaceId, teamId, privateTeamId, actors }
  }
  async function create(
    f: Awaited<ReturnType<typeof fixture>>,
    teamId = f.teamId,
    input = fields()
  ) {
    const id = randomUUID(),
      key = randomUUID(),
      command = { action: "create" as const, id, fields: input }
    expect(
      await service.commandLoop(f.actors[0], teamId, key, command)
    ).toMatchObject({ status: "saved", id, revision: 1 })
    return { id, key, command }
  }
  async function enableFixture(
    f: Awaited<ReturnType<typeof fixture>>,
    id: string
  ) {
    // Producer cases isolate SQL behavior from external model provisioning.
    await pool.query(
      "UPDATE team_loops SET enabled=true,enabled_by_id=$2,enabled_at=now() WHERE id=$1",
      [id, f.actors[0].userId]
    )
  }
  async function seedModel(
    f: Awaited<ReturnType<typeof fixture>>,
    scope: "personal" | "workspace",
    locality: "local-only" | "server-capable" = "server-capable"
  ) {
    const id = randomUUID(),
      selectionId = `${id}:gpt-6-astra`
    await pool.query(
      "INSERT INTO model_connections(id,workspace_id,user_id,scope,provider,kind,execution_kind,locality,billing_mode,credential_owner,display_name,status,created_by_user_id) VALUES($1,$2,$3,$4,'openai','api-key','forge-native',$5,'pay-as-you-go','forge-server-vault','Acceptance model','ready',$6)",
      [
        id,
        f.workspaceId,
        scope === "personal" ? users[0] : null,
        scope,
        locality,
        users[0],
      ]
    )
    await pool.query(
      `INSERT INTO model_catalog_entries(connection_id,selection_id,provider_model_id,display_name,provider_label,source_label,execution_kind,input_modalities,supports_tools,supports_code,supported_reasoning_efforts,status) VALUES($1,$2,'gpt-6-astra','Acceptance GPT','OpenAI','Acceptance','forge-native','["text"]',true,true,'["low","medium","high","xhigh"]','available')`,
      [id, selectionId]
    )
    return id
  }
  it("two ordinary members share configuration; concurrent stale saves have one winner", async () => {
    const f = await fixture(),
      loop = await create(f)
    expect((await service.readLoops(f.actors[1], f.teamId)).loops).toEqual(
      (await service.readLoops(f.actors[0], f.teamId)).loops
    )
    const results = await Promise.all(
      f.actors.map((actor, i) =>
        service.commandLoop(actor, f.teamId, randomUUID(), {
          action: "save",
          id: loop.id,
          expectedRevision: 1,
          fields: fields(`Revision ${i}`),
        })
      )
    )
    expect(results.filter((r) => r.status === "saved")).toHaveLength(1)
    expect(results.filter((r) => r.status === "conflict")).toHaveLength(1)
    expect(
      (await service.readLoops(f.actors[1], f.teamId)).loops[0]
    ).toMatchObject({ revision: 2, enabled: false })
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE workspace_id=$1 AND operation='loops.write@1'",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(2)
  })
  it("exact replay commits once and changed input cannot reuse its command identity", async () => {
    const f = await fixture(),
      loop = await create(f)
    expect(
      await service.commandLoop(f.actors[0], f.teamId, loop.key, loop.command)
    ).toMatchObject({ status: "saved", revision: 1 })
    await expect(
      service.commandLoop(f.actors[0], f.teamId, loop.key, {
        ...loop.command,
        fields: fields("Different"),
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
  it("rejects unsupported triggers, impossible qualifiers and oversized input before any receipt", async () => {
    const f = await fixture()
    for (const invalid of [
      {
        ...fields(),
        trigger: { kind: "event", entity: "issue", event: "started" },
      },
      {
        ...fields(),
        trigger: {
          kind: "event",
          entity: "team",
          event: "changed",
          property: "status",
        },
      },
      { ...fields(), trigger: { kind: "slack" } },
      { ...fields(), instructions: "x".repeat(20001) },
      {
        ...fields(),
        conditions: Array.from({ length: 9 }, () => ({
          field: "title",
          operator: "contains",
          values: ["text"],
        })),
      },
      {
        ...fields(),
        trigger: {
          kind: "schedule",
          unit: "weeks",
          interval: 1,
          startAt: new Date().toISOString(),
          timeZone: "Europe/Paris",
          weekdays: [1, 1],
        },
      },
    ])
      await expect(
        service.commandLoop(f.actors[0], f.teamId, randomUUID(), {
          action: "create",
          id: randomUUID(),
          fields: invalid,
        })
      ).rejects.toThrow()
    expect((await service.readLoops(f.actors[1], f.teamId)).loops).toEqual([])
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(0)
  })
  it("denies private/cross-workspace access and reauthorizes old receipts after membership removal", async () => {
    const f = await fixture(),
      g = await fixture(),
      loop = await create(f, f.privateTeamId)
    await expect(
      service.readLoops(f.actors[1], f.privateTeamId)
    ).rejects.toThrow()
    await expect(service.readLoops(g.actors[0], f.teamId)).rejects.toThrow()
    await expect(
      service.commandLoop(f.actors[1], f.privateTeamId, randomUUID(), {
        action: "save",
        id: loop.id,
        expectedRevision: 1,
        fields: fields(),
      })
    ).rejects.toThrow()
    await pool.query(
      "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
      [f.workspaceId, f.privateTeamId, users[0]]
    )
    await expect(
      service.commandLoop(f.actors[0], f.privateTeamId, loop.key, loop.command)
    ).rejects.toThrow()
  })
  it("enforces the server gate and first-party management transport", async () => {
    const f = await fixture()
    vi.stubEnv("FORGE_LOOPS_ENABLED", "false")
    try {
      expect(await service.readLoops(f.actors[0], f.teamId)).toMatchObject({
        enabled: false,
        loops: [],
        runs: [],
      })
      await expect(create(f)).rejects.toThrow()
    } finally {
      vi.stubEnv("FORGE_LOOPS_ENABLED", "true")
    }
    await expect(
      service.readLoops(
        {
          ...f.actors[0],
          authentication: { kind: "apiKey", credentialId: randomUUID() },
          scopes: ["teams:read"],
        },
        f.teamId
      )
    ).rejects.toThrow()
  })
  it("project creation records final memberships atomically; rollback removes its update event", async () => {
    const f = await fixture(),
      loop = await create(f),
      projectId = randomUUID()
    await enableFixture(f, loop.id)
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'With membership')",
        [projectId, f.workspaceId]
      )
      await client.query(
        "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
        [f.workspaceId, projectId, f.teamId]
      )
      expect(
        (
          await client.query(
            "SELECT count(*)::int n FROM loop_events WHERE entity_id=$1",
            [projectId]
          )
        ).rows[0].n
      ).toBe(0)
      await client.query("COMMIT")
      const rows = (
        await pool.query("SELECT * FROM loop_events WHERE entity_id=$1", [
          projectId,
        ])
      ).rows
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        workspace_id: f.workspaceId,
        team_id: f.teamId,
        entity: "project",
        event: "created",
        before: null,
      })
      expect(rows[0].after.teamIds).toEqual([f.teamId])
      await client.query("BEGIN")
      await client.query("UPDATE projects SET name='Rolled back' WHERE id=$1", [
        projectId,
      ])
      await client.query("ROLLBACK")
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM loop_events WHERE entity_id=$1",
            [projectId]
          )
        ).rows[0].n
      ).toBe(1)
    } finally {
      await client.query("ROLLBACK").catch(() => {})
      client.release()
    }
  })
  it("membership events preserve joined/left collections and suppress Loop-origin writes", async () => {
    const f = await fixture(),
      loop = await create(f)
    await enableFixture(f, loop.id)
    await pool.query(
      "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
      [f.workspaceId, f.teamId, users[1]]
    )
    let rows = (
      await pool.query(
        "SELECT * FROM loop_events WHERE workspace_id=$1 ORDER BY created_at,id",
        [f.workspaceId]
      )
    ).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].before.members).toEqual([])
    expect(rows[0].after.members).toEqual([users[1]])
    await pool.query(
      "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
      [f.workspaceId, f.teamId, users[1]]
    )
    rows = (
      await pool.query(
        "SELECT * FROM loop_events WHERE workspace_id=$1 ORDER BY created_at,id",
        [f.workspaceId]
      )
    ).rows
    expect(rows).toHaveLength(2)
    expect(rows[1].before.members).toEqual([users[1]])
    expect(rows[1].after.members).toEqual([])
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('forge.loop_run_id',$1,true)", [
        randomUUID(),
      ])
      await client.query(
        "UPDATE teams SET description='Automation change' WHERE id=$1",
        [f.teamId]
      )
      await client.query("COMMIT")
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM loop_events WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(2)
    } finally {
      await client.query("ROLLBACK").catch(() => {})
      client.release()
    }
  })
  it("all-public scope records public source-team events without collecting private events", async () => {
    const f = await fixture(),
      loop = await create(f, f.teamId, {
        ...fields(),
        teamAccess: "all-public-teams",
      }),
      publicTeam = randomUUID()
    await enableFixture(f, loop.id)
    await pool.query(
      "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1::uuid,$2,'Other team',$1::text,$3,'workspace','emoji','🔥','#94a3b8','UTC',$4)",
      [publicTeam, f.workspaceId, publicTeam.slice(0, 5), users[0]]
    )
    await pool.query(
      "UPDATE teams SET description='Private edit' WHERE id=$1",
      [f.privateTeamId]
    )
    const rows = (
      await pool.query("SELECT * FROM loop_events WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].team_id).toBe(publicTeam)
  })

  it("webhook receipt is duplicate-safe, binds payload identity, and honors immediate secret rotation", async () => {
    const f = await fixture(),
      loop = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "webhook" },
      })
    const { handleLoopWebhook } = await import("./loop-webhook.server")
    const rotated = await service.commandLoop(
      f.actors[0],
      f.teamId,
      randomUUID(),
      { action: "rotate-webhook", id: loop.id, expectedRevision: 1 }
    )
    if (rotated.status !== "saved" || !rotated.webhookSecret)
      throw Error("Secret generation failed")
    await service.commandLoop(f.actors[1], f.teamId, randomUUID(), {
      action: "enable",
      id: loop.id,
      expectedRevision: 2,
    })
    const eventId = randomUUID()
    const request = (
      secret: string,
      payload: unknown = { event: "alert", level: 1 },
      id = eventId
    ) =>
      new Request(`http://localhost/api/loops/${loop.id}/webhook`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          "Webhook-Id": id,
        },
        body: JSON.stringify(payload),
      })
    const responses = await Promise.all([
      handleLoopWebhook(request(rotated.webhookSecret), loop.id),
      handleLoopWebhook(request(rotated.webhookSecret), loop.id),
    ])
    expect(responses.map((r) => r.status)).toEqual([202, 202])
    expect((await responses[0].json()).runId).toBe(
      (await responses[1].json()).runId
    )
    expect(
      (
        await handleLoopWebhook(
          request(rotated.webhookSecret, { event: "alert", level: 2 }),
          loop.id
        )
      ).status
    ).toBe(409)
    const second = await service.commandLoop(
      f.actors[0],
      f.teamId,
      randomUUID(),
      { action: "rotate-webhook", id: loop.id, expectedRevision: 3 }
    )
    if (second.status !== "saved" || !second.webhookSecret)
      throw Error("Secret rotation failed")
    expect(
      (
        await handleLoopWebhook(
          request(rotated.webhookSecret, undefined, randomUUID()),
          loop.id
        )
      ).status
    ).toBe(404)
    expect(
      (await handleLoopWebhook(request(second.webhookSecret), loop.id)).status
    ).toBe(202)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_runs WHERE loop_id=$1",
          [loop.id]
        )
      ).rows[0].n
    ).toBe(2)
    const receipts = (
      await pool.query(
        "SELECT response_body FROM command_receipts WHERE workspace_id=$1",
        [f.workspaceId]
      )
    ).rows
    expect(JSON.stringify(receipts)).not.toContain(rotated.webhookSecret)
    expect(JSON.stringify(receipts)).not.toContain(second.webhookSecret)
    await service.commandLoop(f.actors[1], f.teamId, randomUUID(), {
      action: "disable",
      id: loop.id,
      expectedRevision: 4,
    })
    expect(
      (
        await handleLoopWebhook(
          request(second.webhookSecret, undefined, randomUUID()),
          loop.id
        )
      ).status
    ).toBe(404)
  })
  it("webhook ingress rejects wrong authentication, unsupported media, oversized bodies and disabled gates", async () => {
    const f = await fixture(),
      loop = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "webhook" },
      })
    const { handleLoopWebhook } = await import("./loop-webhook.server")
    const rotated = await service.commandLoop(
      f.actors[0],
      f.teamId,
      randomUUID(),
      { action: "rotate-webhook", id: loop.id, expectedRevision: 1 }
    )
    if (rotated.status !== "saved" || !rotated.webhookSecret)
      throw Error("Secret generation failed")
    await service.commandLoop(f.actors[0], f.teamId, randomUUID(), {
      action: "enable",
      id: loop.id,
      expectedRevision: 2,
    })
    const headers = {
        Authorization: `Bearer ${rotated.webhookSecret}`,
        "Content-Type": "application/json",
        "Webhook-Id": randomUUID(),
      },
      url = `http://localhost/api/loops/${loop.id}/webhook`
    expect((await handleLoopWebhook(new Request(url), loop.id)).status).toBe(
      405
    )
    expect(
      (
        await handleLoopWebhook(
          new Request(url, { method: "POST", body: "{}" }),
          loop.id
        )
      ).status
    ).toBe(404)
    expect(
      (
        await handleLoopWebhook(
          new Request(url, {
            method: "POST",
            headers: { ...headers, "Content-Type": "text/plain" },
            body: "{}",
          }),
          loop.id
        )
      ).status
    ).toBe(415)
    expect(
      (
        await handleLoopWebhook(
          new Request(url, { method: "POST", headers, body: "{" }),
          loop.id
        )
      ).status
    ).toBe(400)
    expect(
      (
        await handleLoopWebhook(
          new Request(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ content: "x".repeat(131073) }),
          }),
          loop.id
        )
      ).status
    ).toBe(413)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_runs WHERE loop_id=$1",
          [loop.id]
        )
      ).rows[0].n
    ).toBe(0)
    vi.stubEnv("FORGE_LOOPS_ENABLED", "false")
    try {
      expect(
        (
          await handleLoopWebhook(
            new Request(url, { method: "POST", headers, body: "{}" }),
            loop.id
          )
        ).status
      ).toBe(404)
    } finally {
      vi.stubEnv("FORGE_LOOPS_ENABLED", "true")
    }
  })
  it("due schedules coalesce missed ticks and concurrent scanners do not duplicate the occurrence", async () => {
    const f = await fixture(),
      startAt = new Date(Date.now() + 60000).toISOString(),
      loop = await create(f, f.teamId, {
        ...fields(),
        trigger: {
          kind: "schedule",
          unit: "hours",
          interval: 1,
          startAt,
          timeZone: "Europe/Paris",
        },
      })
    await service.commandLoop(f.actors[0], f.teamId, randomUUID(), {
      action: "enable",
      id: loop.id,
      expectedRevision: 1,
    })
    const { enqueueScheduledLoops } = await import("./loop-dispatch.server"),
      now = new Date(new Date(startAt).getTime() + 10 * 3600000)
    await Promise.all([
      enqueueScheduledLoops(now, f.workspaceId),
      enqueueScheduledLoops(now, f.workspaceId),
    ])
    const rows = (
      await pool.query("SELECT * FROM loop_runs WHERE loop_id=$1", [loop.id])
    ).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].event.scheduledAt).toBe(startAt)
    expect(
      (
        await pool.query("SELECT next_run_at FROM team_loops WHERE id=$1", [
          loop.id,
        ])
      ).rows[0].next_run_at.getTime()
    ).toBeGreaterThan(now.getTime())
    await enqueueScheduledLoops(now, f.workspaceId)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_runs WHERE loop_id=$1",
          [loop.id]
        )
      ).rows[0].n
    ).toBe(1)
  })
  it("claims a queued run once, persists its actual result and blocks a queued run after disable", async () => {
    const f = await fixture(),
      loop = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "webhook" },
      })
    await enableFixture(f, loop.id)
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm")
    const row = (
      await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
    )[0]
    await db.transaction((tx) =>
      service.enqueueLoopRun(tx, row, "test:first", {
        kind: "webhook",
        payload: { test: true },
      })
    )
    const { executeNextLoopRun } = await import("./loop-execution.server")
    let release!: () => void, entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve
      }),
      hold = new Promise<void>((resolve) => {
        release = resolve
      })
    const executor = vi.fn(async () => {
      entered()
      await hold
      return { state: "completed" as const, result: "Actual acceptance result" }
    })
    const first = executeNextLoopRun(executor, f.workspaceId)
    await enteredPromise
    expect(await executeNextLoopRun(executor, f.workspaceId)).toBeNull()
    release()
    await first
    expect(executor).toHaveBeenCalledTimes(1)
    expect(
      (
        await pool.query(
          "SELECT state,result FROM loop_runs WHERE loop_id=$1",
          [loop.id]
        )
      ).rows[0]
    ).toEqual({ state: "completed", result: "Actual acceptance result" })
    await db.transaction((tx) =>
      service.enqueueLoopRun(tx, row, "test:second", {
        kind: "webhook",
        payload: { test: 2 },
      })
    )
    await service.commandLoop(f.actors[1], f.teamId, randomUUID(), {
      action: "disable",
      id: loop.id,
      expectedRevision: 1,
    })
    await executeNextLoopRun(executor, f.workspaceId)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(
      (
        await pool.query(
          "SELECT state,error_code FROM loop_runs WHERE event_key='test:second' AND loop_id=$1",
          [loop.id]
        )
      ).rows[0]
    ).toEqual({ state: "cancelled", error_code: null })
  })
  it("an uncertain provider start is never blindly retried", async () => {
    const f = await fixture(),
      loop = await create(f)
    await enableFixture(f, loop.id)
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm")
    const row = (
      await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
    )[0]
    await db.transaction((tx) =>
      service.enqueueLoopRun(tx, row, "uncertain", { kind: "manual" })
    )
    const { executeNextLoopRun } = await import("./loop-execution.server"),
      executor = vi.fn(async () => {
        throw Error("UNCERTAIN_DISPATCH")
      })
    await executeNextLoopRun(executor, f.workspaceId)
    expect(
      (
        await pool.query(
          "SELECT state,error_code FROM loop_runs WHERE loop_id=$1",
          [loop.id]
        )
      ).rows[0]
    ).toEqual({
      state: "uncertain",
      error_code: "DISPATCH_REQUIRES_RECONCILIATION",
    })
    expect(await executeNextLoopRun(executor, f.workspaceId)).toBeNull()
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it("one project spanning two public teams queues a matching shared Loop only once", async () => {
    const f = await fixture(),
      loop = await create(f, f.teamId, {
        ...fields(),
        teamAccess: "all-public-teams",
        trigger: { kind: "event", entity: "project", event: "created" },
      }),
      secondTeam = randomUUID(),
      projectId = randomUUID()
    await pool.query(
      "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1::uuid,$2,'Second team',$1::text,$3,'workspace','emoji','🔥','#94a3b8','UTC',$4)",
      [secondTeam, f.workspaceId, secondTeam.slice(0, 5), users[0]]
    )
    await enableFixture(f, loop.id)
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Shared project')",
        [projectId, f.workspaceId]
      )
      await client.query(
        "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3),($1,$2,$4)",
        [f.workspaceId, projectId, f.teamId, secondTeam]
      )
      await client.query("COMMIT")
    } finally {
      await client.query("ROLLBACK").catch(() => {})
      client.release()
    }
    const { enqueueNativeLoopEvents } = await import("./loop-dispatch.server")
    expect(await enqueueNativeLoopEvents(100, f.workspaceId)).toBe(2)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_runs WHERE loop_id=$1",
          [loop.id]
        )
      ).rows[0].n
    ).toBe(1)
    expect(await enqueueNativeLoopEvents(100, f.workspaceId)).toBe(0)
  })
  it("a shared Loop survives its configuring member leaving; remaining teammates retain control", async () => {
    const f = await fixture(),
      loop = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "webhook" },
      })
    await enableFixture(f, loop.id)
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm")
    const row = (
      await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
    )[0]
    await db.transaction((tx) =>
      service.enqueueLoopRun(tx, row, "shared-service", {
        kind: "webhook",
        payload: { event: "accepted" },
      })
    )
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, users[0]]
    )
    const { executeNextLoopRun } = await import("./loop-execution.server"),
      executor = vi.fn(async (actor: Actor) => {
        expect(actor.authentication.kind).toBe("loop")
        return {
          state: "completed" as const,
          result: "Shared service execution",
        }
      })
    await executeNextLoopRun(executor, f.workspaceId)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(
      (await service.readLoops(f.actors[1], f.teamId)).loops[0].enabled
    ).toBe(true)
    expect(
      (
        await pool.query("SELECT state FROM loop_runs WHERE loop_id=$1", [
          loop.id,
        ])
      ).rows[0].state
    ).toBe("completed")
    await expect(service.readLoops(f.actors[0], f.teamId)).rejects.toThrow()
  })
  it("a private-team Loop cannot widen its scope to all public teams", async () => {
    const f = await fixture()
    await expect(
      create(f, f.privateTeamId, {
        ...fields(),
        teamAccess: "all-public-teams",
      })
    ).rejects.toThrow()
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM team_loops WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(0)
  })

  it("Loop principals cannot route personal/local models, elevate scopes or expand an in-flight scope", async () => {
    const f = await fixture(),
      loop = await create(f)
    await enableFixture(f, loop.id)
    const cloud = await seedModel(f, "workspace"),
      personal = await seedModel(f, "personal"),
      local = await seedModel(f, "workspace", "local-only")
    const { db, teamLoops, teams } = await import("@/db"),
      { eq } = await import("drizzle-orm")
    const row = (
      await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
    )[0]
    const run = await db.transaction((tx) =>
      service.enqueueLoopRun(tx, row, "security-scope", { kind: "manual" })
    )
    await pool.query("UPDATE loop_runs SET state='running' WHERE id=$1", [
      run.id,
    ])
    // A wider current configuration must not expand the immutable run snapshot.
    await pool.query(
      `UPDATE team_loops SET fields=jsonb_set(fields,'{teamAccess}','"all-public-teams"') WHERE id=$1`,
      [loop.id]
    )
    const { currentLoopActor } = await import("./loop-actor.server"),
      principal: Actor = {
        ...f.actors[0],
        userId: loopPrincipalId(loop.id),
        workspaceRole: "owner",
        authentication: { kind: "loop", loopId: loop.id, runId: run.id },
        scopes: null,
      }
    const actor = await db.transaction((tx) =>
      currentLoopActor(tx, principal, run.id)
    )
    expect(actor.workspaceRole).toBe("member")
    expect(actor.loopScope?.allPublic).toBe(false)
    const restricted = await db.transaction((tx) =>
      currentLoopActor(
        tx,
        {
          ...principal,
          scopes: ["model-connections:read", "model-connections:write"],
        },
        run.id
      )
    )
    expect(restricted.scopes).toEqual(["model-connections:read"])
    const { listModelsForRouting } =
      await import("@/application/agents/model-registry.server")
    const models = await listModelsForRouting(actor)
    expect(models.map((m) => m.connectionId)).toContain(cloud)
    expect(models.map((m) => m.connectionId)).not.toContain(personal)
    expect(models.map((m) => m.connectionId)).not.toContain(local)
    const { readableTeamCondition } =
      await import("@/application/resource-policy.server")
    expect(
      (
        await db
          .select({ id: teams.id })
          .from(teams)
          .where(readableTeamCondition(actor, teams.id))
      ).map((t) => t.id)
    ).toEqual([f.teamId])
    await expect(
      db.transaction((tx) =>
        currentLoopActor(
          tx,
          {
            ...principal,
            authentication: {
              kind: "loop",
              loopId: randomUUID(),
              runId: run.id,
            },
          },
          run.id
        )
      )
    ).rejects.toThrow()
  })
  it("the default cloud execution path persists coordinator thread, run, model and events using FakeAgentRuntime", async () => {
    const f = await fixture(),
      loop = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "webhook" },
      }),
      cloud = await seedModel(f, "workspace")
    await seedModel(f, "personal")
    await enableFixture(f, loop.id)
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm")
    const row = (
      await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
    )[0]
    const run = await db.transaction((tx) =>
      service.enqueueLoopRun(tx, row, "actual-coordinator", {
        kind: "webhook",
        payload: { event: "acceptance" },
      })
    )
    const { executeNextLoopRun } = await import("./loop-execution.server")
    expect(await executeNextLoopRun(undefined, f.workspaceId)).toBe(run.id)
    const saved = (
      await pool.query(
        "SELECT state,result,error_code FROM loop_runs WHERE id=$1",
        [run.id]
      )
    ).rows[0]
    expect(saved).toEqual({
      state: "completed",
      result: "Done",
      error_code: null,
    })
    expect(
      (
        await pool.query(
          "SELECT state,resolved_connection_id,thread_id,initiated_by_user_id FROM agent_runs WHERE id=$1",
          [run.agentRunId]
        )
      ).rows[0]
    ).toMatchObject({
      state: "completed",
      resolved_connection_id: cloud,
      thread_id: run.threadId,
      initiated_by_user_id: loopPrincipalId(loop.id),
    })
    expect(
      (
        await pool.query(
          "SELECT created_by_user_id FROM agent_threads WHERE id=$1",
          [run.threadId]
        )
      ).rows[0].created_by_user_id
    ).toBe(loopPrincipalId(loop.id))
    expect(
      (
        await pool.query(
          'SELECT name,email,email_verified FROM "user" WHERE id=$1',
          [loopPrincipalId(loop.id)]
        )
      ).rows[0]
    ).toEqual({
      name: "Forge Loop",
      email: `loop-${loop.id}@automation.invalid`,
      email_verified: false,
    })
    expect(
      (
        await pool.query(
          "SELECT (SELECT count(*) FROM account WHERE user_id=$1)::int accounts,(SELECT count(*) FROM session WHERE user_id=$1)::int sessions,(SELECT count(*) FROM member WHERE user_id=$1)::int memberships",
          [loopPrincipalId(loop.id)]
        )
      ).rows[0]
    ).toEqual({ accounts: 0, sessions: 0, memberships: 0 })
    expect(run.authorizerId).toBe(users[0])
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM agent_threads WHERE id=$1",
          [run.threadId]
        )
      ).rows[0].n
    ).toBe(1)
    const events = (
      await pool.query(
        "SELECT type,payload_json AS payload FROM agent_events WHERE run_id=$1 ORDER BY sequence",
        [run.agentRunId]
      )
    ).rows
    expect(events.some((e) => e.type === "run.created")).toBe(true)
    expect(
      events.some(
        (e) => e.type === "assistant.message" && e.payload.content === "Done"
      )
    ).toBe(true)
    expect(events.some((e) => e.type === "run.completed")).toBe(true)
  })

  it("cycle boundaries use the canonical timezone and complete after the inclusive final date", async () => {
    const f = await fixture(),
      cycleId = randomUUID()
    // The team's current timezone intentionally differs from the saved cycle window.
    await pool.query("UPDATE teams SET timezone='UTC' WHERE id=$1", [f.teamId])
    await pool.query(
      "INSERT INTO issue_cycles(id,workspace_id,team_id,number,timezone,start_date,end_date) VALUES($1,$2,$3,1,'Europe/Paris','2030-03-31','2030-03-31')",
      [cycleId, f.workspaceId, f.teamId]
    )
    const started = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "event", entity: "cycle", event: "started" },
      }),
      completed = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "event", entity: "cycle", event: "completed" },
      })
    for (const loop of [started, completed]) {
      await enableFixture(f, loop.id)
      await pool.query(
        "UPDATE team_loops SET enabled_at='2030-03-30T20:00:00Z' WHERE id=$1",
        [loop.id]
      )
    }
    const { enqueueScheduledLoops } = await import("./loop-dispatch.server")
    const count = async (id: string) =>
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_runs WHERE loop_id=$1",
          [id]
        )
      ).rows[0].n
    await enqueueScheduledLoops(
      new Date("2030-03-30T22:59:59.999Z"),
      f.workspaceId
    )
    expect(await count(started.id)).toBe(0)
    expect(await count(completed.id)).toBe(0)
    await enqueueScheduledLoops(
      new Date("2030-03-30T23:00:00.000Z"),
      f.workspaceId
    )
    expect(await count(started.id)).toBe(1)
    expect(await count(completed.id)).toBe(0)
    await enqueueScheduledLoops(
      new Date("2030-03-31T21:59:59.999Z"),
      f.workspaceId
    )
    expect(await count(completed.id)).toBe(0)
    // DST makes this cycle's inclusive calendar day 23 elapsed hours long.
    await enqueueScheduledLoops(
      new Date("2030-03-31T22:00:00.000Z"),
      f.workspaceId
    )
    expect(await count(started.id)).toBe(1)
    expect(await count(completed.id)).toBe(1)
    await enqueueScheduledLoops(
      new Date("2030-03-31T22:00:00.000Z"),
      f.workspaceId
    )
    expect(await count(completed.id)).toBe(1)
  })
  it("enabling a cycle Loop after a boundary never backfills that earlier event on the same day", async () => {
    const f = await fixture(),
      cycleId = randomUUID()
    await pool.query(
      "INSERT INTO issue_cycles(id,workspace_id,team_id,number,timezone,start_date,end_date) VALUES($1,$2,$3,1,'Europe/Paris','2030-03-31','2030-03-31')",
      [cycleId, f.workspaceId, f.teamId]
    )
    const started = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "event", entity: "cycle", event: "started" },
      }),
      completed = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "event", entity: "cycle", event: "completed" },
      })
    for (const loop of [started, completed]) await enableFixture(f, loop.id)
    await pool.query(
      "UPDATE team_loops SET enabled_at='2030-03-31T00:00:00Z' WHERE id=$1",
      [started.id]
    )
    await pool.query(
      "UPDATE team_loops SET enabled_at='2030-03-31T23:00:00Z' WHERE id=$1",
      [completed.id]
    )
    const { enqueueScheduledLoops } = await import("./loop-dispatch.server")
    await enqueueScheduledLoops(new Date("2030-04-01T00:00:00Z"), f.workspaceId)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_runs WHERE loop_id=ANY($1::uuid[])",
          [[started.id, completed.id]]
        )
      ).rows[0].n
    ).toBe(0)
  })
  it("native comment adapters preserve linked mentions and nested parent identity without inventing mentions from text", async () => {
    const { loopMatchEvents } = await import("./loop-context.server"),
      { matchesLoopEvent } = await import("@/lib/loop-matching")
    const mentionId = users[1],
      parentId = randomUUID(),
      body = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { id: mentionId, label: "Bob" } },
              { type: "text", text: " Please review" },
            ],
          },
        ],
      }
    const before = {
      id: randomUUID(),
      title: "Issue",
      properties: { comments: [] },
    }
    const linked = loopMatchEvents("issue", "updated", before, {
      ...before,
      properties: {
        comments: [{ id: randomUUID(), document: body, parentId: null }],
      },
    })
    expect(linked).toHaveLength(1)
    expect(linked[0].event).toBe("comment")
    expect(linked[0].comment?.mentionIds).toEqual([mentionId])
    expect(
      matchesLoopEvent(
        {
          trigger: {
            kind: "event",
            entity: "issue",
            event: "comment",
            commentMode: "mentions",
            mentionIds: [mentionId],
          },
          conditions: [],
        },
        linked[0]
      )
    ).toBe(true)
    const plain = loopMatchEvents("issue", "updated", before, {
      ...before,
      properties: {
        comments: [
          { id: randomUUID(), body: "@Bob Please review", parentId: null },
        ],
      },
    })
    expect(plain[0].comment?.mentionIds).toEqual([])
    expect(
      matchesLoopEvent(
        {
          trigger: {
            kind: "event",
            entity: "issue",
            event: "comment",
            commentMode: "mentions",
            mentionIds: [mentionId],
          },
          conditions: [],
        },
        plain[0]
      )
    ).toBe(false)
    for (const entity of ["project", "initiative"] as const) {
      const base = {
          id: randomUUID(),
          name: "Planning",
          properties: { updates: [] },
        },
        next = {
          ...base,
          properties: {
            updates: [
              {
                id: parentId,
                body: "Published update",
                comments: [{ id: randomUUID(), document: body }],
              },
            ],
          },
        }
      const events = loopMatchEvents(entity, "updated", base, next)
      expect(events.map((event) => event.event)).toEqual(["update", "comment"])
      expect(events[1].comment?.parentId).toBe(parentId)
      expect(events[1].comment?.mentionIds).toEqual([mentionId])
      expect(
        matchesLoopEvent(
          {
            trigger: {
              kind: "event",
              entity,
              event: "comment",
              commentMode: "newThread",
            },
            conditions: [],
          },
          events[1]
        )
      ).toBe(false)
      expect(loopMatchEvents(entity, "updated", next, next)).toEqual([])
    }
  })
  it("native any-update Loops ignore comment, reaction and timestamp-only changes", async () => {
    const f = await fixture(),
      loop = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "event", entity: "project", event: "updated" },
      }),
      projectId = randomUUID()
    await enableFixture(f, loop.id)
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        "INSERT INTO projects(id,workspace_id,name,properties) VALUES($1,$2,'Stable project',$3::jsonb)",
        [
          projectId,
          f.workspaceId,
          JSON.stringify({
            description: "Unchanged",
            comments: [],
            updates: [],
          }),
        ]
      )
      await client.query(
        "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
        [f.workspaceId, projectId, f.teamId]
      )
      await client.query("COMMIT")
    } finally {
      await client.query("ROLLBACK").catch(() => {})
      client.release()
    }
    const { enqueueNativeLoopEvents } = await import("./loop-dispatch.server")
    await enqueueNativeLoopEvents(100, f.workspaceId)
    await pool.query(
      "UPDATE projects SET revision=revision+1,properties=properties||$2::jsonb WHERE id=$1",
      [
        projectId,
        JSON.stringify({
          comments: [{ id: randomUUID(), body: "New comment" }],
          reactions: { like: [users[0]] },
          updatedAt: "2030-03-31T00:00:00Z",
        }),
      ]
    )
    await enqueueNativeLoopEvents(100, f.workspaceId)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_runs WHERE loop_id=$1",
          [loop.id]
        )
      ).rows[0].n
    ).toBe(0)
    await pool.query(
      "UPDATE projects SET properties=jsonb_set(properties,'{description}','\"Business content changed\"') WHERE id=$1",
      [projectId]
    )
    await enqueueNativeLoopEvents(100, f.workspaceId)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_runs WHERE loop_id=$1",
          [loop.id]
        )
      ).rows[0].n
    ).toBe(1)
  })
  it("agent callbacks use the saved Loop marker; normal agents never depend on Loop tables", async () => {
    const f = await fixture(),
      loop = await create(f)
    await enableFixture(f, loop.id)
    const { db, teamLoops, loopRuns } = await import("@/db"),
      { eq } = await import("drizzle-orm"),
      { currentCommandActor } =
        await import("@/application/commands/command-actor.server")
    const loopRow = (
      await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
    )[0]
    const run = await db.transaction((tx) =>
      service.enqueueLoopRun(tx, loopRow, "callback", { kind: "manual" })
    )
    await pool.query("UPDATE loop_runs SET state='running' WHERE id=$1", [
      run.id,
    ])
    const normalThread = randomUUID(),
      normalRun = randomUUID()
    for (const [threadId, agentRunId, selection] of [
      [normalThread, normalRun, {}],
      [run.threadId, run.agentRunId, { loopRunId: run.id }],
    ] as const) {
      await pool.query(
        "INSERT INTO agent_threads(id,workspace_id,created_by_user_id,title,status,runtime_kind) VALUES($1,$2,$3,'Callback fixture','active','eve')",
        [
          threadId,
          f.workspaceId,
          agentRunId === normalRun ? users[0] : loopPrincipalId(loop.id),
        ]
      )
      await pool.query(
        "INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'running','forge-native',$4::jsonb)",
        [
          agentRunId,
          threadId,
          agentRunId === normalRun ? users[0] : loopPrincipalId(loop.id),
          JSON.stringify(selection),
        ]
      )
    }
    const actor = (runId: string): Actor => ({
      ...f.actors[0],
      userId: runId === normalRun ? users[0] : loopPrincipalId(loop.id),
      authentication: { kind: "agent", runId, tokenId: "acceptance-token" },
      scopes: ["issues:read", "agents:write"],
    })
    let loopTableReads = 0
    await db.transaction(async (tx) => {
      const observed = new Proxy(tx, {
        get(target, key, receiver) {
          if (key !== "select") return Reflect.get(target, key, receiver)
          return (...args: Array<unknown>) => {
            const builder = Reflect.apply(target.select, target, args)
            return new Proxy(builder, {
              get(selectTarget, method, selectReceiver) {
                if (method !== "from")
                  return Reflect.get(selectTarget, method, selectReceiver)
                return (table: unknown) => {
                  if (table === teamLoops || table === loopRuns)
                    loopTableReads++
                  return Reflect.apply(selectTarget.from, selectTarget, [table])
                }
              },
            })
          }
        },
      })
      vi.stubEnv("FORGE_LOOPS_ENABLED", "false")
      try {
        expect(
          (await currentCommandActor(observed, actor(normalRun))).loopScope
        ).toBeUndefined()
      } finally {
        vi.stubEnv("FORGE_LOOPS_ENABLED", "true")
      }
    })
    expect(loopTableReads).toBe(0)
    const scoped = await db.transaction((tx) =>
      currentCommandActor(tx, actor(run.agentRunId))
    )
    expect(scoped.loopScope?.loopId).toBe(loop.id)
    vi.stubEnv("FORGE_LOOPS_ENABLED", "false")
    try {
      await expect(
        db.transaction((tx) => currentCommandActor(tx, actor(run.agentRunId)))
      ).rejects.toThrow()
    } finally {
      vi.stubEnv("FORGE_LOOPS_ENABLED", "true")
    }
  })

  it("a cancel request made during execution survives the transition to approval wait", async () => {
    const f = await fixture(),
      loop = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "webhook" },
      })
    await enableFixture(f, loop.id)
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm")
    const row = (
      await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
    )[0]
    const run = await db.transaction((tx) =>
      service.enqueueLoopRun(tx, row, "cancel-race", {
        kind: "webhook",
        payload: { event: "cancelled while active" },
      })
    )
    const { executeNextLoopRun } = await import("./loop-execution.server")
    let entered!: () => void, release!: () => void
    const active = new Promise<void>((resolve) => {
        entered = resolve
      }),
      barrier = new Promise<void>((resolve) => {
        release = resolve
      })
    const first = executeNextLoopRun(async () => {
      entered()
      await barrier
      return { state: "waiting-for-approval", result: "Write needs approval" }
    }, f.workspaceId)
    await active
    try {
      await service.commandLoop(f.actors[1], f.teamId, randomUUID(), {
        action: "cancel-run",
        id: loop.id,
        expectedRevision: 1,
        runId: run.id,
      })
    } finally {
      release()
    }
    await first
    const paused = (
      await pool.query(
        "SELECT state,pending_decision FROM loop_runs WHERE id=$1",
        [run.id]
      )
    ).rows[0]
    expect(paused).toMatchObject({
      state: "waiting-for-approval",
      pending_decision: { action: "cancel-run" },
    })
    const cancelling = vi.fn(async (_actor: Actor, claimed: ClaimedLoopRun) => {
      expect(claimed.pendingDecision).toMatchObject({ action: "cancel-run" })
      return { state: "cancelled" as const, result: "Cancelled" }
    })
    expect(await executeNextLoopRun(cancelling, f.workspaceId)).toBe(run.id)
    expect(cancelling).toHaveBeenCalledTimes(1)
    expect(
      (
        await pool.query(
          "SELECT state,pending_decision FROM loop_runs WHERE id=$1",
          [run.id]
        )
      ).rows[0]
    ).toEqual({ state: "cancelled", pending_decision: null })
  })

  it("shared Loop threads never become personal conversations; artifact metadata follows live team access", async () => {
    const f = await fixture(),
      loop = await create(f, f.privateTeamId, {
        ...fields(),
        trigger: { kind: "webhook" },
      })
    await pool.query(
      "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
      [f.workspaceId, f.privateTeamId, users[1]]
    )
    await seedModel(f, "workspace")
    await enableFixture(f, loop.id)
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm")
    const row = (
      await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
    )[0]
    const run = await db.transaction((tx) =>
        service.enqueueLoopRun(tx, row, "private-shared-access", {
          kind: "webhook",
          payload: { event: "private" },
        })
      ),
      personalThread = randomUUID()
    // Reproduce the window after thread creation but before agent_runs insertion.
    for (const id of [run.threadId, personalThread])
      await pool.query(
        "INSERT INTO agent_threads(id,workspace_id,created_by_user_id,title,status,runtime_kind) VALUES($1,$2,$3,'Acceptance thread','active','eve')",
        [
          id,
          f.workspaceId,
          id === run.threadId ? loopPrincipalId(loop.id) : users[0],
        ]
      )
    const { createProductionAgentCoordinator } =
        await import("@/application/agents/agent-http-production.server"),
      coordinator = createProductionAgentCoordinator()
    const listedBeforeStart = await coordinator.listThreads(f.actors[0])
    expect(listedBeforeStart.map((thread) => thread.id)).toContain(
      personalThread
    )
    expect(listedBeforeStart.map((thread) => thread.id)).not.toContain(
      run.threadId
    )
    const { executeNextLoopRun } = await import("./loop-execution.server")
    await executeNextLoopRun(undefined, f.workspaceId)
    expect(
      (await pool.query("SELECT state FROM loop_runs WHERE id=$1", [run.id]))
        .rows[0].state
    ).toBe("completed")
    // Direct personal-agent access is denied even before the configurator loses access.
    await expect(
      coordinator.listThreadEvents(f.actors[0], run.threadId)
    ).rejects.toThrow()
    await expect(
      coordinator.listRunEvents(f.actors[0], run.agentRunId)
    ).rejects.toThrow()
    const artifactId = randomUUID(),
      approvalId = randomUUID()
    await pool.query(
      "INSERT INTO agent_artifacts(id,run_id,kind,name,content_type,size_bytes,storage_reference,checksum) VALUES($1,$2,'report','Acceptance.txt','text/plain',4,'acceptance-metadata-only',$3)",
      [artifactId, run.agentRunId, "b".repeat(64)]
    )
    const { DrizzleAgentArtifactStore } =
        await import("@/adapters/agents/drizzle-artifact-store.server"),
      artifacts = new DrizzleAgentArtifactStore()
    expect(
      (await artifacts.getAuthorized(f.workspaceId, users[0], artifactId))?.id
    ).toBe(artifactId)
    expect(
      (await artifacts.getAuthorized(f.workspaceId, users[1], artifactId))?.id
    ).toBe(artifactId)
    await pool.query(
      "UPDATE agent_runs SET state='waiting-for-approval' WHERE id=$1",
      [run.agentRunId]
    )
    await pool.query(
      "UPDATE loop_runs SET state='waiting-for-approval' WHERE id=$1",
      [run.id]
    )
    await pool.query(
      "INSERT INTO agent_approvals(id,workspace_id,run_id,requested_for_user_id,capability_id,risk,input_hash,redacted_input_summary,state,nonce,expires_at) VALUES($1,$2,$3,$4,'teams.update','reversible-write',$5,'{}','pending',$6,now()+interval '1 hour')",
      [
        approvalId,
        f.workspaceId,
        run.agentRunId,
        loopPrincipalId(loop.id),
        "a".repeat(64),
        randomUUID(),
      ]
    )
    await pool.query(
      "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
      [f.workspaceId, f.privateTeamId, users[0]]
    )
    expect(
      (await coordinator.listThreads(f.actors[0])).map((thread) => thread.id)
    ).not.toContain(run.threadId)
    await expect(
      coordinator.listThreadEvents(f.actors[0], run.threadId)
    ).rejects.toThrow()
    await expect(
      coordinator.listRunEvents(f.actors[0], run.agentRunId)
    ).rejects.toThrow()
    await expect(
      coordinator.resolveApproval(f.actors[0], approvalId, "approved")
    ).rejects.toThrow()
    await expect(
      coordinator.cancelRun(f.actors[0], run.agentRunId)
    ).rejects.toThrow()
    expect(
      (
        await pool.query("SELECT state FROM agent_approvals WHERE id=$1", [
          approvalId,
        ])
      ).rows[0].state
    ).toBe("pending")
    expect(
      (
        await pool.query("SELECT state FROM agent_runs WHERE id=$1", [
          run.agentRunId,
        ])
      ).rows[0].state
    ).toBe("waiting-for-approval")
    expect(
      await artifacts.getAuthorized(f.workspaceId, users[0], artifactId)
    ).toBeNull()
    expect(
      (await artifacts.getAuthorized(f.workspaceId, users[1], artifactId))?.id
    ).toBe(artifactId)
    expect(
      (await service.readLoops(f.actors[1], f.privateTeamId)).runs[0].id
    ).toBe(run.id)
    const { currentCommandActor } =
      await import("@/application/commands/command-actor.server")
    const callback = await db.transaction((tx) =>
      currentCommandActor(tx, {
        ...f.actors[0],
        userId: loopPrincipalId(loop.id),
        authentication: {
          kind: "agent",
          runId: run.agentRunId,
          tokenId: "acceptance-token",
        },
        scopes: ["issues:read", "agents:write"],
      })
    )
    expect(callback.loopScope?.loopId).toBe(loop.id)
  }, 15000)

  it("workspace guest agent restrictions deny enable, Run now and approvals without hiding readable team Loops", async () => {
    const f = await fixture(),
      startAt = new Date(Date.now() + 60000).toISOString(),
      loop = await create(f, f.teamId, {
        ...fields(),
        trigger: {
          kind: "schedule",
          unit: "hours",
          interval: 1,
          startAt,
          timeZone: "Europe/Paris",
        },
      })
    await pool.query(
      "INSERT INTO workspace_security_settings(workspace_id,loops_policy,block_guest_agent_access) VALUES($1,'all-members',true) ON CONFLICT(workspace_id) DO UPDATE SET loops_policy='all-members',block_guest_agent_access=true",
      [f.workspaceId]
    )
    await service.commandLoop(f.actors[0], f.teamId, randomUUID(), {
      action: "enable",
      id: loop.id,
      expectedRevision: 1,
    })
    await pool.query(
      "UPDATE member SET role='guest' WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, users[1]]
    )
    expect((await service.readLoops(f.actors[1], f.teamId)).loops[0].id).toBe(
      loop.id
    )
    for (const command of [
      { action: "enable", id: loop.id, expectedRevision: 2 },
      { action: "run-now", id: loop.id, expectedRevision: 2 },
      {
        action: "approve",
        id: loop.id,
        expectedRevision: 2,
        runId: randomUUID(),
        approvalId: randomUUID(),
        inputHash: "a".repeat(64),
      },
    ])
      await expect(
        service.commandLoop(f.actors[1], f.teamId, randomUUID(), command)
      ).rejects.toThrow("security policy does not allow agent execution")
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_runs WHERE loop_id=$1",
          [loop.id]
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].n
    ).toBe(2)
  })
  it("an older approval wait cannot prevent cancellation of the running job in its workspace", async () => {
    const f = await fixture(),
      loop = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "webhook" },
      })
    await enableFixture(f, loop.id)
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm"),
      row = (
        await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
      )[0]
    const waiting = await db.transaction((tx) =>
        service.enqueueLoopRun(tx, row, "old-approval", { kind: "manual" })
      ),
      running = await db.transaction((tx) =>
        service.enqueueLoopRun(tx, row, "running-cancel", { kind: "manual" })
      )
    await pool.query(
      `UPDATE loop_runs SET state='waiting-for-approval',pending_decision='{"action":"approve"}',created_at='1900-01-01T00:00:00Z' WHERE id=$1`,
      [waiting.id]
    )
    await pool.query(
      `UPDATE loop_runs SET state='running',pending_decision='{"action":"cancel-run"}',created_at='1901-01-01T00:00:00Z' WHERE id=$1`,
      [running.id]
    )
    const { executeNextLoopRun } = await import("./loop-execution.server"),
      executor = vi.fn(async (_actor: Actor, claimed: ClaimedLoopRun) => {
        expect(claimed.id).toBe(running.id)
        expect(claimed.pendingDecision).toMatchObject({ action: "cancel-run" })
        return { state: "cancelled" as const, result: null }
      })
    expect(await executeNextLoopRun(executor, f.workspaceId)).toBe(running.id)
    expect(
      (
        await pool.query("SELECT state FROM loop_runs WHERE id=$1", [
          waiting.id,
        ])
      ).rows[0].state
    ).toBe("waiting-for-approval")
    expect(
      (
        await pool.query("SELECT state FROM loop_runs WHERE id=$1", [
          running.id,
        ])
      ).rows[0].state
    ).toBe("cancelled")
  })
  it("a busy workspace's oldest queue entry cannot starve an unrelated workspace", async () => {
    const f = await fixture(),
      g = await fixture(),
      first = await create(f),
      second = await create(g)
    await enableFixture(f, first.id)
    await enableFixture(g, second.id)
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm"),
      a = (
        await db.select().from(teamLoops).where(eq(teamLoops.id, first.id))
      )[0],
      b = (
        await db.select().from(teamLoops).where(eq(teamLoops.id, second.id))
      )[0]
    const blocked = await db.transaction((tx) =>
        service.enqueueLoopRun(tx, a, "blocked-head", { kind: "manual" })
      ),
      busy = await db.transaction((tx) =>
        service.enqueueLoopRun(tx, a, "active-work", { kind: "manual" })
      ),
      available = await db.transaction((tx) =>
        service.enqueueLoopRun(tx, b, "other-workspace", { kind: "manual" })
      )
    // These owned fixtures sort before any unrelated acceptance jobs; only one
    // global claim is made, and its identity is asserted before executor effects.
    await pool.query(
      "UPDATE loop_runs SET created_at='1800-01-01T00:00:00Z' WHERE id=$1",
      [blocked.id]
    )
    await pool.query(
      "UPDATE loop_runs SET state='running',created_at='1801-01-01T00:00:00Z' WHERE id=$1",
      [busy.id]
    )
    await pool.query(
      "UPDATE loop_runs SET created_at='1802-01-01T00:00:00Z' WHERE id=$1",
      [available.id]
    )
    const { executeNextLoopRun } = await import("./loop-execution.server"),
      executor = vi.fn(async (_actor: Actor, claimed: ClaimedLoopRun) => {
        expect(claimed.id).toBe(available.id)
        return {
          state: "completed" as const,
          result: "Unrelated workspace progressed",
        }
      })
    expect(await executeNextLoopRun(executor)).toBe(available.id)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(
      (
        await pool.query("SELECT state FROM loop_runs WHERE id=$1", [
          blocked.id,
        ])
      ).rows[0].state
    ).toBe("queued")
    expect(
      (await pool.query("SELECT state FROM loop_runs WHERE id=$1", [busy.id]))
        .rows[0].state
    ).toBe("running")
  })
  it("Disable and Enable preserve an old schedule anchor and calculate the next future occurrence", async () => {
    const f = await fixture(),
      startAt = new Date(Date.now() + 60000).toISOString(),
      published = {
        ...fields(),
        trigger: {
          kind: "schedule" as const,
          unit: "hours" as const,
          interval: 1,
          startAt,
          timeZone: "Europe/Paris",
        },
      },
      loop = await create(f, f.teamId, published)
    await service.commandLoop(f.actors[0], f.teamId, randomUUID(), {
      action: "enable",
      id: loop.id,
      expectedRevision: 1,
    })
    vi.useFakeTimers({ toFake: ["Date"] })
    const later = new Date(new Date(startAt).getTime() + 10.5 * 3600000)
    vi.setSystemTime(later)
    try {
      await service.commandLoop(f.actors[1], f.teamId, randomUUID(), {
        action: "disable",
        id: loop.id,
        expectedRevision: 2,
      })
      expect(
        await service.commandLoop(f.actors[1], f.teamId, randomUUID(), {
          action: "enable",
          id: loop.id,
          expectedRevision: 3,
        })
      ).toMatchObject({ status: "saved", revision: 4 })
      const row = (
        await pool.query(
          "SELECT fields,next_run_at,enabled FROM team_loops WHERE id=$1",
          [loop.id]
        )
      ).rows[0]
      expect(row.enabled).toBe(true)
      expect(row.fields.trigger.startAt).toBe(startAt)
      expect(row.next_run_at.toISOString()).toBe(
        new Date(new Date(startAt).getTime() + 11 * 3600000).toISOString()
      )
      await expect(
        service.commandLoop(f.actors[0], f.teamId, randomUUID(), {
          action: "save",
          id: loop.id,
          expectedRevision: 4,
          fields: {
            ...published,
            trigger: {
              ...published.trigger,
              startAt: new Date(later.getTime() - 1).toISOString(),
            },
          },
        })
      ).rejects.toThrow("first run in the future")
      expect(
        await service.commandLoop(f.actors[0], f.teamId, randomUUID(), {
          action: "save",
          id: loop.id,
          expectedRevision: 4,
          fields: { ...published, name: "Renamed with preserved cadence" },
        })
      ).toMatchObject({ status: "saved", revision: 5 })
    } finally {
      vi.useRealTimers()
    }
  })
  it("deleted or privately moved source issues revoke subsequent model and capability callbacks", async () => {
    const f = await fixture(),
      loop = await create(f),
      issueId = randomUUID(),
      cloud = await seedModel(f, "workspace")
    for (const teamId of [f.teamId, f.privateTeamId])
      await pool.query(
        "INSERT INTO issue_statuses(id,workspace_id,team_id,name,status_group,color,position) VALUES('backlog',$1,$2,'Backlog','backlog','#94a3b8',0) ON CONFLICT(workspace_id,team_id,id) DO NOTHING",
        [f.workspaceId, teamId]
      )
    await pool.query(
      "INSERT INTO issues(id,workspace_id,team_id,number,title,status_id,creator_id) VALUES($1,$2,$3,1,'Native source','backlog',$4)",
      [issueId, f.workspaceId, f.teamId, users[0]]
    )
    await enableFixture(f, loop.id)
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm"),
      row = (
        await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
      )[0]
    const run = await db.transaction((tx) =>
      service.enqueueLoopRun(tx, row, "native-source-revocation", {
        kind: "native",
        entity: "issue",
        entityId: issueId,
      })
    )
    await pool.query("UPDATE loop_runs SET state='running' WHERE id=$1", [
      run.id,
    ])
    await pool.query(
      "INSERT INTO agent_threads(id,workspace_id,created_by_user_id,title,status,runtime_kind) VALUES($1,$2,$3,'Source callback','active','eve')",
      [run.threadId, f.workspaceId, loopPrincipalId(loop.id)]
    )
    await pool.query(
      "INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'running','forge-native',$4::jsonb)",
      [
        run.agentRunId,
        run.threadId,
        loopPrincipalId(loop.id),
        JSON.stringify({ loopRunId: run.id }),
      ]
    )
    await pool.query(
      "UPDATE loop_runs SET result='Sensitive source analysis',started_at=now() WHERE id=$1",
      [run.id]
    )
    await pool.query(
      "INSERT INTO agent_approvals(id,workspace_id,run_id,requested_for_user_id,capability_id,risk,input_hash,redacted_input_summary,state,nonce,expires_at) VALUES($1,$2,$3,$4,'teams.update','reversible-write',$5,'{\"summary\":\"Sensitive source action\"}','pending',$6,now()+interval '1 hour')",
      [
        randomUUID(),
        f.workspaceId,
        run.agentRunId,
        loopPrincipalId(loop.id),
        "d".repeat(64),
        randomUUID(),
      ]
    )
    const visibleHistory = (
      await service.readLoops(f.actors[1], f.teamId)
    ).runs.find((item) => item.id === run.id)
    expect(visibleHistory).toMatchObject({
      result: "Sensitive source analysis",
      threadId: run.threadId,
    })
    expect(visibleHistory?.approvals).toHaveLength(1)
    const actor: Actor = {
        ...f.actors[0],
        userId: loopPrincipalId(loop.id),
        authentication: {
          kind: "agent",
          runId: run.agentRunId,
          tokenId: randomUUID(),
        },
        scopes: ["teams:read", "issues:read", "agents:write"],
      },
      { authorizeForgeCapability } =
        await import("@/adapters/agents/capability-authorization.server"),
      invocation = {
        capabilityId: "teams.list",
        capabilityVersion: "1",
        input: {},
      }
    expect(
      (await authorizeForgeCapability(actor, invocation)).loopScope?.loopId
    ).toBe(loop.id)
    vi.stubEnv(
      "FORGE_AGENT_MODEL_ACCESS_SECRET",
      "for62-model-access-signing-material-only"
    )
    const { mintAgentModelAccessToken } =
        await import("@/application/agents/model-access-token.server"),
      token = await mintAgentModelAccessToken({
        actor,
        runId: run.agentRunId,
        connectionId: cloud,
        provider: "openai",
        modelId: "gpt-6-astra",
      }),
      { createOpenAIModelProxy } =
        await import("@/application/agents/openai-model-proxy.server")
    const fetcher = vi.fn<typeof fetch>(),
      proxy = createOpenAIModelProxy({ fetcher }),
      request = () =>
        new Request("http://localhost/api/agent/runtime/model/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-6-astra",
            input: "Source context",
          }),
        })
    await pool.query("UPDATE issues SET deleted_at=now() WHERE id=$1", [
      issueId,
    ])
    const hiddenHistory = (
      await service.readLoops(f.actors[1], f.teamId)
    ).runs.find((item) => item.id === run.id)
    expect(hiddenHistory).toMatchObject({
      result: null,
      threadId: null,
      approvals: [],
    })
    await expect(authorizeForgeCapability(actor, invocation)).rejects.toThrow()
    const deleted = await proxy(request(), "responses")
    expect(deleted.status).toBe(403)
    expect((await deleted.json()).error.code).toBe("FORBIDDEN")
    await pool.query("UPDATE issues SET deleted_at=null WHERE id=$1", [issueId])
    expect(
      (await authorizeForgeCapability(actor, invocation)).loopScope?.loopId
    ).toBe(loop.id)
    // The configuring human belongs to this private team, but the Loop does not.
    await pool.query("UPDATE issues SET team_id=$2 WHERE id=$1", [
      issueId,
      f.privateTeamId,
    ])
    await expect(authorizeForgeCapability(actor, invocation)).rejects.toThrow()
    expect(
      (await service.readLoops(f.actors[1], f.teamId)).runs.find(
        (item) => item.id === run.id
      )
    ).toMatchObject({ result: null, threadId: null, approvals: [] })
    const moved = await proxy(request(), "responses")
    expect(moved.status).toBe(403)
    expect((await moved.json()).error.code).toBe("FORBIDDEN")
    expect(fetcher).not.toHaveBeenCalled()
  }, 15000)

  it("queued review decisions reauthorize the actual reviewer and attribute a later peer approval correctly", async () => {
    const f = await fixture(),
      loop = await create(f, f.privateTeamId, {
        ...fields(),
        trigger: { kind: "webhook" },
      })
    await pool.query(
      "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
      [f.workspaceId, f.privateTeamId, users[1]]
    )
    await seedModel(f, "workspace")
    await enableFixture(f, loop.id)
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm"),
      row = (
        await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
      )[0]
    const run = await db.transaction((tx) =>
        service.enqueueLoopRun(tx, row, "reviewer-revocation", {
          kind: "webhook",
          payload: { event: "review" },
        })
      ),
      { executeNextLoopRun } = await import("./loop-execution.server")
    await executeNextLoopRun(undefined, f.workspaceId)
    expect(
      (await pool.query("SELECT state FROM loop_runs WHERE id=$1", [run.id]))
        .rows[0].state
    ).toBe("completed")
    const approvalId = randomUUID(),
      inputHash = "c".repeat(64),
      originalKey = randomUUID(),
      peerKey = randomUUID()
    await pool.query(
      "UPDATE agent_threads SET runtime_session_id='for62-parked-acceptance' WHERE id=$1",
      [run.threadId]
    )
    await pool.query(
      "UPDATE agent_runs SET state='waiting-for-approval' WHERE id=$1",
      [run.agentRunId]
    )
    await pool.query(
      "UPDATE loop_runs SET state='waiting-for-approval' WHERE id=$1",
      [run.id]
    )
    await pool.query(
      "INSERT INTO agent_approvals(id,workspace_id,run_id,requested_for_user_id,capability_id,risk,input_hash,redacted_input_summary,state,nonce,expires_at) VALUES($1,$2,$3,$4,'teams.update','reversible-write',$5,$6::jsonb,'pending',$7,now()+interval '1 hour')",
      [
        approvalId,
        f.workspaceId,
        run.agentRunId,
        loopPrincipalId(loop.id),
        inputHash,
        JSON.stringify({
          summary: "Review an acceptance action",
          details: { runtimeRequestId: "for62-input-request" },
        }),
        randomUUID(),
      ]
    )
    const decision = {
      action: "approve" as const,
      id: loop.id,
      expectedRevision: 1,
      runId: run.id,
      approvalId,
      inputHash,
    }
    await service.commandLoop(
      f.actors[0],
      f.privateTeamId,
      originalKey,
      decision
    )
    expect(
      (
        await pool.query("SELECT pending_decision FROM loop_runs WHERE id=$1", [
          run.id,
        ])
      ).rows[0].pending_decision
    ).toMatchObject({ action: "approve", requestedById: users[0] })
    // Revocation happens after receipt/queue commit and before the worker executes.
    await pool.query(
      "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, users[0]]
    )
    const shouldNeverExecute = vi.fn<LoopExecutor>()
    expect(await executeNextLoopRun(shouldNeverExecute, f.workspaceId)).toBe(
      run.id
    )
    expect(shouldNeverExecute).not.toHaveBeenCalled()
    expect(
      (
        await pool.query(
          "SELECT state,error_code,pending_decision FROM loop_runs WHERE id=$1",
          [run.id]
        )
      ).rows[0]
    ).toEqual({
      state: "waiting-for-approval",
      error_code: "REVIEWER_ACCESS_REVOKED",
      pending_decision: null,
    })
    expect(
      (
        await pool.query(
          "SELECT state,resolved_by_user_id FROM agent_approvals WHERE id=$1",
          [approvalId]
        )
      ).rows[0]
    ).toEqual({ state: "pending", resolved_by_user_id: null })
    await service.commandLoop(f.actors[1], f.privateTeamId, peerKey, decision)
    const events = (
      await pool.query(
        "SELECT r.command_key,e.payload FROM command_outbox_events e JOIN command_receipts r ON r.id=e.command_id WHERE r.workspace_id=$1 AND r.command_key=ANY($2::text[]) AND e.topic='loop.approve'",
        [f.workspaceId, [originalKey, peerKey]]
      )
    ).rows
    expect(events).toHaveLength(2)
    expect(
      events.find((event) => event.command_key === originalKey)?.payload
    ).toMatchObject({
      loopId: loop.id,
      runId: run.id,
      approvalId,
      requestedById: users[0],
    })
    expect(
      events.find((event) => event.command_key === peerKey)?.payload
    ).toMatchObject({
      loopId: loop.id,
      runId: run.id,
      approvalId,
      requestedById: users[1],
    })
    // The real coordinator resolves under the shared service principal, while the
    // reviewer's identity is retained for audit instead of the original enabler.
    expect(await executeNextLoopRun(undefined, f.workspaceId)).toBe(run.id)
    expect(
      (
        await pool.query("SELECT state,result FROM loop_runs WHERE id=$1", [
          run.id,
        ])
      ).rows[0]
    ).toEqual({ state: "completed", result: "Continued" })
    expect(
      (
        await pool.query(
          "SELECT state,resolved_by_user_id FROM agent_approvals WHERE id=$1",
          [approvalId]
        )
      ).rows[0]
    ).toEqual({ state: "approved", resolved_by_user_id: users[1] })
  }, 15000)

  it("pending cancellation immediately revokes agent callbacks while disabled Loops can still confirm cancellation", async () => {
    const f = await fixture(),
      loop = await create(f, f.teamId, {
        ...fields(),
        trigger: { kind: "webhook" },
      }),
      cloud = await seedModel(f, "workspace")
    await enableFixture(f, loop.id)
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm"),
      row = (
        await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
      )[0]
    const run = await db.transaction((tx) =>
        service.enqueueLoopRun(tx, row, "pending-cancel-auth", {
          kind: "webhook",
          payload: { event: "cancel" },
        })
      ),
      { executeNextLoopRun } = await import("./loop-execution.server")
    await executeNextLoopRun(undefined, f.workspaceId)
    expect(
      (await pool.query("SELECT state FROM loop_runs WHERE id=$1", [run.id]))
        .rows[0].state
    ).toBe("completed")
    await pool.query(
      "UPDATE agent_runs SET state='running',completed_at=null WHERE id=$1",
      [run.agentRunId]
    )
    await pool.query(
      "UPDATE loop_runs SET state='running',finished_at=null WHERE id=$1",
      [run.id]
    )
    const callback: Actor = {
        workspaceId: f.workspaceId,
        userId: loopPrincipalId(loop.id),
        workspaceRole: "member",
        authentication: {
          kind: "agent",
          runId: run.agentRunId,
          tokenId: randomUUID(),
        },
        scopes: [
          "teams:read",
          "issues:read",
          "agents:write",
          "model-connections:read",
        ],
      },
      { currentCommandActor } =
        await import("@/application/commands/command-actor.server")
    expect(
      (await db.transaction((tx) => currentCommandActor(tx, callback)))
        .loopScope?.loopId
    ).toBe(loop.id)
    vi.stubEnv(
      "FORGE_AGENT_MODEL_ACCESS_SECRET",
      "for62-model-access-signing-material-only"
    )
    const { mintAgentModelAccessToken } =
        await import("@/application/agents/model-access-token.server"),
      token = await mintAgentModelAccessToken({
        actor: callback,
        runId: run.agentRunId,
        connectionId: cloud,
        provider: "openai",
        modelId: "gpt-6-astra",
      }),
      { createOpenAIModelProxy } =
        await import("@/application/agents/openai-model-proxy.server"),
      fetcher = vi.fn<typeof fetch>(),
      proxy = createOpenAIModelProxy({ fetcher })
    // External-source revocation must stop an in-flight webhook callback,
    // while the narrow internal principal can still confirm cancellation.
    await pool.query(
      "UPDATE workspace_security_settings SET external_loop_sources_enabled=false WHERE workspace_id=$1",
      [f.workspaceId]
    )
    await expect(
      db.transaction((tx) => currentCommandActor(tx, callback))
    ).rejects.toThrow()
    await service.commandLoop(f.actors[1], f.teamId, randomUUID(), {
      action: "cancel-run",
      id: loop.id,
      expectedRevision: 1,
      runId: run.id,
    })
    await expect(
      db.transaction((tx) => currentCommandActor(tx, callback))
    ).rejects.toThrow()
    const { authorizeForgeCapability } =
      await import("@/adapters/agents/capability-authorization.server")
    await expect(
      authorizeForgeCapability(callback, {
        capabilityId: "teams.list",
        capabilityVersion: "1",
        input: {},
      })
    ).rejects.toThrow()
    const response = await proxy(
      new Request("http://localhost/api/agent/runtime/model/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-6-astra",
          input: "Continue after cancellation",
        }),
      }),
      "responses"
    )
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("FORBIDDEN")
    expect(fetcher).not.toHaveBeenCalled()
    // An agent JWT cannot turn itself into the internal cancellation principal.
    await expect(
      db.transaction((tx) =>
        currentCommandActor(tx, {
          ...callback,
          loopScope: {
            loopId: loop.id,
            runId: run.id,
            teamId: f.teamId,
            allPublic: false,
            cancelling: true,
          },
        })
      )
    ).rejects.toThrow()
    const internal: Actor = {
      ...callback,
      authentication: { kind: "loop", loopId: loop.id, runId: run.id },
      scopes: null,
      loopScope: {
        loopId: loop.id,
        runId: run.id,
        teamId: f.teamId,
        allPublic: false,
        cancelling: true,
      },
    }
    const cancelling = await db.transaction((tx) =>
      currentCommandActor(tx, internal)
    )
    expect(cancelling.scopes).toEqual(["agents:read", "agents:write"])
    expect(cancelling.loopScope?.cancelling).toBe(true)
    await service.commandLoop(f.actors[0], f.teamId, randomUUID(), {
      action: "disable",
      id: loop.id,
      expectedRevision: 1,
    })
    expect(
      (
        await pool.query("SELECT enabled FROM team_loops WHERE id=$1", [
          loop.id,
        ])
      ).rows[0].enabled
    ).toBe(false)
    expect(await executeNextLoopRun(undefined, f.workspaceId)).toBe(run.id)
    expect(
      (
        await pool.query(
          "SELECT state,pending_decision FROM loop_runs WHERE id=$1",
          [run.id]
        )
      ).rows[0]
    ).toEqual({ state: "cancelled", pending_decision: null })
    expect(
      (
        await pool.query("SELECT state FROM agent_runs WHERE id=$1", [
          run.agentRunId,
        ])
      ).rows[0].state
    ).toBe("cancelled")
    await expect(
      db.transaction((tx) => currentCommandActor(tx, callback))
    ).rejects.toThrow()
  }, 15000)
  it("an unexpired uncertain run fences other Loops until its original execution window expires", async () => {
    const f = await fixture(),
      first = await create(f),
      second = await create(f)
    await enableFixture(f, first.id)
    await enableFixture(f, second.id)
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm"),
      a = (
        await db.select().from(teamLoops).where(eq(teamLoops.id, first.id))
      )[0],
      b = (
        await db.select().from(teamLoops).where(eq(teamLoops.id, second.id))
      )[0]
    const uncertain = await db.transaction((tx) =>
        service.enqueueLoopRun(tx, a, "uncertain-window", { kind: "manual" })
      ),
      queued = await db.transaction((tx) =>
        service.enqueueLoopRun(tx, b, "after-uncertain", { kind: "manual" })
      )
    await pool.query(
      "UPDATE loop_runs SET state='uncertain',started_at=clock_timestamp() WHERE id=$1",
      [uncertain.id]
    )
    const { executeNextLoopRun } = await import("./loop-execution.server"),
      executor = vi.fn(async (_actor: Actor, claimed: ClaimedLoopRun) => {
        expect(claimed.id).toBe(queued.id)
        return { state: "completed" as const, result: "Next Loop progressed" }
      })
    expect(await executeNextLoopRun(executor, f.workspaceId)).toBeNull()
    expect(executor).not.toHaveBeenCalled()
    expect(
      (await pool.query("SELECT state FROM loop_runs WHERE id=$1", [queued.id]))
        .rows[0].state
    ).toBe("queued")
    await pool.query(
      "UPDATE loop_runs SET started_at=clock_timestamp()-interval '16 minutes' WHERE id=$1",
      [uncertain.id]
    )
    expect(await executeNextLoopRun(executor, f.workspaceId)).toBe(queued.id)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(
      (
        await pool.query("SELECT state FROM loop_runs WHERE id=$1", [
          uncertain.id,
        ])
      ).rows[0].state
    ).toBe("uncertain")
    expect(
      (await pool.query("SELECT state FROM loop_runs WHERE id=$1", [queued.id]))
        .rows[0].state
    ).toBe("completed")
  })

  it("revoking external sources rejects webhook ingress, enabling and publishing an active webhook", async () => {
    const f = await fixture(),
      input = { ...fields(), trigger: { kind: "webhook" as const } },
      loop = await create(f, f.teamId, input)
    await seedModel(f, "workspace")
    const rotated = await service.commandLoop(
      f.actors[0],
      f.teamId,
      randomUUID(),
      {
        action: "rotate-webhook",
        id: loop.id,
        expectedRevision: 1,
      }
    )
    if (rotated.status !== "saved" || !rotated.webhookSecret)
      throw Error("Missing webhook secret")
    expect(
      await service.commandLoop(f.actors[0], f.teamId, randomUUID(), {
        action: "enable",
        id: loop.id,
        expectedRevision: 2,
      })
    ).toMatchObject({ status: "saved", revision: 3 })
    const { handleLoopWebhook } = await import("./loop-webhook.server")
    const request = () =>
      new Request(`http://localhost/api/loops/${loop.id}/webhook`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rotated.webhookSecret}`,
          "Content-Type": "application/json",
          "Webhook-Id": randomUUID(),
        },
        body: "{}",
      })
    expect((await handleLoopWebhook(request(), loop.id)).status).toBe(202)
    await pool.query(
      "UPDATE workspace_security_settings SET external_loop_sources_enabled=false WHERE workspace_id=$1",
      [f.workspaceId]
    )
    expect((await handleLoopWebhook(request(), loop.id)).status).toBe(404)
    await expect(
      service.commandLoop(f.actors[0], f.teamId, randomUUID(), {
        action: "save",
        id: loop.id,
        expectedRevision: 3,
        fields: { ...input, name: "Blocked publication" },
      })
    ).rejects.toThrow("Enable external Loop sources")
    expect(
      await service.commandLoop(f.actors[0], f.teamId, randomUUID(), {
        action: "disable",
        id: loop.id,
        expectedRevision: 3,
      })
    ).toMatchObject({ status: "saved", revision: 4 })
    await expect(
      service.commandLoop(f.actors[0], f.teamId, randomUUID(), {
        action: "enable",
        id: loop.id,
        expectedRevision: 4,
      })
    ).rejects.toThrow("Enable external Loop sources")
    expect(
      (
        await pool.query(
          "SELECT enabled,revision,fields->>'name' name FROM team_loops WHERE id=$1",
          [loop.id]
        )
      ).rows[0]
    ).toEqual({ enabled: false, revision: 4, name: input.name })
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM loop_runs WHERE loop_id=$1",
          [loop.id]
        )
      ).rows[0].n
    ).toBe(1)
  })
  it("admin management policy uses the current role without stopping shared automation or member cancellation", async () => {
    const f = await fixture(),
      loop = await create(f)
    await seedModel(f, "workspace")
    await enableFixture(f, loop.id)
    await pool.query(
      "UPDATE workspace_security_settings SET loops_policy='admins' WHERE workspace_id=$1",
      [f.workspaceId]
    )
    expect((await service.readLoops(f.actors[1], f.teamId)).loops[0].id).toBe(
      loop.id
    )
    for (const command of [
      { action: "create", id: randomUUID(), fields: fields() },
      {
        action: "save",
        id: loop.id,
        expectedRevision: 1,
        fields: fields("Forbidden"),
      },
      ...["enable", "disable", "delete", "rotate-webhook"].map((action) => ({
        action,
        id: loop.id,
        expectedRevision: 1,
      })),
    ])
      await expect(
        service.commandLoop(f.actors[1], f.teamId, randomUUID(), command)
      ).rejects.toThrow("restricts Loop management")
    const { db, teamLoops } = await import("@/db"),
      { eq } = await import("drizzle-orm"),
      row = (
        await db.select().from(teamLoops).where(eq(teamLoops.id, loop.id))
      )[0],
      run = await db.transaction((tx) =>
        service.enqueueLoopRun(tx, row, "policy-existing-automation", {
          kind: "manual",
        })
      ),
      { executeNextLoopRun } = await import("./loop-execution.server")
    const execute = vi.fn(async (actor: Actor) => {
      expect(actor.userId).toBe(loopPrincipalId(loop.id))
      return { state: "waiting-for-approval" as const, result: "Needs review" }
    })
    expect(await executeNextLoopRun(execute, f.workspaceId)).toBe(run.id)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(
      await service.commandLoop(f.actors[1], f.teamId, randomUUID(), {
        action: "cancel-run",
        id: loop.id,
        expectedRevision: 1,
        runId: run.id,
      })
    ).toMatchObject({ status: "saved" })
    const cancel = vi.fn(async (actor: Actor, claimed: ClaimedLoopRun) => {
      expect(actor.loopScope?.cancelling).toBe(true)
      expect(claimed.pendingDecision?.action).toBe("cancel-run")
      return { state: "cancelled" as const, result: null }
    })
    expect(await executeNextLoopRun(cancel, f.workspaceId)).toBe(run.id)
    expect(cancel).toHaveBeenCalledTimes(1)
    await pool.query(
      "UPDATE member SET role='admin' WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, users[1]]
    )
    // The session actor still says member; authorization reloads its current role.
    expect(f.actors[1].workspaceRole).toBe("member")
    expect(
      await service.commandLoop(f.actors[1], f.teamId, randomUUID(), {
        action: "save",
        id: loop.id,
        expectedRevision: 1,
        fields: fields("Current admin publication"),
      })
    ).toMatchObject({ status: "saved", revision: 2 })
    await pool.query(
      "UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2",
      [f.workspaceId, users[1]]
    )
    await expect(
      service.commandLoop(
        { ...f.actors[1], workspaceRole: "admin" },
        f.teamId,
        randomUUID(),
        {
          action: "disable",
          id: loop.id,
          expectedRevision: 2,
        }
      )
    ).rejects.toThrow("restricts Loop management")
    expect(
      (
        await pool.query(
          "SELECT enabled,revision FROM team_loops WHERE id=$1",
          [loop.id]
        )
      ).rows[0]
    ).toEqual({ enabled: true, revision: 2 })
  })
})

// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  assertIsolatedTestConnection,
  verifyIsolatedTestIdentity,
} from "../../scripts/lib/isolated-test-database"
import { schemaIsReady } from "../application/operations/readiness-schema"
import type { Actor } from "@/application/actor"
import type * as Database from "./index"
import type * as Commands from "@/application/planning/relationships.server"

const file = process.env.FORGE_TENANT_TEST_DATABASE_FILE

describe.skipIf(!file)("PostgreSQL tenant integrity (FOR-31)", () => {
  const marker = `for31-${randomUUID()}`
  const w = [marker, `${marker}-foreign`]
  const user = `${marker}-owner`,
    member = `${marker}-member`
  const team = [randomUUID(), randomUUID(), randomUUID()]
  const project = [randomUUID(), randomUUID(), randomUUID()]
  const issue = Array.from({ length: 6 }, () => randomUUID())
  const thread = [randomUUID(), randomUUID(), randomUUID()]
  const run = [randomUUID(), randomUUID(), randomUUID()]
  const connectionId = randomUUID(),
    approval = randomUUID(),
    template = randomUUID()
  const label = [randomUUID(), randomUUID(), randomUUID()]
  let pool: Pool,
    appPool: Pool,
    database: typeof Database,
    commands: typeof Commands
  let verified = false
  const cleanup: { pool?: Pool; appPool?: Pool; database?: typeof Database } =
    {}
  function actor(overrides: Partial<Actor> = {}): Actor {
    return {
      userId: user,
      workspaceId: w[0],
      workspaceRole: "owner",
      authentication: { kind: "session", sessionId: "fixture" },
      scopes: null,
      ...overrides,
    }
  }
  async function rejected(sql: string, values: Array<unknown>, code = "23503") {
    await expect(pool.query(sql, values)).rejects.toMatchObject({ code })
  }
  beforeAll(async () => {
    const { connection, applicationConnection } = JSON.parse(
      readFileSync(file!, "utf8")
    )
    const target = assertIsolatedTestConnection(connection)
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: connection, max: 5 })
    cleanup.pool = pool
    await verifyIsolatedTestIdentity(pool, target)
    verified = true
    expect(await schemaIsReady(pool)).toBe(true)
    const missingGuards = await pool.query(
      "SELECT tc.table_name FROM information_schema.table_constraints tc WHERE tc.table_schema='public' AND tc.constraint_type='PRIMARY KEY' AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=('public.'||quote_ident(tc.table_name))::regclass AND t.tgname='forge_immutable_identity' AND t.tgenabled='O')"
    )
    expect(missingGuards.rows).toEqual([])
    assertIsolatedTestConnection(applicationConnection)
    appPool = new Pool({ connectionString: applicationConnection, max: 2 })
    cleanup.appPool = appPool
    await verifyIsolatedTestIdentity(appPool, target)
    vi.stubEnv("DATABASE_URL", applicationConnection)
    database = await import("./index")
    cleanup.database = database
    commands = await import("@/application/planning/relationships.server")
    for (const id of w) {
      await pool.query(
        "INSERT INTO public.organization(id,name,slug) VALUES($1,$1,$1)",
        [id]
      )
      await pool.query(
        "INSERT INTO public.workspace_entitlements(workspace_id,plan,status) VALUES($1,'basic','active')",
        [id]
      )
    }
    for (const id of [user, member])
      await pool.query(
        'INSERT INTO public."user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [id, `${id}@example.test`]
      )
    // Owner belongs only to W1: forging an Actor.workspaceId must not grant W2.
    for (const id of [user, member])
      await pool.query(
        "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)",
        [randomUUID(), w[0], id, id === user ? "owner" : "member"]
      )
    for (let i = 0; i < team.length; i++)
      await pool.query(
        "INSERT INTO public.teams(id,workspace_id,slug,identifier,name,icon_kind,icon_value,color,timezone,visibility,created_by_user_id) VALUES($1,$2,$3,$3,$3,'icon','fixture','#000000','UTC',$4,$5)",
        [
          team[i],
          w[i === 2 ? 1 : 0],
          `T${i}`,
          i === 1 ? "private" : "workspace",
          user,
        ]
      )
    for (let i = 0; i < project.length; i++)
      await pool.query(
        "INSERT INTO public.projects(id,workspace_id,name) VALUES($1,$2,'fixture')",
        [project[i], w[i === 2 ? 1 : 0]]
      )
    await pool.query(
      "INSERT INTO public.project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
      [w[0], project[1], team[1]]
    )
    for (let i = 0; i < issue.length; i++)
      await pool.query(
        "INSERT INTO public.issues(id,workspace_id,team_id,number,title) VALUES($1,$2,$3,$4,'fixture')",
        [
          issue[i],
          w[i === 5 ? 1 : 0],
          team[i === 5 ? 2 : i === 4 ? 1 : 0],
          i + 1,
        ]
      )
    for (let i = 0; i < thread.length; i++) {
      await pool.query(
        "INSERT INTO public.agent_threads(id,workspace_id,created_by_user_id) VALUES($1,$2,$3)",
        [thread[i], w[i === 2 ? 1 : 0], user]
      )
      await pool.query(
        "INSERT INTO public.agent_runs(id,thread_id,initiated_by_user_id,execution_kind,requested_selection) VALUES($1,$2,$3,'forge-native','{}')",
        [run[i], thread[i], user]
      )
    }
    await pool.query(
      "INSERT INTO public.agent_approvals(id,workspace_id,run_id,requested_for_user_id,capability_id,risk,input_hash,redacted_input_summary,nonce,expires_at) VALUES($1,$2,$3,$4,'fixture','read',$5,'{}',$6,now()+interval '1 hour')",
      [approval, w[0], run[0], user, "a".repeat(64), randomUUID()]
    )
    await pool.query(
      "INSERT INTO public.model_connections(id,workspace_id,scope,provider,kind,execution_kind,locality,billing_mode,credential_owner,display_name,created_by_user_id) VALUES($1,$2,'workspace','openai','api-key','forge-native','server-capable','forge-managed','forge-server-vault','Fixture',$3)",
      [connectionId, w[1], user]
    )
    await pool.query(
      "INSERT INTO public.team_templates(id,workspace_id,team_id,payload,created_by_user_id) VALUES($1,$2,$3,'{}',$4)",
      [template, w[0], team[1], user]
    )
    for (let i = 0; i < label.length; i++)
      await pool.query(
        "INSERT INTO public.resource_labels(id,workspace_id,team_id,name) VALUES($1,$2,$3,'fixture')",
        [label[i], w[i === 2 ? 1 : 0], i === 0 ? null : team[i]]
      )
  }, 60_000)
  afterAll(async () => {
    try {
      if (cleanup.pool && verified) {
        await pool.query(
          "DELETE FROM public.organization WHERE id=ANY($1::text[])",
          [w]
        )
        await pool.query('DELETE FROM public."user" WHERE id=ANY($1::text[])', [
          [user, member],
        ])
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM public.organization WHERE id=ANY($1::text[])",
              [w]
            )
          ).rows[0].n
        ).toBe(0)
      }
    } finally {
      if (cleanup.database) await cleanup.database.databaseClient.end()
      if (cleanup.appPool) await cleanup.appPool.end()
      if (cleanup.pool) await cleanup.pool.end()
      vi.unstubAllEnvs()
    }
  }, 30_000)

  it("AT-01 rejects foreign issue/project links through direct SQL and service", async () => {
    await rejected(
      "INSERT INTO public.issues(workspace_id,team_id,number,title,project_id) VALUES($1,$2,999,'fixture',$3)",
      [w[0], team[0], project[2]]
    )
    await rejected("UPDATE public.issues SET project_id=$1 WHERE id=$2", [
      project[2],
      issue[0],
    ])
    await expect(
      commands.setIssueProject(actor(), {
        issueId: issue[0],
        targetId: project[2],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(
      (
        await pool.query("SELECT project_id FROM public.issues WHERE id=$1", [
          issue[0],
        ])
      ).rows[0].project_id
    ).toBeNull()
    await commands.setIssueProject(actor(), {
      issueId: issue[0],
      targetId: project[0],
    })
  })
  it("does not authorize supplied workspace IDs, stale roles, missing scopes or private targets", async () => {
    await expect(
      commands.setIssueProject(actor({ workspaceId: w[1] }), {
        issueId: issue[5],
        targetId: project[2],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      commands.setIssueProject(actor({ scopes: ["issues:read"] }), {
        issueId: issue[0],
        targetId: project[0],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      commands.setIssueProject(actor({ userId: member }), {
        issueId: issue[0],
        targetId: project[1],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      commands.setIssueParent(actor({ userId: member }), {
        issueId: issue[0],
        targetId: issue[4],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      commands.setIssueParent(actor(), {
        issueId: issue[0],
        targetId: null,
        workspaceId: w[1],
      } as never)
    ).rejects.toThrow()
  })
  it("allows shared public/private projects without granting private issue access", async () => {
    await pool.query(
      "INSERT INTO public.project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
      [w[0], project[1], team[0]]
    )
    await commands.setIssueProject(actor({ userId: member }), {
      issueId: issue[1],
      targetId: project[1],
    })
    await expect(
      commands.setIssueParent(actor({ userId: member }), {
        issueId: issue[1],
        targetId: issue[4],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
  it.each([
    "team_members",
    "team_templates",
    "team_recurring_issues",
    "call_connections",
    "calls",
  ])("rejects a foreign team on %s even for direct writers", async (tab) => {
    // An existing good row must also be unable to migrate by UPDATE.
    if (tab === "team_members")
      await rejected(
        "INSERT INTO public.team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
        [w[0], team[2], user]
      )
    if (tab === "team_templates" || tab === "team_recurring_issues")
      await rejected(
        `INSERT INTO public.${tab}(workspace_id,team_id,payload,created_by_user_id) VALUES($1,$2,'{}',$3)`,
        [w[0], team[2], user]
      )
    if (tab === "call_connections")
      await rejected(
        "INSERT INTO public.call_connections(workspace_id,team_id,provider,user_id) VALUES($1,$2,'zoom',$3)",
        [w[0], team[2], user]
      )
    if (tab === "calls")
      await rejected(
        "INSERT INTO public.calls(workspace_id,team_id,provider,external_id,title,started_at) VALUES($1,$2,'zoom',$3,'fixture',now())",
        [w[0], team[2], randomUUID()]
      )
  })
  it("enforces all planning relation endpoints and scoped uniqueness", async () => {
    await rejected(
      "INSERT INTO public.project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
      [w[0], project[0], team[2]]
    )
    const initiativeId = randomUUID()
    await pool.query(
      "INSERT INTO public.initiatives(id,workspace_id,name) VALUES($1,$2,'fixture')",
      [initiativeId, w[0]]
    )
    await rejected(
      "INSERT INTO public.initiative_projects(workspace_id,initiative_id,project_id) VALUES($1,$2,$3)",
      [w[0], initiativeId, project[2]]
    )
    await rejected(
      "INSERT INTO public.issue_relations(workspace_id,issue_id,related_issue_id,kind) VALUES($1,$2,$3,'related')",
      [w[0], issue[0], issue[5]]
    )
    await rejected(
      "INSERT INTO public.documents(workspace_id,title,issue_id) VALUES($1,'fixture',$2)",
      [w[0], issue[5]]
    )
    await rejected(
      "INSERT INTO public.documents(workspace_id,title,project_id) VALUES($1,'fixture',$2)",
      [w[0], project[2]]
    )
    await rejected(
      "INSERT INTO public.issues(workspace_id,team_id,number,title) VALUES($1,$2,1,'duplicate')",
      [w[0], team[0]],
      "23505"
    )
    await rejected(
      "INSERT INTO public.resource_labels(workspace_id,name) VALUES($1,'fixture')",
      [w[0]],
      "23505"
    )
    // Workspace labels are allowed on private issues; team labels remain local.
    await pool.query(
      "INSERT INTO public.issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3)",
      [w[0], issue[4], label[0]]
    )
    await rejected(
      "INSERT INTO public.issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3)",
      [w[0], issue[0], label[1]]
    )
    await rejected(
      "INSERT INTO public.issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3)",
      [w[0], issue[0], label[2]]
    )
  })
  it("AT-02 rejects deep cycles and preserves the previous parents", async () => {
    await commands.setIssueParent(actor(), {
      issueId: issue[0],
      targetId: issue[3],
    })
    await commands.setIssueParent(actor(), {
      issueId: issue[1],
      targetId: issue[0],
    })
    await commands.setIssueParent(actor(), {
      issueId: issue[2],
      targetId: issue[1],
    })
    await expect(
      commands.setIssueParent(actor(), {
        issueId: issue[0],
        targetId: issue[2],
      })
    ).rejects.toMatchObject({ code: "INVALID_RELATIONSHIP" })
    await rejected(
      "UPDATE public.issues SET parent_id=$1 WHERE id=$2",
      [issue[2], issue[0]],
      "23514"
    )
    expect(
      (
        await pool.query("SELECT parent_id FROM public.issues WHERE id=$1", [
          issue[0],
        ])
      ).rows[0].parent_id
    ).toBe(issue[3])
    expect(
      (
        await pool.query("SELECT parent_id FROM public.issues WHERE id=$1", [
          issue[2],
        ])
      ).rows[0].parent_id
    ).toBe(issue[1])
    await rejected(
      "UPDATE public.issues SET parent_id=id WHERE id=$1",
      [issue[0]],
      "23514"
    )
    await rejected("UPDATE public.issues SET parent_id=$1 WHERE id=$2", [
      issue[5],
      issue[0],
    ])
  })
  it("rolls back all writes in a transaction when an invalid edge is added", async () => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        "UPDATE public.issues SET title='would be lost' WHERE id=$1",
        [issue[0]]
      )
      await expect(
        client.query("UPDATE public.issues SET parent_id=$1 WHERE id=$2", [
          issue[2],
          issue[0],
        ])
      ).rejects.toMatchObject({ code: "23514" })
      await client.query("ROLLBACK")
      expect(
        (
          await pool.query("SELECT title FROM public.issues WHERE id=$1", [
            issue[0],
          ])
        ).rows[0].title
      ).toBe("fixture")
    } finally {
      await client.query("ROLLBACK")
      client.release()
    }
  })
  it("rejects multi-row insert and update cycles atomically", async () => {
    const a = randomUUID(),
      b = randomUUID()
    await rejected(
      "INSERT INTO public.issues(id,workspace_id,team_id,number,title,parent_id) VALUES($1,$3,$4,101,'a',$2),($2,$3,$4,102,'b',$1)",
      [a, b, w[0], team[0]],
      "23514"
    )
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM public.issues WHERE id=ANY($1::uuid[])",
          [[a, b]]
        )
      ).rows[0].n
    ).toBe(0)
    await rejected(
      "UPDATE public.issues SET parent_id=CASE WHEN id=$1 THEN $2::uuid ELSE $1::uuid END WHERE id=ANY($3::uuid[])",
      [issue[0], issue[3], [issue[0], issue[3]]],
      "23514"
    )
  })

  it.each(["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"])(
    "rejects concurrent opposing parent edits at %s",
    async (isolation) => {
      const a = await pool.connect(),
        b = await pool.connect()
      try {
        await pool.query(
          "UPDATE public.issues SET parent_id=NULL WHERE id=ANY($1::uuid[])",
          [[issue[0], issue[3]]]
        )
        await a.query(`BEGIN ISOLATION LEVEL ${isolation}`)
        await b.query(`BEGIN ISOLATION LEVEL ${isolation}`)
        await b.query(
          "SELECT version FROM public.issue_hierarchy_guards WHERE workspace_id=$1",
          [w[0]]
        ) // establish old snapshot
        await a.query("UPDATE public.issues SET parent_id=$1 WHERE id=$2", [
          issue[3],
          issue[0],
        ])
        const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid
        const pending = b
          .query("UPDATE public.issues SET parent_id=$1 WHERE id=$2", [
            issue[0],
            issue[3],
          ])
          .then(
            () => ({ code: "COMMITTED" }),
            (e) => ({ code: e.code })
          )
        let waiting = false
        for (let attempt = 0; attempt < 100; attempt++) {
          const activity = await pool.query(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
            [pid]
          )
          if (activity.rows[0]?.wait_event_type === "Lock") {
            waiting = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(waiting).toBe(true)
        await a.query("COMMIT")
        expect(["23514", "40001"]).toContain((await pending).code)
        await b.query("ROLLBACK")
        const edges = await pool.query(
          "SELECT id,parent_id FROM public.issues WHERE id=ANY($1::uuid[]) ORDER BY id",
          [[issue[0], issue[3]]]
        )
        expect(edges.rows.filter((r) => r.parent_id !== null)).toHaveLength(1)
      } finally {
        await a.query("ROLLBACK")
        await b.query("ROLLBACK")
        a.release()
        b.release()
      }
    },
    20_000
  )
  it("rejects indirect agent workspace and run/thread mismatches", async () => {
    await rejected(
      "UPDATE public.agent_runs SET resolved_connection_id=$1 WHERE id=$2",
      [connectionId, run[0]]
    )
    await rejected(
      "INSERT INTO public.thread_model_preferences(thread_id,mode,selected_connection_id,selected_model_id) VALUES($1,'manual',$2,'fixture')",
      [thread[0], connectionId]
    )
    await rejected(
      "INSERT INTO public.agent_events(thread_id,run_id,source,source_event_id,sequence,type,payload_json,occurred_at) VALUES($1,$2,'fixture',$3,1,'fixture','{}',now())",
      [thread[1], run[0], randomUUID()]
    )
    await rejected(
      "INSERT INTO public.agent_approvals(workspace_id,run_id,requested_for_user_id,capability_id,risk,input_hash,redacted_input_summary,nonce,expires_at) VALUES($1,$2,$3,'fixture','read',$4,'{}',$5,now()+interval '1 hour')",
      [w[0], run[2], user, "a".repeat(64), randomUUID()]
    )
    await rejected(
      "INSERT INTO public.agent_capability_invocations(workspace_id,user_id,run_id,approval_id,capability_id,capability_version,idempotency_key,input_hash,expires_at) VALUES($1,$2,$3,$4,'fixture','1',$5,$6,now()+interval '1 hour')",
      [w[0], user, run[1], approval, randomUUID(), "a".repeat(64)]
    )
  })
  it("rejects template defaults from a foreign workspace or another same-workspace team", async () => {
    await rejected(
      "INSERT INTO public.team_template_defaults(team_id,audience,template_id) VALUES($1,'members',$2)",
      [team[0], template]
    )
    await rejected(
      "INSERT INTO public.team_template_defaults(team_id,audience,template_id) VALUES($1,'members',$2)",
      [team[2], template]
    )
    await pool.query(
      "INSERT INTO public.team_template_defaults(team_id,audience,template_id) VALUES($1,'members',$2)",
      [team[1], template]
    )
  })
  it("binds receipts and usage reservations to the credential/run workspace", async () => {
    const key = randomUUID(),
      period = randomUUID()
    await pool.query(
      "INSERT INTO public.apikey(id,reference_id,key,metadata) VALUES($1,$2,$3,$4)",
      [key, user, randomUUID(), JSON.stringify({ workspaceId: w[0] })]
    )
    await rejected(
      "INSERT INTO public.api_idempotency_keys(workspace_id,credential_id,operation_id,idempotency_key,request_hash,expires_at) VALUES($1,$2,'fixture',$3,$4,now()+interval '1 hour')",
      [w[1], key, randomUUID(), "a".repeat(64)]
    )
    await rejected(
      "UPDATE public.apikey SET metadata=$1 WHERE id=$2",
      [JSON.stringify({ workspaceId: w[1] }), key],
      "23514"
    )
    await pool.query(
      "INSERT INTO public.workspace_usage_periods(id,workspace_id,period_key,kind,binding,started_at,ends_at) VALUES($1,$2,$3,'free','fixture',now(),now()+interval '1 hour')",
      [period, w[0], randomUUID()]
    )
    await rejected(
      "INSERT INTO public.workspace_usage_reservations(id,workspace_id,period_id,request_id,request_hash,operation_id,run_id,provider,model_id,pricing_fingerprint,billing_mode,uses_pool,maximum_cost_usd_micros,reserved_usd_micros) VALUES($1,$2,$3,$4,$5,$6,$7,'fixture','fixture',$5,'forge-managed',true,1,1)",
      [
        randomUUID(),
        w[0],
        period,
        randomUUID(),
        "a".repeat(64),
        randomUUID(),
        run[2],
      ]
    )
  })
  it("enforces guards with the actual non-owner application role", async () => {
    const client = await appPool.connect()
    try {
      await client.query("BEGIN")
      expect(
        (await client.query("SELECT current_user AS role")).rows[0].role
      ).toBe("forge_staging_web")
      await client.query(
        "UPDATE public.issues SET title='application-role' WHERE id=$1",
        [issue[0]]
      )
      await client.query("SAVEPOINT invalid_relation")
      await expect(
        client.query("UPDATE public.issues SET project_id=$1 WHERE id=$2", [
          project[2],
          issue[0],
        ])
      ).rejects.toMatchObject({ code: "23503" })
      await client.query("ROLLBACK TO SAVEPOINT invalid_relation")
      await client.query("SAVEPOINT invalid_parent")
      await expect(
        client.query("UPDATE public.issues SET parent_id=id WHERE id=$1", [
          issue[0],
        ])
      ).rejects.toMatchObject({ code: "23514" })
      await client.query("ROLLBACK TO SAVEPOINT invalid_parent")
      await client.query("SAVEPOINT guard_lifecycle")
      await expect(
        client.query(
          "DELETE FROM public.issue_hierarchy_guards WHERE workspace_id=$1",
          [w[0]]
        )
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "issue_graph_guard_lifetime",
      })
      await client.query("ROLLBACK TO SAVEPOINT guard_lifecycle")
    } finally {
      await client.query("ROLLBACK")
      client.release()
    }
  })
  it("rejects team membership outside the workspace and cascades membership revocation", async () => {
    await rejected(
      "INSERT INTO public.team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
      [w[1], team[2], member]
    )
    await pool.query(
      "INSERT INTO public.team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
      [w[0], team[0], member]
    )
    await pool.query(
      "DELETE FROM public.member WHERE organization_id=$1 AND user_id=$2",
      [w[0], member]
    )
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM public.team_members WHERE user_id=$1",
          [member]
        )
      ).rows[0].n
    ).toBe(0)
  })
  it("keeps IDs, workspace ownership, and indirect owner paths immutable", async () => {
    const businessRuns = [randomUUID(), randomUUID()],
      effect = randomUUID()
    for (let i = 0; i < 2; i++)
      await pool.query(
        "INSERT INTO public.business_workflow_runs(id,workspace_id,kind,subject_type,subject_id,idempotency_key) VALUES($1,$2,'fixture','fixture',$3,$4)",
        [businessRuns[i], w[i], randomUUID(), randomUUID()]
      )
    await pool.query(
      "INSERT INTO public.business_workflow_effects(id,business_run_id,effect_key) VALUES($1,$2,'fixture')",
      [effect, businessRuns[0]]
    )
    await rejected(
      "UPDATE public.business_workflow_effects SET business_run_id=$1 WHERE id=$2",
      [businessRuns[1], effect],
      "23514"
    )
    await rejected(
      "UPDATE public.projects SET id=$1 WHERE id=$2",
      [randomUUID(), project[0]],
      "23514"
    )
    await rejected(
      "UPDATE public.projects SET workspace_id=$1 WHERE id=$2",
      [w[1], project[0]],
      "23514"
    )
    await rejected(
      "UPDATE public.teams SET workspace_id=$1 WHERE id=$2",
      [w[1], team[0]],
      "23514"
    )
    await rejected(
      "UPDATE public.agent_runs SET thread_id=$1 WHERE id=$2",
      [thread[2], run[0]],
      "23514"
    )
    await rejected(
      "UPDATE public.team_templates SET team_id=$1 WHERE id=$2",
      [team[0], template],
      "23514"
    )
    const doc = randomUUID()
    await pool.query(
      "INSERT INTO public.documents(id,workspace_id,title,issue_id) VALUES($1,$2,'fixture',$3)",
      [doc, w[0], issue[0]]
    )
    await rejected(
      "UPDATE public.documents SET issue_id=$1 WHERE id=$2",
      [issue[4], doc],
      "23514"
    )
  })
})

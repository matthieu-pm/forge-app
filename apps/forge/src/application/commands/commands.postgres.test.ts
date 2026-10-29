// @vitest-environment node
import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "drizzle-orm"
import {
  assertIsolatedTestConnection,
  verifyIsolatedTestIdentity,
} from "../../../scripts/lib/isolated-test-database"
import type { Actor } from "@/application/actor"
import type {
  CreateTeamInput,
  TeamSummary,
} from "@/application/teams/team-schemas"
import type * as Database from "@/db"
import type * as Commands from "./execute-command.server"
import type * as Api from "@/api/v1/idempotency.server"
import type * as Teams from "@/application/teams/teams.server"
import type * as Authorization from "@/application/teams/team-command-authorization.server"
import type { CommandOptions } from "./execute-command.server"

const file = process.env.FORGE_COMMAND_TEST_DATABASE_FILE

describe.skipIf(!file)("PostgreSQL atomic commands (FOR-32)", () => {
  const marker = `for32-${randomUUID()}`
  const workspace = marker,
    user = `${marker}-user`,
    credential = `${marker}-key`,
    session = `${marker}-session`
  const foreign = `${marker}-foreign`
  let pool: Pool,
    database: typeof Database,
    commands: typeof Commands,
    api: typeof Api,
    teams: typeof Teams,
    authorization: typeof Authorization
  let verified = false
  let sequence = 0
  const actor: Actor = {
    workspaceId: workspace,
    userId: user,
    workspaceRole: "owner",
    authentication: { kind: "apiKey", credentialId: credential },
    scopes: ["teams:read", "teams:write"],
  }
  function input(): CreateTeamInput {
    sequence++
    return {
      name: `Fixture ${sequence}`,
      identifier: `T${sequence}`,
      icon: { kind: "icon", value: "LayersIcon", color: "#94a3b8" },
      timezone: "UTC",
    }
  }
  function options(key: string, data = input()): CommandOptions<TeamSummary> {
    return {
      actor,
      commandKey: key,
      operation: "createTeam",
      input: data,
      status: 201,
      parse: (value) => value as TeamSummary,
      authorize: (...args) => authorization.authorizeTeamCreation(...args),
      run: async (tx, currentActor) => {
        const created = await teams.createTeam(currentActor, data, tx)
        if (!created.ok) throw new Error(created.code)
        return {
          value: created.team,
          resource: { type: "team", id: created.team.id },
          events: [
            { topic: "teams.created.v1", payload: { teamId: created.team.id } },
          ],
        }
      },
    }
  }
  async function counts(key: string) {
    const result = await pool.query(
      `SELECT (SELECT count(*)::int FROM command_receipts WHERE workspace_id=$1 AND command_key=$2) receipts, (SELECT count(*)::int FROM command_audit_events a JOIN command_receipts r ON r.id=a.command_id WHERE r.workspace_id=$1 AND r.command_key=$2) audit, (SELECT count(*)::int FROM command_outbox_events o JOIN command_receipts r ON r.id=o.command_id WHERE r.workspace_id=$1 AND r.command_key=$2) outbox`,
      [workspace, key]
    )
    return result.rows[0]
  }
  async function noBusiness(data: CreateTeamInput) {
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM teams WHERE workspace_id=$1 AND identifier=$2",
          [workspace, data.identifier]
        )
      ).rows[0].n
    ).toBe(0)
  }
  function worker(
    key: string,
    data: CreateTeamInput,
    other: Record<string, unknown> = {}
  ) {
    const child = spawn(
      "bun",
      [
        fileURLToPath(
          new URL(
            "../../../scripts/command-acceptance-worker.ts",
            import.meta.url
          )
        ),
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: { ...process.env, FORGE_COMMAND_TEST_DATABASE_FILE: file! },
        stdio: ["pipe", "pipe", "pipe"],
      }
    )
    let output = "",
      errors = ""
    let notify: (() => void) | undefined
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
      notify?.()
    })
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString()
    })
    const done = new Promise<{
      code: number | null
      output: string
      errors: string
    }>((resolve) =>
      child.on("close", (code) => resolve({ code, output, errors }))
    )
    child.stdin.write(
      JSON.stringify({ key, input: data, actor, ...other }) + "\n"
    )
    const mutated = () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          reject(new Error(`Worker did not reach mutation: ${errors}`))
        }, 15000)
        notify = () => {
          if (output.includes('"mutated"')) {
            clearTimeout(timer)
            resolve()
          }
        }
        notify()
      })
    return { child, done, mutated }
  }
  beforeAll(async () => {
    const { connection, applicationConnection } = JSON.parse(
      readFileSync(file!, "utf8")
    )
    const target = assertIsolatedTestConnection(connection)
    assertIsolatedTestConnection(applicationConnection)
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: connection, max: 4 })
    await verifyIsolatedTestIdentity(pool, target)
    verified = true
    vi.stubEnv("DATABASE_URL", applicationConnection)
    database = await import("@/db")
    commands = await import("./execute-command.server")
    api = await import("@/api/v1/idempotency.server")
    teams = await import("@/application/teams/teams.server")
    authorization =
      await import("@/application/teams/team-command-authorization.server")
    for (const id of [workspace, foreign])
      await pool.query(
        "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
        [id]
      )
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
      [user, `${user}@example.test`]
    )
    await pool.query(
      "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
      [randomUUID(), workspace, user]
    )
    await pool.query(
      "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'business','active')",
      [workspace]
    )
    await pool.query(
      "INSERT INTO workspace_security_settings(workspace_id) VALUES($1)",
      [workspace]
    )
    await pool.query(
      "INSERT INTO apikey(id,config_id,reference_id,key,permissions,metadata) VALUES($1,'forge-api',$2,$3,$4,$5)",
      [
        credential,
        user,
        randomUUID(),
        JSON.stringify({ teams: ["read", "write"] }),
        JSON.stringify({ workspaceId: workspace }),
      ]
    )
    await pool.query(
      "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
      [session, randomUUID(), user, workspace]
    )
  }, 30000)
  afterAll(async () => {
    try {
      if (verified) {
        await pool.query("DELETE FROM organization WHERE id=ANY($1::text[])", [
          [workspace, foreign],
        ])
        await pool.query('DELETE FROM "user" WHERE id=$1', [user])
        expect(
          (
            await pool.query(
              "SELECT count(*)::int n FROM command_receipts WHERE workspace_id=$1",
              [workspace]
            )
          ).rows[0].n
        ).toBe(0)
      }
    } finally {
      await database?.databaseClient.end()
      await pool?.end()
      vi.unstubAllEnvs()
    }
  })
  it("AT-01: resolves a lost response to one object, history and event", async () => {
    const o = options("lost-response")
    const first = await commands.executeCommand(o)
    const replay = await commands.executeCommand({
      ...o,
      run: async () => {
        throw new Error("must not execute")
      },
    })
    expect(replay).toEqual({ replayed: true, value: first.value })
    expect(await counts(o.commandKey)).toEqual({
      receipts: 1,
      audit: 1,
      outbox: 1,
    })
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM team_members WHERE team_id=$1",
          [first.value.id]
        )
      ).rows[0].n
    ).toBe(1)
  })
  it("AT-02: rejects changed input without a second mutation", async () => {
    const o = options("conflict")
    await commands.executeCommand(o)
    await expect(
      commands.executeCommand({ ...o, input: { name: "different" } })
    ).rejects.toMatchObject({ reason: "reused" })
    expect(await counts(o.commandKey)).toEqual({
      receipts: 1,
      audit: 1,
      outbox: 1,
    })
  })
  it.each(["before-mutation", "after-mutation", "outbox-write", "commit"])(
    "AT-03: rolls back %s then safely retries",
    async (phase) => {
      const data = input(),
        key = `fault-${phase}`,
        o = options(key, data)
      await expect(
        commands.executeCommand({
          ...o,
          run: async (tx, current) => {
            if (phase === "before-mutation") throw new Error("fixture")
            const result = await o.run(tx, current)
            if (phase === "after-mutation") throw new Error("fixture")
            if (phase === "outbox-write")
              result.events[0].payload = { invalid: 1n } as unknown as Record<
                string,
                unknown
              >
            if (phase === "commit")
              await tx.execute(
                sql`INSERT INTO command_receipts(workspace_id,user_id,principal,operation,command_key,input_hash) VALUES(${workspace},${user},'fixture','fixture',${randomUUID()},${"a".repeat(64)})`
              )
            return result
          },
        })
      ).rejects.toThrow()
      expect(await counts(key)).toEqual({ receipts: 0, audit: 0, outbox: 0 })
      await noBusiness(data)
      expect((await commands.executeCommand(o)).replayed).toBe(false)
      expect(await counts(key)).toEqual({ receipts: 1, audit: 1, outbox: 1 })
    }
  )
  it("AT-03: independent processes wait for one commit and replay its result", async () => {
    const key = "process-race",
      data = input()
    const first = worker(key, data, { pause: true })
    await first.mutated()
    const second = worker(key, data)
    try {
      // Observe the real PostgreSQL transaction/index wait, not just a JS race.
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT count(*)::int n FROM pg_stat_activity WHERE usename='forge_staging_web' AND wait_event_type='Lock' AND query LIKE '%command_receipts%'"
              )
            ).rows[0].n,
          { timeout: 12000, interval: 100 }
        )
        .toBeGreaterThan(0)
      first.child.stdin.write("continue\n")
      const results = await Promise.all([first.done, second.done])
      for (const r of results) expect(r.code, r.errors).toBe(0)
      const parsed = results.map((r) =>
        JSON.parse(r.output.trim().split("\n").at(-1)!)
      )
      expect(parsed[0].replayed).toBe(false)
      expect(parsed[1]).toMatchObject({
        replayed: true,
        value: parsed[0].value,
      })
      expect(await counts(key)).toEqual({ receipts: 1, audit: 1, outbox: 1 })
    } finally {
      first.child.kill()
      second.child.kill()
    }
  }, 30000)
  it("AT-03: a killed owner rolls back and its waiting process performs the command", async () => {
    const key = "process-kill",
      data = input()
    const first = worker(key, data, { pause: true })
    await first.mutated()
    const second = worker(key, data)
    try {
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT count(*)::int n FROM pg_stat_activity WHERE usename='forge_staging_web' AND wait_event_type='Lock' AND query LIKE '%command_receipts%'"
              )
            ).rows[0].n,
          { timeout: 12000, interval: 100 }
        )
        .toBeGreaterThan(0)
      first.child.kill("SIGKILL")
      const result = await second.done
      expect(result.code, result.errors).toBe(0)
      expect(
        JSON.parse(
          result.output
            .trim()
            .split("\n")
            .find((line) => line.includes('"phase":"result"'))!
        )
      ).toMatchObject({
        replayed: false,
      })
      expect(await counts(key)).toEqual({ receipts: 1, audit: 1, outbox: 1 })
    } finally {
      first.child.kill()
      second.child.kill()
    }
  }, 30000)
  it("serializes membership revocation with an in-flight command and denies its replay", async () => {
    const key = "inflight-revoke",
      data = input(),
      first = worker(key, data, { pause: true })
    await first.mutated()
    const revoker = await pool.connect()
    let revocation: Promise<unknown> | undefined
    try {
      revocation = revoker.query(
        "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
        [workspace, user]
      )
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'DELETE FROM member%' "
              )
            ).rows[0].n,
          { timeout: 10000, interval: 100 }
        )
        .toBeGreaterThan(0)
      first.child.stdin.write("continue\n")
      const committed = await first.done
      expect(committed.code, committed.errors).toBe(0)
      await revocation
      const retry = await worker(key, data).done
      expect(retry.code).toBe(2)
      expect(await counts(key)).toEqual({ receipts: 1, audit: 1, outbox: 1 })
    } finally {
      first.child.kill("SIGKILL")
      await revocation
      revoker.release()
      await pool.query(
        "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner') ON CONFLICT DO NOTHING",
        [randomUUID(), workspace, user]
      )
    }
  }, 30000)
  it("AT-03: process response loss after commit replays one durable result", async () => {
    const key = "process-response-loss",
      data = input()
    const lost = await worker(key, data, { fault: "after-commit" }).done
    expect(lost.code, lost.errors).toBe(2)
    const retry = await worker(key, data).done
    expect(retry.code, retry.errors).toBe(0)
    expect(
      JSON.parse(
        retry.output
          .trim()
          .split("\n")
          .find((line) => line.includes('"phase":"result"'))!
      )
    ).toMatchObject({ replayed: true })
    expect(await counts(key)).toEqual({ receipts: 1, audit: 1, outbox: 1 })
  }, 30000)
  it("AT-04: replay rejects current private-team access loss and stale roles", async () => {
    const o = options("private-revoke"),
      first = await commands.executeCommand(o)
    await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
      first.value.id,
    ])
    await pool.query(
      "UPDATE workspace_security_settings SET team_creation_policy='all-members' WHERE workspace_id=$1",
      [workspace]
    )
    await pool.query(
      "UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2",
      [workspace, user]
    )
    await pool.query(
      "DELETE FROM team_members WHERE team_id=$1 AND user_id=$2",
      [first.value.id, user]
    )
    try {
      await expect(commands.executeCommand(o)).rejects.toMatchObject({
        code: "FORBIDDEN",
      })
    } finally {
      await pool.query(
        "UPDATE member SET role='owner' WHERE organization_id=$1 AND user_id=$2",
        [workspace, user]
      )
    }
    expect(await counts(o.commandKey)).toEqual({
      receipts: 1,
      audit: 1,
      outbox: 1,
    })
  })
  it.each(["membership", "disabled-key", "expired-key", "scope"])(
    "AT-04: rejects replay after %s revocation",
    async (kind) => {
      const o = options(`revoked-${kind}`)
      await commands.executeCommand(o)
      if (kind === "membership")
        await pool.query(
          "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
          [workspace, user]
        )
      if (kind === "disabled-key")
        await pool.query("UPDATE apikey SET enabled=false WHERE id=$1", [
          credential,
        ])
      if (kind === "expired-key")
        await pool.query(
          "UPDATE apikey SET expires_at=now()-interval '1 second' WHERE id=$1",
          [credential]
        )
      if (kind === "scope")
        await pool.query("UPDATE apikey SET permissions='{}' WHERE id=$1", [
          credential,
        ])
      try {
        await expect(commands.executeCommand(o)).rejects.toMatchObject({
          code: "FORBIDDEN",
        })
      } finally {
        if (kind === "membership")
          await pool.query(
            "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
            [randomUUID(), workspace, user]
          )
        await pool.query(
          "UPDATE apikey SET enabled=true,expires_at=null,permissions=$2 WHERE id=$1",
          [credential, JSON.stringify({ teams: ["read", "write"] })]
        )
      }
      expect(await counts(o.commandKey)).toEqual({
        receipts: 1,
        audit: 1,
        outbox: 1,
      })
    }
  )
  it("checks current session authority and prevents forged workspace selection", async () => {
    const o = {
      ...options("session"),
      actor: {
        ...actor,
        authentication: { kind: "session" as const, sessionId: session },
        scopes: null,
      },
    }
    await commands.executeCommand(o)
    await pool.query(
      "UPDATE session SET expires_at=now()-interval '1 second' WHERE id=$1",
      [session]
    )
    await expect(commands.executeCommand(o)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(
      commands.executeCommand({
        ...options("forged"),
        actor: { ...actor, workspaceId: foreign },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
  it.each([false, true])(
    "preserves expired legacy receipt (completed=%s)",
    async (completed) => {
      const data = input(),
        key = `legacy-${completed}`,
        o = options(key, data)
      const original = completed
        ? (await commands.executeCommand({ ...o, commandKey: `seed-${key}` }))
            .value
        : null
      await pool.query(
        "INSERT INTO api_idempotency_keys(workspace_id,credential_id,operation_id,idempotency_key,request_hash,expires_at,response_status,response_body) VALUES($1,$2,'createTeam',$3,$4,now()-interval '1 day',$5,$6)",
        [
          workspace,
          credential,
          key,
          createHash("sha256").update(JSON.stringify(data)).digest("hex"),
          completed ? 201 : null,
          original ? JSON.stringify(original) : null,
        ]
      )
      const execute = () =>
        api.executeIdempotent({
          ...o,
          operationId: o.operation,
          idempotencyKey: key,
        })
      if (completed)
        expect(await execute()).toEqual({ replayed: true, value: original })
      else {
        await expect(execute()).rejects.toMatchObject({ reason: "ambiguous" })
        await noBusiness(data)
      }
      expect(await counts(key)).toEqual({ receipts: 0, audit: 0, outbox: 0 })
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM api_idempotency_keys WHERE credential_id=$1 AND idempotency_key=$2",
            [credential, key]
          )
        ).rows[0].n
      ).toBe(1)
    }
  )
  it("retains a tombstone after result redaction and rejects duplicate effects", async () => {
    const o = options("redacted")
    await commands.executeCommand(o)
    await pool.query(
      "UPDATE command_receipts SET response_body=null WHERE workspace_id=$1 AND command_key=$2",
      [workspace, o.commandKey]
    )
    await expect(commands.executeCommand(o)).rejects.toMatchObject({
      reason: "result-unavailable",
    })
    await expect(
      pool.query(
        "DELETE FROM command_receipts WHERE workspace_id=$1 AND command_key=$2",
        [workspace, o.commandKey]
      )
    ).rejects.toMatchObject({ constraint: "command_receipt_lifetime" })
    expect(await counts(o.commandKey)).toEqual({
      receipts: 1,
      audit: 1,
      outbox: 1,
    })
  })
  it("rejects partial commits, cross-workspace history and rewritten command identities", async () => {
    await expect(
      pool.query(
        "INSERT INTO command_receipts(workspace_id,user_id,principal,operation,command_key,input_hash) VALUES($1,$2,'fixture','fixture','incomplete',$3)",
        [workspace, user, "a".repeat(64)]
      )
    ).rejects.toMatchObject({ constraint: "command_atomic_completion" })
    const o = options("immutable"),
      result = await commands.executeCommand(o)
    await expect(
      pool.query(
        "UPDATE command_receipts SET input_hash=$3 WHERE workspace_id=$1 AND command_key=$2",
        [workspace, o.commandKey, "b".repeat(64)]
      )
    ).rejects.toMatchObject({ constraint: "forge_immutable_identity" })
    await expect(
      pool.query(
        "UPDATE command_receipts SET response_body='{}' WHERE workspace_id=$1 AND command_key=$2",
        [workspace, o.commandKey]
      )
    ).rejects.toMatchObject({ constraint: "command_receipt_terminal" })
    const r = await pool.query(
      "SELECT id FROM command_receipts WHERE workspace_id=$1 AND command_key=$2",
      [workspace, o.commandKey]
    )
    await expect(
      pool.query(
        "INSERT INTO command_outbox_events(workspace_id,command_id,ordinal,topic,payload) VALUES($1,$2,2,'fixture','{}')",
        [foreign, r.rows[0].id]
      )
    ).rejects.toMatchObject({ code: "23503" })
    expect(result.replayed).toBe(false)
  })
  it.each(["after-approval", "commit"])(
    "agent approval, mutation and evidence roll back together at %s",
    async (phase) => {
      const { executeCapabilityCommand, consumeCapabilityCommandApproval } =
        await import("@/adapters/agents/drizzle-capability-command.server")
      const { hashApprovalInput } =
        await import("@/application/agents/approval-service.server")
      const team = await commands.executeCommand(options(`agent-seed-${phase}`))
      const thread = randomUUID(),
        run = randomUUID(),
        approval = randomUUID(),
        key = `agent-${phase}`
      await pool.query(
        "INSERT INTO agent_threads(id,workspace_id,created_by_user_id) VALUES($1,$2,$3)",
        [thread, workspace, user]
      )
      await pool.query(
        "INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,execution_kind,requested_selection,state) VALUES($1,$2,$3,'forge-native','{}','running')",
        [run, thread, user]
      )
      const invocation = {
        capabilityId: "teams.update",
        capabilityVersion: "1",
        idempotencyKey: key,
        approvalId: approval,
        input: {
          slug: team.value.slug,
          settings: { description: "accepted command" },
        },
      }
      await pool.query(
        "INSERT INTO agent_approvals(id,workspace_id,run_id,requested_for_user_id,capability_id,risk,input_hash,redacted_input_summary,nonce,expires_at,state) VALUES($1,$2,$3,$4,'teams.update','reversible-write',$5,'{}',$6,now()+interval '1 hour','approved')",
        [
          approval,
          workspace,
          run,
          user,
          hashApprovalInput(invocation.input),
          randomUUID(),
        ]
      )
      const agent: Actor = {
        ...actor,
        authentication: { kind: "agent", runId: run, tokenId: randomUUID() },
        scopes: ["teams:read", "teams:write"],
      }
      const result = await executeCapabilityCommand(
        agent,
        invocation,
        { runId: run },
        async (...args) => {
          await consumeCapabilityCommandApproval(...args)
          if (phase === "after-approval")
            throw new Error("fixture after approval")
          await args[0].execute(
            sql`INSERT INTO command_receipts(workspace_id,user_id,principal,operation,command_key,input_hash) VALUES(${workspace},${user},'fixture','fixture',${randomUUID()},${"a".repeat(64)})`
          )
        }
      )
      expect(result.ok).toBe(false)
      expect(
        (
          await pool.query("SELECT state FROM agent_approvals WHERE id=$1", [
            approval,
          ])
        ).rows[0].state
      ).toBe("approved")
      expect(
        (
          await pool.query("SELECT description FROM teams WHERE id=$1", [
            team.value.id,
          ])
        ).rows[0].description
      ).toBe(team.value.description)
      expect(await counts(key)).toEqual({ receipts: 0, audit: 0, outbox: 0 })
      const success = await executeCapabilityCommand(
        agent,
        invocation,
        { runId: run },
        consumeCapabilityCommandApproval
      )
      expect(success.ok).toBe(true)
      expect(
        (
          await pool.query("SELECT state FROM agent_approvals WHERE id=$1", [
            approval,
          ])
        ).rows[0].state
      ).toBe("consumed")
      expect(
        await executeCapabilityCommand(
          agent,
          invocation,
          { runId: run },
          () => {
            throw new Error("must not consume again")
          }
        )
      ).toEqual(success)
      expect(await counts(key)).toEqual({ receipts: 1, audit: 1, outbox: 1 })
      const changed = await executeCapabilityCommand(
        agent,
        {
          ...invocation,
          input: { ...invocation.input, settings: { description: "changed" } },
        },
        { runId: run },
        consumeCapabilityCommandApproval
      )
      expect(changed).toMatchObject({
        ok: false,
        errorCode: "IDEMPOTENCY_KEY_CONFLICT",
      })
      await pool.query("UPDATE agent_runs SET state='cancelled' WHERE id=$1", [
        run,
      ])
      expect(
        await executeCapabilityCommand(
          agent,
          invocation,
          { runId: run },
          consumeCapabilityCommandApproval
        )
      ).toMatchObject({ ok: false, errorCode: "FORBIDDEN" })
    }
  )
  it.each([false, true])(
    "preserves expired legacy agent receipt (completed=%s)",
    async (completed) => {
      const { executeCapabilityCommand, consumeCapabilityCommandApproval } =
        await import("@/adapters/agents/drizzle-capability-command.server")
      const { hashApprovalInput } =
        await import("@/application/agents/approval-service.server")
      const seed = await commands.executeCommand(
        options(`legacy-agent-seed-${completed}`)
      )
      const thread = randomUUID(),
        run = randomUUID(),
        approval = randomUUID(),
        key = `legacy-agent-${completed}`
      await pool.query(
        "INSERT INTO agent_threads(id,workspace_id,created_by_user_id) VALUES($1,$2,$3)",
        [thread, workspace, user]
      )
      await pool.query(
        "INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,execution_kind,requested_selection,state) VALUES($1,$2,$3,'forge-native','{}','running')",
        [run, thread, user]
      )
      const invocation = {
        capabilityId: "teams.update",
        capabilityVersion: "1",
        idempotencyKey: key,
        approvalId: approval,
        input: {
          slug: seed.value.slug,
          settings: { description: "legacy change" },
        },
      }
      const hash = hashApprovalInput(invocation.input)
      await pool.query(
        "INSERT INTO agent_approvals(id,workspace_id,run_id,requested_for_user_id,capability_id,risk,input_hash,redacted_input_summary,nonce,expires_at,state) VALUES($1,$2,$3,$4,'teams.update','reversible-write',$5,'{}',$6,now()-interval '1 day','consumed')",
        [approval, workspace, run, user, hash, randomUUID()]
      )
      await pool.query(
        "INSERT INTO agent_capability_invocations(workspace_id,user_id,run_id,approval_id,capability_id,capability_version,idempotency_key,input_hash,state,outcome,result_json,expires_at) VALUES($1,$2,$3,$4,'teams.update','1',$5,$6,$7,$8,$9,now()-interval '1 day')",
        [
          workspace,
          user,
          run,
          approval,
          key,
          hash,
          completed ? "completed" : "in-progress",
          completed ? "succeeded" : null,
          completed ? JSON.stringify({ ok: true, value: seed.value }) : null,
        ]
      )
      const agent: Actor = {
        ...actor,
        authentication: { kind: "agent", runId: run, tokenId: randomUUID() },
        scopes: ["teams:read", "teams:write"],
      }
      const result = await executeCapabilityCommand(
        agent,
        invocation,
        { runId: run },
        consumeCapabilityCommandApproval
      )
      expect(result).toMatchObject(
        completed
          ? { ok: true, value: seed.value }
          : { ok: false, errorCode: "IDEMPOTENCY_RECONCILIATION_REQUIRED" }
      )
      expect(await counts(key)).toEqual({ receipts: 0, audit: 0, outbox: 0 })
      expect(
        (
          await pool.query("SELECT description FROM teams WHERE id=$1", [
            seed.value.id,
          ])
        ).rows[0].description
      ).toBe(seed.value.description)
    }
  )
})

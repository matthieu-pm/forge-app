// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import type { RecoveryEvent } from "@/application/recovery/journal"
import type { Actor } from "@/application/actor"
import type {
  DefinitionCommand,
  DefinitionSnapshot,
} from "@/lib/issue-definition-contract"
import type * as Service from "./definitions.server"
import type * as Classification from "./classification.server"
import type * as Database from "@/db"

const file = process.env.FORGE_DEFINITION_TEST_DATABASE_FILE

describe.skipIf(!file)("FOR-40 real PostgreSQL acceptance", () => {
  const marker = `for40-${randomUUID()}`,
    workspace = marker,
    otherWorkspace = `${marker}-other`,
    admin = `${marker}-admin`,
    member = `${marker}-member`,
    outsider = `${marker}-outsider`
  const sessions = {
    admin: `${marker}-a`,
    member: `${marker}-m`,
    outsider: `${marker}-o`,
  }
  let pool: Pool,
    service: typeof Service,
    classification: typeof Classification,
    database: typeof Database,
    verified = false
  const actor = (role: "admin" | "member" | "outsider" = "admin"): Actor => ({
    userId: { admin, member, outsider }[role],
    workspaceId: role === "outsider" ? otherWorkspace : workspace,
    workspaceRole: "owner",
    authentication: { kind: "session", sessionId: sessions[role] },
    scopes: null,
  })
  async function team(visibility = "workspace", workspaceId = workspace) {
    const id = randomUUID()
    await pool.query(
      "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,$3,$3,$4,$5,'emoji','🔥','#94a3b8','Europe/Paris',$6)",
      [
        id,
        workspaceId,
        `${marker}-${id}`,
        id.slice(0, 5).toUpperCase(),
        visibility,
        admin,
      ]
    )
    return id
  }
  async function issue(teamId: string, statusId = "backlog") {
    const id = randomUUID()
    await pool.query(
      "INSERT INTO issues(id,workspace_id,team_id,number,title,status_id) VALUES($1,$2,$3,1,'Acceptance issue',$4)",
      [id, workspace, teamId, statusId]
    )
    return id
  }
  const label = (name: string) => ({
    id: randomUUID(),
    name,
    description: "",
    color: "#5e6ad2",
    groupId: null,
    issues: 0,
    lastApplied: null,
    createdAt: new Date().toISOString(),
  })
  const command = (
    snapshot: DefinitionSnapshot,
    value = snapshot.value
  ): DefinitionCommand => ({
    workspaceId: workspace,
    sessionId: sessions.admin,
    teamId: snapshot.teamId,
    commandKey: randomUUID(),
    expectedRevision: snapshot.revision,
    value: structuredClone(value),
    statusReplacements: {},
    labelReplacements: {},
  })
  async function ready(teamId: string) {
    const snapshot = await service.readIssueDefinitions(actor(), teamId),
      value = structuredClone(snapshot.value)
    value.statuses.statuses.push({
      id: "ready",
      name: "Ready",
      group: "unstarted",
      description: "",
      color: "#5e6ad2",
    })
    return service.saveIssueDefinitions(actor(), command(snapshot, value))
  }
  beforeAll(async () => {
    const { connection, applicationConnection } = JSON.parse(
        readFileSync(file!, "utf8")
      ),
      target = {
        environment: "issue-definition-acceptance" as const,
        ...DATABASE_TARGETS["issue-definition-acceptance"],
      }
    assertMigrationTarget(connection, target)
    assertMigrationTarget(applicationConnection, target)
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: connection, max: 5 })
    const identity = (
      await pool.query(
        "SELECT current_database() database,current_setting('neon.branch_id',true) branch"
      )
    ).rows[0]
    if (
      identity.database !== target.database ||
      identity.branch !== target.branchId
    )
      throw new Error("Acceptance database identity mismatch")
    verified = true
    vi.stubEnv("DATABASE_URL", applicationConnection)
    vi.stubEnv("FORGE_SERVICE_ENVIRONMENT", "development")
    database = await import("@/db")
    service = await import("./definitions.server")
    classification = await import("./classification.server")
    for (const id of [workspace, otherWorkspace])
      await pool.query(
        "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
        [id]
      )
    for (const id of [workspace, otherWorkspace])
      await pool.query(
        "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'enterprise','active')",
        [id]
      )
    for (const [role, userId] of Object.entries({ admin, member, outsider })) {
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [userId, `${userId}@example.test`]
      )
      const workspaceId = role === "outsider" ? otherWorkspace : workspace
      await pool.query(
        "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)",
        [
          randomUUID(),
          userId,
          workspaceId,
          role === "admin" ? "admin" : "member",
        ]
      )
      await pool.query(
        "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
        [sessions[role as keyof typeof sessions], userId, workspaceId]
      )
    }
  }, 30000)
  afterAll(async () => {
    if (verified) {
      await pool.query(
        "DROP TRIGGER IF EXISTS for40_reject_audit ON command_audit_events"
      )
      await pool.query("DROP FUNCTION IF EXISTS for40_reject_audit()")
      await pool.query("DELETE FROM organization WHERE id=ANY($1)", [
        [workspace, otherWorkspace],
      ])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [
        [admin, member, outsider],
      ])
      expect(
        (
          await pool.query(
            "SELECT (SELECT count(*)::int FROM issue_statuses WHERE workspace_id=$1) statuses,(SELECT count(*)::int FROM issue_definition_scopes WHERE workspace_id=$1) scopes,(SELECT count(*)::int FROM command_receipts WHERE workspace_id=$1) receipts",
            [workspace]
          )
        ).rows[0]
      ).toEqual({ statuses: 0, scopes: 0, receipts: 0 })
    }
    await database?.databaseClient.end()
    await pool?.end()
    vi.unstubAllEnvs()
  })
  it("AT-01: two users reload identical Ready and Mobile definitions", async () => {
    const id = await team()
    let snapshot = await ready(id)
    const value = structuredClone(snapshot.value)
    value.labels.labels.push(label("Mobile"))
    snapshot = await service.saveIssueDefinitions(
      actor(),
      command(snapshot, value)
    )
    const second = await service.readIssueDefinitions(actor("member"), id)
    expect(second.value).toEqual(snapshot.value)
    expect(second.revision).toBe(2)
    expect(second.canManage).toBe(false)
    expect(
      (await service.readAllIssueDefinitions(actor("member"))).snapshots.find(
        (s) => s.teamId === id
      )?.value
    ).toEqual(snapshot.value)
  })
  it("AT-02: referenced status deletion rejects without replacement and rolls back", async () => {
    const id = await team(),
      snapshot = await ready(id),
      issueId = await issue(id, "ready"),
      value = structuredClone(snapshot.value)
    value.statuses.statuses = value.statuses.statuses.filter(
      (s) => s.id !== "ready"
    )
    const input = command(snapshot, value)
    await expect(service.saveIssueDefinitions(actor(), input)).rejects.toThrow(
      "assigned to issues"
    )
    expect(await service.readIssueDefinitions(actor(), id)).toEqual(snapshot)
    expect(
      (await pool.query("SELECT status_id FROM issues WHERE id=$1", [issueId]))
        .rows[0].status_id
    ).toBe("ready")
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE command_key=$1",
          [input.commandKey]
        )
      ).rows[0].n
    ).toBe(0)
  })
  it("explicit status replacement migrates assignments atomically", async () => {
    const id = await team(),
      snapshot = await ready(id),
      issueId = await issue(id, "ready"),
      value = structuredClone(snapshot.value)
    value.statuses.statuses = value.statuses.statuses.filter(
      (s) => s.id !== "ready"
    )
    const saved = await service.saveIssueDefinitions(actor(), {
      ...command(snapshot, value),
      statusReplacements: { ready: "todo" },
    })
    expect(saved.value.statuses.statuses.some((s) => s.id === "ready")).toBe(
      false
    )
    expect(
      (await pool.query("SELECT status_id FROM issues WHERE id=$1", [issueId]))
        .rows[0].status_id
    ).toBe("todo")
  })
  it("referenced labels require replacement and merging deduplicates assignments", async () => {
    const id = await team(),
      issueId = await issue(id),
      base = await service.readIssueDefinitions(actor(), id),
      a = label("Mobile"),
      b = label("Platform"),
      value = structuredClone(base.value)
    value.labels.labels = [a, b]
    const snapshot = await service.saveIssueDefinitions(
      actor(),
      command(base, value)
    )
    await pool.query(
      "INSERT INTO issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3),($1,$2,$4)",
      [workspace, issueId, a.id, b.id]
    )
    const next = structuredClone(snapshot.value)
    next.labels.labels = [b]
    await expect(
      service.saveIssueDefinitions(actor(), command(snapshot, next))
    ).rejects.toThrow("assigned to issues")
    await service.saveIssueDefinitions(actor(), {
      ...command(snapshot, next),
      labelReplacements: { [a.id]: b.id },
    })
    expect(
      (
        await pool.query(
          "SELECT label_id FROM issue_labels WHERE issue_id=$1",
          [issueId]
        )
      ).rows
    ).toEqual([{ label_id: b.id }])
  })
  it("rejects member writes despite a forged admin Actor role", async () => {
    const id = await team(),
      snapshot = await service.readIssueDefinitions(actor(), id)
    await expect(
      service.saveIssueDefinitions(actor("member"), {
        ...command(snapshot),
        sessionId: sessions.member,
      })
    ).rejects.toThrow("Only workspace")
  })
  it("checks workspace, session and resource scopes", async () => {
    const id = await team(),
      snapshot = await service.readIssueDefinitions(actor(), id)
    await expect(
      service.saveIssueDefinitions(actor(), {
        ...command(snapshot),
        workspaceId: otherWorkspace,
      })
    ).rejects.toThrow("permission")
    await expect(
      service.saveIssueDefinitions(actor(), {
        ...command(snapshot),
        sessionId: sessions.member,
      })
    ).rejects.toThrow("permission")
    await expect(
      service.saveIssueDefinitions(
        { ...actor(), scopes: ["issues:read"] },
        command(snapshot)
      )
    ).rejects.toThrow("cannot issues write")
    await expect(
      service.readIssueDefinitions({ ...actor(), scopes: ["teams:read"] }, id)
    ).rejects.toThrow("cannot issues read")
  })
  it("filters private teams and cross-workspace lookup", async () => {
    const privateTeam = await team("private"),
      otherTeam = await team("workspace", otherWorkspace)
    await expect(
      service.readIssueDefinitions(actor("member"), privateTeam)
    ).rejects.toThrow("permission")
    await expect(
      service.readIssueDefinitions(actor(), otherTeam)
    ).rejects.toThrow("permission")
    expect(
      (await service.readAllIssueDefinitions(actor("member"))).snapshots.some(
        (s) => s.teamId === privateTeam || s.teamId === otherTeam
      )
    ).toBe(false)
    expect(
      (await service.readIssueDefinitions(actor(), privateTeam)).canManage
    ).toBe(true)
  })
  it("concurrent edits produce one revision conflict without a lost update", async () => {
    const id = await team(),
      snapshot = await service.readIssueDefinitions(actor(), id),
      first = structuredClone(snapshot.value),
      second = structuredClone(snapshot.value)
    first.statuses.statuses.push({
      id: "ready-a",
      name: "Ready A",
      group: "unstarted",
      color: "#5e6ad2",
      description: "",
    })
    second.statuses.statuses.push({
      id: "ready-b",
      name: "Ready B",
      group: "unstarted",
      color: "#5e6ad2",
      description: "",
    })
    const results = await Promise.allSettled([
      service.saveIssueDefinitions(actor(), command(snapshot, first)),
      service.saveIssueDefinitions(actor(), command(snapshot, second)),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
    expect((await service.readIssueDefinitions(actor(), id)).revision).toBe(1)
  })
  it("replays one durable receipt and rejects changed input under the same key", async () => {
    const id = await team(),
      snapshot = await service.readIssueDefinitions(actor(), id),
      input = command(snapshot),
      first = await service.saveIssueDefinitions(actor(), input)
    expect(await service.saveIssueDefinitions(actor(), input)).toEqual(first)
    const changed = structuredClone(input)
    changed.value.workflows.closeParents = true
    await expect(
      service.saveIssueDefinitions(actor(), changed)
    ).rejects.toThrow("different input")
    const receipts = (
      await pool.query(
        "SELECT r.id,(SELECT count(*)::int FROM command_audit_events a WHERE a.command_id=r.id) audits FROM command_receipts r WHERE command_key=$1",
        [input.commandKey]
      )
    ).rows
    expect(receipts).toHaveLength(1)
    expect(receipts[0].audits).toBe(1)
  })
  it("denies receipt replay after live admin revocation", async () => {
    const id = await team(),
      snapshot = await service.readIssueDefinitions(actor(), id),
      input = command(snapshot)
    await service.saveIssueDefinitions(actor(), input)
    await pool.query(
      "UPDATE member SET role='member' WHERE user_id=$1 AND organization_id=$2",
      [admin, workspace]
    )
    try {
      await expect(
        service.saveIssueDefinitions(actor(), input)
      ).rejects.toThrow("Only workspace")
    } finally {
      await pool.query(
        "UPDATE member SET role='admin' WHERE user_id=$1 AND organization_id=$2",
        [admin, workspace]
      )
    }
    expect((await service.readIssueDefinitions(actor(), id)).revision).toBe(1)
  })
  it("an audit failure rolls back definitions, assignment migration and receipt", async () => {
    const id = await team(),
      snapshot = await ready(id),
      issueId = await issue(id, "ready"),
      value = structuredClone(snapshot.value)
    await pool.query(
      "CREATE FUNCTION for40_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'acceptance rollback'; END $$"
    )
    await pool.query(
      "CREATE TRIGGER for40_reject_audit BEFORE INSERT ON command_audit_events FOR EACH ROW EXECUTE FUNCTION for40_reject_audit()"
    )
    value.statuses.statuses = value.statuses.statuses.filter(
      (s) => s.id !== "ready"
    )
    const input = {
      ...command(snapshot, value),
      statusReplacements: { ready: "todo" },
    }
    try {
      await expect(
        service.saveIssueDefinitions(actor(), input)
      ).rejects.toThrow()
    } finally {
      await pool.query(
        "DROP TRIGGER for40_reject_audit ON command_audit_events"
      )
      await pool.query("DROP FUNCTION for40_reject_audit()")
    }
    expect(await service.readIssueDefinitions(actor(), id)).toEqual(snapshot)
    expect(
      (await pool.query("SELECT status_id FROM issues WHERE id=$1", [issueId]))
        .rows[0].status_id
    ).toBe("ready")
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM command_receipts WHERE command_key=$1",
          [input.commandKey]
        )
      ).rows[0].n
    ).toBe(0)
  })
  it("enforces transitions through the canonical command and direct database guard", async () => {
    const id = await team(),
      issueId = await issue(id, "todo"),
      snapshot = await service.readIssueDefinitions(actor(), id),
      value = structuredClone(snapshot.value)
    value.transitions = { todo: ["in-progress"] }
    await service.saveIssueDefinitions(actor(), command(snapshot, value))
    await expect(
      classification.setCanonicalIssueClassification(actor("member"), {
        issueId,
        commandKey: randomUUID(),
        expectedStatusId: "todo",
        statusId: "done",
        labelIds: [],
      })
    ).rejects.toThrow("not allowed")
    await expect(
      pool.query("UPDATE issues SET status_id='done' WHERE id=$1", [issueId])
    ).rejects.toMatchObject({ constraint: "issues_allowed_transition" })
    const accepted = {
      issueId,
      commandKey: randomUUID(),
      expectedStatusId: "todo",
      statusId: "in-progress",
      labelIds: [],
    }
    expect(
      (
        await classification.setCanonicalIssueClassification(
          actor("member"),
          accepted
        )
      ).replayed
    ).toBe(false)
    expect(
      (
        await classification.setCanonicalIssueClassification(
          actor("member"),
          accepted
        )
      ).replayed
    ).toBe(true)
  })
  it("retains archived assignments but refuses new archived and other-team labels", async () => {
    const id = await team(),
      issueId = await issue(id),
      other = await team(),
      otherIssue = await issue(other),
      snapshot = await service.readIssueDefinitions(actor(), id),
      value = structuredClone(snapshot.value),
      a = label("Mobile")
    value.labels.labels = [a]
    let saved = await service.saveIssueDefinitions(
      actor(),
      command(snapshot, value)
    )
    await classification.setCanonicalIssueClassification(actor(), {
      issueId,
      commandKey: randomUUID(),
      expectedStatusId: "backlog",
      statusId: "todo",
      labelIds: [a.id],
    })
    saved.value.labels.labels[0].archived = true
    saved = await service.saveIssueDefinitions(actor(), command(saved))
    await classification.setCanonicalIssueClassification(actor(), {
      issueId,
      commandKey: randomUUID(),
      expectedStatusId: "todo",
      statusId: "in-progress",
      labelIds: [a.id],
    })
    await expect(
      classification.setCanonicalIssueClassification(actor(), {
        issueId: otherIssue,
        commandKey: randomUUID(),
        expectedStatusId: "backlog",
        statusId: "todo",
        labelIds: [a.id],
      })
    ).rejects.toThrow("active labels")
    await classification.setCanonicalIssueClassification(actor(), {
      issueId,
      commandKey: randomUUID(),
      expectedStatusId: "in-progress",
      statusId: "in-progress",
      labelIds: [],
    })
    await expect(
      classification.setCanonicalIssueClassification(actor(), {
        issueId,
        commandKey: randomUUID(),
        expectedStatusId: "in-progress",
        statusId: "in-progress",
        labelIds: [a.id],
      })
    ).rejects.toThrow("active labels")
  })
  it("workspace labels are inherited without disclosing private issue counts", async () => {
    const id = await team("private"),
      issueId = await issue(id),
      snapshot = await service.readIssueDefinitions(actor(), null),
      value = structuredClone(snapshot.value),
      a = label(`Shared-${randomUUID()}`)
    value.labels.labels.push(a)
    await service.saveIssueDefinitions(actor(), command(snapshot, value))
    await classification.setCanonicalIssueClassification(actor(), {
      issueId,
      commandKey: randomUUID(),
      expectedStatusId: "backlog",
      statusId: "todo",
      labelIds: [a.id],
    })
    expect(
      (
        await service.readIssueDefinitions(actor(), null)
      ).value.labels.labels.find((l) => l.id === a.id)?.issues
    ).toBe(1)
    expect(
      (
        await service.readIssueDefinitions(actor("member"), null)
      ).value.labels.labels.find((l) => l.id === a.id)?.issues
    ).toBe(0)
  })
  it("foreign keys reject other-team statuses and direct referenced deletion", async () => {
    const id = await team(),
      snapshot = await ready(id),
      other = await team(),
      issueId = await issue(id, "ready")
    await expect(
      pool.query("UPDATE issues SET team_id=$1 WHERE id=$2", [other, issueId])
    ).rejects.toMatchObject({ constraint: "issues_status_fk" })
    await expect(
      pool.query(
        "DELETE FROM issue_statuses WHERE workspace_id=$1 AND team_id=$2 AND id='ready'",
        [workspace, id]
      )
    ).rejects.toMatchObject({ constraint: "issues_status_fk" })
    expect((await service.readIssueDefinitions(actor(), id)).revision).toBe(
      snapshot.revision
    )
  })
  it("rejects out-of-scope replacements and dangling automation/group references", async () => {
    const id = await team(),
      snapshot = await ready(id),
      value = structuredClone(snapshot.value)
    value.statuses.statuses = value.statuses.statuses.filter(
      (s) => s.id !== "ready"
    )
    await expect(
      service.saveIssueDefinitions(actor(), {
        ...command(snapshot, value),
        statusReplacements: { ready: "missing" },
      })
    ).rejects.toThrow("replacement status")
    const bad = structuredClone(snapshot.value)
    bad.workflows.pullRequests.merge = "missing"
    await expect(
      service.saveIssueDefinitions(actor(), command(snapshot, bad))
    ).rejects.toThrow("automation references")
    const badGroup = structuredClone(snapshot.value)
    badGroup.labels.labels = [{ ...label("Grouped"), groupId: randomUUID() }]
    await expect(
      service.saveIssueDefinitions(actor(), command(snapshot, badGroup))
    ).rejects.toThrow("group from this scope")
  })

  it("protects status and label references in templates and recurring issue configuration", async () => {
    const { emptyTemplate } = await import("@/lib/template-contract")
    const { emptyRecurringIssue } =
      await import("@/lib/recurring-issue-contract")
    const id = await team(),
      base = await ready(id),
      value = structuredClone(base.value),
      mobile = label("Mobile")
    value.labels.labels = [mobile]
    const snapshot = await service.saveIssueDefinitions(
      actor(),
      command(base, value)
    )
    const template = emptyTemplate("issue", id)
    template.name = "Saved"
    template.properties.status = "Ready"
    template.properties.labels = [mobile.id]
    await pool.query(
      "INSERT INTO team_templates(workspace_id,team_id,payload,created_by_user_id) VALUES($1,$2,$3,$4)",
      [workspace, id, JSON.stringify(template), admin]
    )
    const recurring = emptyRecurringIssue(id, "Europe/Paris")
    recurring.title = "Recurring"
    recurring.properties.status = "ready"
    await pool.query(
      "INSERT INTO team_recurring_issues(workspace_id,team_id,payload,created_by_user_id) VALUES($1,$2,$3,$4)",
      [workspace, id, JSON.stringify(recurring), admin]
    )
    const removed = structuredClone(snapshot.value)
    removed.statuses.statuses = removed.statuses.statuses.filter(
      (s) => s.id !== "ready"
    )
    await expect(
      service.saveIssueDefinitions(actor(), {
        ...command(snapshot, removed),
        statusReplacements: { ready: "todo" },
      })
    ).rejects.toThrow("saved template or recurring issue")
    const labels = structuredClone(snapshot.value)
    labels.labels.labels = []
    await expect(
      service.saveIssueDefinitions(actor(), command(snapshot, labels))
    ).rejects.toThrow("saved template or recurring issue")
    template.properties.status = "missing"
    await expect(
      pool.query(
        "INSERT INTO team_templates(workspace_id,team_id,payload,created_by_user_id) VALUES($1,$2,$3,$4)",
        [workspace, id, JSON.stringify(template), admin]
      )
    ).rejects.toMatchObject({ constraint: "template_issue_status_definition" })
    recurring.properties.status = "todo"
    recurring.properties.labels = [randomUUID()]
    await expect(
      pool.query(
        "INSERT INTO team_recurring_issues(workspace_id,team_id,payload,created_by_user_id) VALUES($1,$2,$3,$4)",
        [workspace, id, JSON.stringify(recurring), admin]
      )
    ).rejects.toMatchObject({ constraint: "template_issue_label_definition" })
  })
  it("serializes a template reference against concurrent status deletion", async () => {
    const { emptyTemplate } = await import("@/lib/template-contract")
    const id = await team(),
      snapshot = await ready(id),
      value = structuredClone(snapshot.value)
    value.statuses.statuses = value.statuses.statuses.filter(
      (s) => s.id !== "ready"
    )
    const template = emptyTemplate("issue", id)
    template.name = "Concurrent"
    template.properties.status = "Ready"
    const results = await Promise.allSettled([
      pool.query(
        "INSERT INTO team_templates(workspace_id,team_id,payload,created_by_user_id) VALUES($1,$2,$3,$4)",
        [workspace, id, JSON.stringify(template), admin]
      ),
      service.saveIssueDefinitions(actor(), command(snapshot, value)),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
  })
  it("registers recovery capture and publishes deletion under enabled journaling", async () => {
    const { journalDatabasePool } =
      await import("@/adapters/recovery/journaled-pool.server")
    const { applicationConnection } = JSON.parse(readFileSync(file!, "utf8"))
    const events: Array<RecoveryEvent> = []
    const operationIds: Array<string> = []
    const prepare = vi.fn(async (id: string) => {
      operationIds.push(id)
    })
    journalDatabasePool(
      database.databaseClient,
      {
        prepare,
        abort: async () => {},
        complete: async (_id, _source, batches) => {
          for await (const batch of batches) events.push(...batch)
        },
      },
      applicationConnection,
      "store_for40acceptance"
    )
    await pool.query(
      "UPDATE recovery_journal_state SET enabled=true WHERE id='singleton'"
    )
    try {
      const id = await team(),
        snapshot = await ready(id),
        value = structuredClone(snapshot.value)
      value.statuses.statuses = value.statuses.statuses.filter(
        (s) => s.id !== "ready"
      )
      await service.saveIssueDefinitions(actor(), command(snapshot, value))
      expect(prepare).toHaveBeenCalled()
      expect(
        events.some(
          (e) =>
            e.table === "issue_statuses" &&
            e.action === "delete" &&
            typeof e.key.row_id === "string"
        )
      ).toBe(true)
    } finally {
      await pool.query(
        "UPDATE recovery_journal_state SET enabled=false WHERE id='singleton'"
      )
      await pool.query(
        "DELETE FROM recovery_events WHERE operation_id=ANY($1::uuid[])",
        [operationIds]
      )
      await pool.query(
        "DELETE FROM recovery_operations WHERE id=ANY($1::uuid[])",
        [operationIds]
      )
    }
  })
})

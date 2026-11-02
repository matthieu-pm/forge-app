// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DATABASE_TARGETS } from "../../../scripts/lib/database-targets"
import { assertMigrationTarget } from "../../../scripts/lib/serialized-migrations"
import type { Actor } from "@/application/actor"
import type { TemplateDraft } from "@/lib/template-contract"
import type { ApplyTemplate } from "@/lib/template-application-contract"
import type * as Application from "./template-application.server"
import type * as Templates from "./templates.server"
import type * as Projects from "../planning/projects.server"
import type * as Initiatives from "../planning/initiatives.server"
import { emptyProperties, emptyTemplate } from "@/lib/template-contract"
import { initiativesSettingsStorageKey } from "@/lib/initiatives"

const file = process.env.FORGE_TEMPLATE_TEST_DATABASE_FILE

describe.skipIf(!file)(
  "FOR-63 canonical template applications on PostgreSQL",
  () => {
    const marker = `for63-${randomUUID()}`,
      users = [`${marker}-alice`, `${marker}-bob`],
      workspaces: Array<string> = []
    let pool: Pool,
      application: typeof Application,
      templates: typeof Templates,
      projects: typeof Projects,
      initiatives: typeof Initiatives
    beforeAll(async () => {
      const { connection, applicationConnection } = JSON.parse(
        readFileSync(file!, "utf8")
      )
      const target = {
        environment: "template-acceptance",
        ...DATABASE_TARGETS["template-acceptance"],
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
      vi.stubEnv("FORGE_FEATURE_TEMPLATES", "true")
      vi.stubEnv("FORGE_FEATURE_INITIATIVES", "true")
      application = await import("./template-application.server")
      templates = await import("./templates.server")
      projects = await import("../planning/projects.server")
      initiatives = await import("../planning/initiatives.server")
      for (const id of users)
        await pool.query(
          'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
          [id, `${id}@example.test`]
        )
    }, 30000)
    afterAll(async () => {
      if (!pool) return
      for (const id of workspaces)
        await pool.query("DELETE FROM organization WHERE id=$1", [id])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
      await pool.end()
      const { databaseClient } = await import("@/db")
      await databaseClient.end()
      vi.unstubAllEnvs()
    }, 30000)
    async function fixture() {
      const workspaceId = `${marker}-${workspaces.length}`,
        teamId = randomUUID(),
        privateTeam = randomUUID(),
        actors: Array<Actor> = []
      workspaces.push(workspaceId)
      await pool.query(
        "INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)",
        [workspaceId]
      )
      for (const [index, userId] of users.entries()) {
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
          workspaceId,
          userId,
          workspaceRole: index ? "member" : "admin",
          authentication: { kind: "session", sessionId },
          scopes: null,
        })
      }
      for (const id of [teamId, privateTeam])
        await pool.query(
          "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,$3,$3,$4,$5,'emoji','🔥','#94a3b8','Europe/Paris',$6)",
          [
            id,
            workspaceId,
            id,
            id.slice(0, 5).toUpperCase(),
            id === privateTeam ? "private" : "workspace",
            users[0],
          ]
        )
      return { workspaceId, teamId, privateTeam, actors }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>
    async function save(f: Fixture, payload: TemplateDraft, slug?: string) {
      const saved = await templates.saveTemplate(f.actors[0], {
        payload: {
          ...payload,
          visibility:
            !slug && payload.kind === "issue" ? "" : payload.visibility,
        },
        slug,
      })
      const directory = await application.loadApplicationDirectory(
        f.actors[0],
        { slug }
      )
      const selected = directory.templates.find((t) => t.id === saved.id)!
      return {
        commandKey: randomUUID(),
        templateId: saved.id,
        revision: selected.revision,
        answers: {},
      } as ApplyTemplate
    }
    async function counts(f: Fixture) {
      return (
        await pool.query(
          "SELECT (SELECT count(*)::int FROM issues WHERE workspace_id=$1) issues,(SELECT count(*)::int FROM projects WHERE workspace_id=$1) projects,(SELECT count(*)::int FROM command_receipts WHERE workspace_id=$1 AND operation='templates.apply@1') receipts",
          [f.workspaceId]
        )
      ).rows[0]
    }
    async function project(f: Fixture, name: string, teamIds = [f.teamId]) {
      const id = randomUUID()
      await projects.saveCanonicalProjects(f.actors[0], randomUUID(), [
        {
          id,
          expectedRevision: null,
          changes: { name, teamIds, status: "Backlog" },
        },
      ])
      return id
    }
    it("AT-01: concurrent exact retry and a distinct command create exactly two canonical issue trees with expected values", async () => {
      const f = await fixture()
      const payload = {
        ...emptyTemplate("issue", f.teamId),
        name: "Bug",
        title: "Template parent",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Reusable body" }],
            },
          ],
        },
        properties: {
          ...emptyProperties(f.teamId),
          assignee: users[1],
          priority: "High" as const,
          estimate: "3",
        },
        subIssues: [
          {
            id: "child",
            title: "Investigate",
            content: null,
            properties: {
              ...emptyProperties(f.teamId),
              status: "Todo",
              priority: "Low" as const,
            },
          },
        ],
      }
      const input = await save(f, payload)
      const [first, retry] = await Promise.all([
        application.applyTemplate(f.actors[1], input),
        application.applyTemplate(f.actors[1], input),
      ])
      expect(first.ok && retry.ok && first.value.id === retry.value.id).toBe(
        true
      )
      expect(
        first.ok && retry.ok && [first.replayed, retry.replayed].sort()
      ).toEqual([false, true])
      const second = await application.applyTemplate(f.actors[1], {
        ...input,
        commandKey: randomUUID(),
      })
      expect(second.ok && first.ok && second.value.id !== first.value.id).toBe(
        true
      )
      expect(await counts(f)).toEqual({ issues: 4, projects: 0, receipts: 2 })
      const rows = (
        await pool.query(
          "SELECT title,status_id,assignee_id,parent_id,properties FROM issues WHERE workspace_id=$1 ORDER BY number",
          [f.workspaceId]
        )
      ).rows
      expect(rows[0]).toMatchObject({
        title: "Template parent",
        status_id: "backlog",
        assignee_id: users[1],
        properties: {
          priority: "High",
          estimate: "3",
          description: "Reusable body",
        },
      })
      expect(rows[1]).toMatchObject({
        title: "Investigate",
        status_id: "todo",
        properties: { priority: "Low" },
      })
      expect(rows[1].parent_id).not.toBeNull()
      await expect(
        application.applyTemplate(f.actors[1], { ...input, title: "Changed" })
      ).rejects.toThrow(/different input/)
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM command_audit_events WHERE workspace_id=$1 AND operation='templates.apply@1'",
            [f.workspaceId]
          )
        ).rows[0].n
      ).toBe(2)
    }, 30000)
    it("creates projects, fresh milestone IDs, nested issues, dependencies in both directions and initiative membership atomically", async () => {
      const f = await fixture(),
        blocker = await project(f, "Existing blocker"),
        blocked = await project(f, "Existing blocked"),
        initiativeId = randomUUID()
      await pool.query(
        "INSERT INTO product_state(workspace_id,owner_id,key,encoded_value) VALUES($1,'workspace',$2,$3)",
        [
          f.workspaceId,
          initiativesSettingsStorageKey(f.workspaceId),
          JSON.stringify(JSON.stringify({ enabled: true, schedule: "none" })),
        ]
      )
      await initiatives.saveCanonicalInitiatives(f.actors[0], randomUUID(), [
        {
          id: initiativeId,
          expectedRevision: null,
          changes: { name: "Goal" },
          addProjectIds: [],
          removeProjectIds: [],
        },
      ])
      const input = await save(f, {
        ...emptyTemplate("project", f.teamId),
        name: "Launch template",
        title: "Launch",
        summary: "Ready to ship",
        milestones: [{ id: "old", title: "Ship", content: null }],
        properties: {
          ...emptyProperties(f.teamId),
          lead: users[1],
          members: [users[0]],
          dependencies: [
            { direction: "blockedBy", name: blocker },
            { direction: "blocking", name: blocked },
          ],
          initiatives: [initiativeId],
        },
        issues: [
          {
            id: "first",
            title: "Prepare",
            content: null,
            properties: emptyProperties(f.teamId),
          },
        ],
      })
      const result = await application.applyTemplate(f.actors[1], input)
      expect(result.ok).toBe(true)
      if (!result.ok) throw Error(result.message)
      expect(await application.applyTemplate(f.actors[1], input)).toMatchObject(
        { ok: true, replayed: true, value: result.value }
      )
      const row = (
        await pool.query("SELECT properties FROM projects WHERE id=$1", [
          result.value.id,
        ])
      ).rows[0].properties
      expect(row).toMatchObject({
        summary: "Ready to ship",
        leadId: users[1],
        memberIds: [users[0]],
        dependencyIds: [blocker],
      })
      expect(row.milestones[0]).toMatchObject({
        name: "Ship",
        completed: false,
      })
      expect(row.milestones[0].id).not.toBe("old")
      expect(
        (
          await pool.query(
            "SELECT properties->'dependencyIds' ids FROM projects WHERE id=$1",
            [blocked]
          )
        ).rows[0].ids
      ).toContain(result.value.id)
      expect(
        (
          await pool.query(
            "SELECT project_id FROM issues WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].project_id
      ).toBe(result.value.id)
      expect(
        (
          await pool.query(
            "SELECT 1 FROM initiative_projects WHERE initiative_id=$1 AND project_id=$2",
            [initiativeId, result.value.id]
          )
        ).rowCount
      ).toBe(1)
      expect(await counts(f)).toEqual({ issues: 1, projects: 3, receipts: 1 })
    }, 30000)
    it("validates every form field type server-side and saves the answers in the canonical description", async () => {
      const f = await fixture()
      const fields = (
        ["text", "textarea", "select", "checkbox", "date", "number"] as const
      ).map((type) => ({
        id: type,
        label: type,
        type,
        required: true,
        options: type === "select" ? ["A", "B"] : [],
      }))
      const input = await save(f, {
        ...emptyTemplate("issue", f.teamId),
        name: "Request form",
        title: "Request",
        issueType: "form",
        fields,
      })
      expect(await application.applyTemplate(f.actors[1], input)).toMatchObject(
        { ok: false, code: "TEMPLATE_VALIDATION" }
      )
      const answers = {
        text: "Hello",
        textarea: "Details",
        select: "A",
        checkbox: true,
        date: "2026-11-02",
        number: 7,
      }
      for (const invalid of [
        { select: "C" },
        { checkbox: false },
        { date: "2026-02-30" },
        { number: "NaN" },
        { extra: "Injected" },
      ] as Array<ApplyTemplate["answers"]>)
        expect(
          await application.applyTemplate(f.actors[1], {
            ...input,
            answers: { ...answers, ...invalid },
          })
        ).toMatchObject({ ok: false })
      expect(await counts(f)).toEqual({ issues: 0, projects: 0, receipts: 0 })
      const result = await application.applyTemplate(f.actors[1], {
        ...input,
        answers,
      })
      expect(result.ok).toBe(true)
      const row = (
        await pool.query(
          "SELECT properties FROM issues WHERE workspace_id=$1",
          [f.workspaceId]
        )
      ).rows[0].properties
      expect(row.description).toContain("Hello")
      expect(row.description).toContain("2026-11-02")
      expect(row.descriptionDoc.content).toHaveLength(12)
    }, 30000)
    it("AT-02: missing status, inaccessible/deleted team and departed assignee return repairable validation without effects", async () => {
      const f = await fixture()
      for (const properties of [
        { ...emptyProperties(f.teamId), status: "In Review" },
        emptyProperties(f.privateTeam),
        { ...emptyProperties(f.teamId), assignee: "departed" },
      ]) {
        // Existing templates can outlive their references; fixture the saved snapshot directly.
        const input = await save(f, {
          ...emptyTemplate("issue", f.teamId),
          name: randomUUID(),
          title: "Invalid",
        })
        await pool.query(
          "UPDATE team_templates SET payload=jsonb_set(payload,'{properties}',$2::jsonb) WHERE id=$1",
          [input.templateId, JSON.stringify(properties)]
        )
        if (properties.status === "In Review")
          await pool.query(
            "DELETE FROM issue_statuses WHERE team_id=$1 AND id='in-review'",
            [f.teamId]
          )
        const selected = (
          await application.loadApplicationDirectory(f.actors[1], {})
        ).templates.find((t) => t.id === input.templateId)!
        expect(
          await application.applyTemplate(f.actors[1], {
            ...input,
            revision: selected.revision,
          })
        ).toMatchObject({ ok: false, code: "TEMPLATE_VALIDATION" })
      }
      const removed = await save(f, {
        ...emptyTemplate("issue", f.teamId),
        name: "Deleted team",
        title: "Invalid",
        properties: emptyProperties(f.teamId),
      })
      await pool.query("DELETE FROM teams WHERE id=$1", [f.teamId])
      expect(
        await application.applyTemplate(f.actors[1], removed)
      ).toMatchObject({ ok: false })
      expect(await counts(f)).toEqual({ issues: 0, projects: 0, receipts: 0 })
    }, 30000)
    it("rolls back an entire project application for a bad nested issue, dependency cycle, or disabled initiative", async () => {
      const f = await fixture(),
        existing = await project(f, "Other")
      const base = {
        ...emptyTemplate("project", f.teamId),
        name: "Rollback",
        title: "No partial project",
      }
      const inputs = [
        {
          ...base,
          issues: [
            {
              id: "bad",
              title: "Bad issue",
              content: null,
              properties: { ...emptyProperties(f.teamId), status: "Canceled" },
            },
          ],
        },
        {
          ...base,
          properties: {
            ...base.properties,
            dependencies: [
              { direction: "blockedBy" as const, name: existing },
              { direction: "blocking" as const, name: existing },
            ],
          },
        },
        {
          ...base,
          properties: { ...base.properties, initiatives: [randomUUID()] },
        },
      ]
      for (const payload of inputs) {
        const input = await save(f, { ...payload, name: randomUUID() })
        if (payload.issues.length)
          await pool.query(
            "DELETE FROM issue_statuses WHERE team_id=$1 AND id='canceled'",
            [f.teamId]
          )
        expect(
          await application.applyTemplate(f.actors[1], input)
        ).toMatchObject({ ok: false })
      }
      expect(await counts(f)).toEqual({ issues: 0, projects: 1, receipts: 0 })
    }, 30000)
    it("binds the chosen revision, supports repair with the same rolled-back key, and replays after template edits", async () => {
      const f = await fixture(),
        payload = {
          ...emptyTemplate("issue", f.teamId),
          name: "Revision",
          title: "Original",
        }
      const input = await save(f, payload)
      await pool.query(
        "UPDATE team_templates SET payload=jsonb_set(payload,'{title}','\"Latest\"') WHERE id=$1",
        [input.templateId]
      )
      expect(await application.applyTemplate(f.actors[1], input)).toMatchObject(
        { ok: false, message: expect.stringMatching(/changed/) }
      )
      expect(await counts(f)).toEqual({ issues: 0, projects: 0, receipts: 0 })
      const latest = (
        await application.loadApplicationDirectory(f.actors[1], {})
      ).templates.find((t) => t.id === input.templateId)!
      const repaired = { ...input, revision: latest.revision }
      const result = await application.applyTemplate(f.actors[1], repaired)
      expect(result.ok).toBe(true)
      await pool.query(
        "UPDATE team_templates SET payload=jsonb_set(payload,'{title}','\"Changed again\"') WHERE id=$1",
        [input.templateId]
      )
      expect(
        await application.applyTemplate(f.actors[1], repaired)
      ).toMatchObject({ ok: true, replayed: true })
      await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
        f.teamId,
      ])
      await expect(
        application.applyTemplate(f.actors[1], repaired)
      ).rejects.toThrow(/access|authorized|permission/i)
      expect(await counts(f)).toEqual({ issues: 1, projects: 0, receipts: 1 })
    }, 30000)
    it("enforces template source/visibility/workspace scope and the feature gate", async () => {
      const f = await fixture(),
        other = await fixture()
      const input = await save(
        f,
        {
          ...emptyTemplate("issue", f.privateTeam),
          name: "Private template",
          title: "Private",
        },
        f.privateTeam
      )
      expect(
        (await application.loadApplicationDirectory(f.actors[1], {})).templates
      ).toHaveLength(0)
      expect(await application.applyTemplate(f.actors[1], input)).toMatchObject(
        { ok: false }
      )
      expect(
        await application.applyTemplate(other.actors[1], input)
      ).toMatchObject({ ok: false })
      vi.stubEnv("FORGE_FEATURE_TEMPLATES", "false")
      try {
        expect(
          await application.loadApplicationDirectory(f.actors[1], {})
        ).toMatchObject({ enabled: false, templates: [] })
        await expect(
          application.applyTemplate(f.actors[0], input)
        ).rejects.toThrow(/not enabled/)
      } finally {
        vi.stubEnv("FORGE_FEATURE_TEMPLATES", "true")
      }
      expect(await counts(f)).toEqual({ issues: 0, projects: 0, receipts: 0 })
    }, 30000)
    it("retains replay identity after template deletion, and commits no replacement effect", async () => {
      const f = await fixture(),
        input = await save(f, {
          ...emptyTemplate("issue", f.teamId),
          name: "Removed after commit",
          title: "Original effect",
        })
      expect(await application.applyTemplate(f.actors[1], input)).toMatchObject(
        {
          ok: true,
        }
      )
      await pool.query("DELETE FROM team_templates WHERE id=$1", [
        input.templateId,
      ])
      await expect(
        application.applyTemplate(f.actors[1], input)
      ).rejects.toThrow(/no longer available/)
      expect(await counts(f)).toEqual({ issues: 1, projects: 0, receipts: 1 })
    }, 30000)
    it("does not classify a deferred COMMIT failure as repairable validation; the original key can retry atomically", async () => {
      const f = await fixture(),
        input = await save(f, {
          ...emptyTemplate("issue", f.teamId),
          name: "Commit fault",
          title: "All or nothing",
        })
      await pool.query(
        `CREATE FUNCTION public.for63_commit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${f.workspaceId}' THEN RAISE EXCEPTION 'FOR63 injected commit failure'; END IF; RETURN NEW; END $$`
      )
      await pool.query(
        "CREATE CONSTRAINT TRIGGER for63_commit_fault AFTER INSERT ON command_audit_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.for63_commit_fault()"
      )
      try {
        await expect(
          application.applyTemplate(f.actors[1], input)
        ).rejects.toThrow()
        expect(await counts(f)).toEqual({ issues: 0, projects: 0, receipts: 0 })
      } finally {
        await pool.query(
          "DROP TRIGGER for63_commit_fault ON command_audit_events"
        )
        await pool.query("DROP FUNCTION public.for63_commit_fault()")
      }
      expect(await application.applyTemplate(f.actors[1], input)).toMatchObject(
        {
          ok: true,
          replayed: false,
        }
      )
      expect(await application.applyTemplate(f.actors[1], input)).toMatchObject(
        {
          ok: true,
          replayed: true,
        }
      )
    }, 30000)
    it("uses existing member/non-member defaults without applying issue defaults to project selection", async () => {
      const f = await fixture()
      const standard = await save(
        f,
        {
          ...emptyTemplate("issue", f.teamId),
          name: "Member default",
          title: "Member",
        },
        f.teamId
      )
      const form = await save(
        f,
        {
          ...emptyTemplate("issue", f.teamId),
          name: "Non-member default",
          title: "Visitor",
          issueType: "form",
        },
        f.teamId
      )
      await templates.setDefault(f.actors[0], {
        slug: f.teamId,
        audience: "members",
        templateId: standard.templateId,
      })
      await templates.setDefault(f.actors[0], {
        slug: f.teamId,
        audience: "nonMembers",
        templateId: form.templateId,
      })
      expect(
        (
          await application.loadApplicationDirectory(f.actors[1], {
            slug: f.teamId,
            kind: "issue",
          })
        ).defaultId
      ).toBe(form.templateId)
      await pool.query(
        "INSERT INTO team_members(workspace_id,team_id,user_id,role) VALUES($1,$2,$3,'member')",
        [f.workspaceId, f.teamId, users[1]]
      )
      expect(
        (
          await application.loadApplicationDirectory(f.actors[1], {
            slug: f.teamId,
            kind: "issue",
          })
        ).defaultId
      ).toBe(standard.templateId)
      expect(
        (
          await application.loadApplicationDirectory(f.actors[1], {
            slug: f.teamId,
            kind: "project",
          })
        ).defaultId
      ).toBeNull()
      const triage = await application.applyTemplate(f.actors[1], {
        ...standard,
        triage: true,
      })
      expect(triage.ok).toBe(true)
      expect(
        (
          await pool.query(
            "SELECT properties->>'triage' triage FROM issues WHERE workspace_id=$1",
            [f.workspaceId]
          )
        ).rows[0].triage
      ).toBe("true")
    }, 30000)
    it("preserves unreadable project dependencies while allowing visible links to be repaired", async () => {
      const f = await fixture(),
        hidden = await project(f, "Hidden dependency", [f.privateTeam]),
        visible = await project(f, "Visible dependency"),
        source = await project(f, "Source")
      const before = (
        await pool.query("SELECT revision FROM projects WHERE id=$1", [source])
      ).rows[0].revision
      await projects.saveCanonicalProjects(f.actors[0], randomUUID(), [
        {
          id: source,
          expectedRevision: before,
          changes: { dependencyIds: [hidden, visible] },
        },
      ])
      const revision = (
        await pool.query("SELECT revision FROM projects WHERE id=$1", [source])
      ).rows[0].revision
      await projects.saveCanonicalProjects(f.actors[1], randomUUID(), [
        {
          id: source,
          expectedRevision: revision,
          changes: { dependencyIds: [] },
        },
      ])
      expect(
        (
          await pool.query(
            "SELECT properties->'dependencyIds' ids FROM projects WHERE id=$1",
            [source]
          )
        ).rows[0].ids
      ).toEqual([hidden])
      const input = await save(f, {
        ...emptyTemplate("project", f.teamId),
        name: "Hidden reference",
        title: "Unavailable dependency",
        properties: {
          ...emptyProperties(f.teamId),
          dependencies: [{ direction: "blockedBy", name: hidden }],
        },
      })
      expect(await application.applyTemplate(f.actors[1], input)).toMatchObject(
        {
          ok: false,
        }
      )
      expect(await counts(f)).toEqual({ issues: 0, projects: 3, receipts: 0 })
    }, 30000)
  }
)

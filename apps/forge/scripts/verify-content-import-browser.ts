import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
import { DATABASE_TARGETS } from "./lib/database-targets"
import { assertMigrationTarget } from "./lib/serialized-migrations"

// Deliberate legacy fixtures; the browser must submit them through the real importer.
const blankInitiative = (creatorId: string) => ({
  name: "",
  summary: "",
  description: null,
  icon: { kind: "icon", value: "Target01Icon", color: "#eb5757" },
  status: "Active",
  priority: "No priority",
  ownerId: "",
  creatorId,
  targetDate: "",
  labelIds: [],
  teamIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedAt: null,
  updates: [],
  projects: [],
  comments: [],
  resources: [],
  views: [],
})
const newCustomView = (_kind: string, ownerId: string) => ({
  kind: "issues",
  id: crypto.randomUUID(),
  name: "All issues",
  description: "",
  icon: null,
  ownerId,
  visibility: "personal",
  favorite: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  filters: { match: "all", rules: [] },
  display: {
    layout: "list",
    group: "Status",
    subgroup: "No grouping",
    order: "Priority",
    descending: false,
    groupDescending: false,
    completedByRecency: false,
    showSubIssues: true,
    nested: "Show matching",
    showEmpty: false,
    properties: [
      "ID",
      "Status",
      "Assignee",
      "Priority",
      "Project",
      "Due date",
      "Labels",
      "Created",
    ],
  },
})
const file = process.env.FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE
if (!file)
  throw new Error("An explicit isolated acceptance database is required.")
const config = JSON.parse(readFileSync(file, "utf8"))
const target = {
  environment: "resource-loop-acceptance",
  ...DATABASE_TARGETS["resource-loop-acceptance"],
} as const
assertMigrationTarget(config.connection, target)
assertMigrationTarget(
  config.applicationConnection.replace("-pooler.", "."),
  target
)
const base =
    process.env.FORGE_CONTENT_IMPORT_BROWSER_URL ?? "http://localhost:3126",
  origin = new URL(base)
if (
  origin.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(origin.hostname) ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/"
)
  throw new Error("A local acceptance origin is required.")
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection })
const marker = `for126-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  users = [`${marker}-alice`, `${marker}-bob`],
  password = crypto.randomUUID()
const output = resolve("../../docs/qa/content-imports")
mkdirSync(output, { recursive: true })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  verified = false
try {
  const identity = (
    await pool.query(
      "SELECT current_database() db,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  if (identity.db !== target.database || identity.branch !== target.branchId)
    throw new Error("Wrong database identity.")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'Content import acceptance',$1)",
    [marker]
  )
  for (const [index, userId] of users.entries()) {
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [userId, index ? "Bob Member" : "Alice Admin", `${userId}@example.test`]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)",
      [crypto.randomUUID(), userId, marker, index ? "member" : "admin"]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), userId, await hashPassword(password)]
    )
  }
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Engineering','engineering','ENG','emoji','x','#94a3b8','Europe/Paris',$3)",
    [teamId, marker, users[0]]
  )
  for (const user of users)
    await pool.query(
      "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member')",
      [crypto.randomUUID(), marker, teamId, user]
    )
  browser = await chromium.launch({ headless: true })
  const contexts = await Promise.all(
    users.map(() =>
      browser!.newContext({ viewport: { width: 1440, height: 1000 } })
    )
  )
  const pages = []
  for (const [index, context] of contexts.entries()) {
    const signedIn = await context.request.post(
      `${base}/api/auth/sign-in/email`,
      {
        headers: { Origin: base },
        data: { email: `${users[index]}@example.test`, password },
      }
    )
    if (!signedIn.ok()) throw new Error(`Sign in failed: ${signedIn.status()}`)
    const selected = await context.request.post(
      `${base}/api/auth/organization/set-active`,
      { headers: { Origin: base }, data: { organizationId: marker } }
    )
    if (!selected.ok())
      throw new Error(`Workspace selection failed: ${selected.status()}`)
    pages.push(await context.newPage())
  }
  const [alice, bob] = pages,
    pageErrors: Array<string> = []
  for (const page of pages)
    page.on("pageerror", (error) => pageErrors.push(error.message))
  await alice.goto(`${base}/settings/import-export`)
  await expect(
    alice.getByText("No saved imports for this account and workspace.")
  ).toBeVisible({ timeout: 60000 })
  const sources: Array<{ key: string; raw: string }> = []
  const preserve = async (key: string, value: unknown) => {
    const raw = JSON.stringify(value)
    sources.push({ key, raw })
    await pool.query(
      "INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5)",
      [marker, `user:${users[0]}`, users[0], key, JSON.stringify(raw)]
    )
  }
  const teamDocumentId = crypto.randomUUID()
  const project = {
    id: "legacy-project",
    name: "Imported roadmap",
    status: "Active",
    health: "On track",
    teamIds: [teamId],
    milestones: [{ id: "launch", name: "Launch", completed: false }],
    resources: [
      {
        id: "design",
        title: "Imported design",
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Preserved project design" }],
            },
          ],
        },
      },
    ],
  }
  await preserve(`forge:workspace:${marker}:initiatives:v1`, {
    version: 1,
    workspaceProjects: [project],
    initiatives: [
      {
        ...blankInitiative(users[0]),
        id: "legacy-initiative",
        number: 1,
        name: "Imported strategy",
        projects: [project],
      },
    ],
  })
  await preserve(`forge:team-home:v1:${teamId}`, {
    favorite: true,
    sections: [{ id: "notes", name: "Imported notes", collapsed: true }],
    resources: [
      {
        id: teamDocumentId,
        kind: "document",
        title: "Imported team document",
        content: "Preserved team content",
        sectionId: "notes",
        favorite: true,
      },
      {
        id: "reference",
        kind: "link",
        title: "Imported reference",
        content: "https://example.com",
        sectionId: "notes",
      },
      {
        id: "corrupt",
        kind: "document",
        title: "Corrupt retained document",
        body: { type: "doc", content: [{ type: "script" }] },
      },
    ],
    loops: [],
  })
  const privateView = {
    ...newCustomView("issues", users[0]),
    id: "private-view",
    name: "Imported private view",
  }
  const sharedView = {
    ...newCustomView("issues", users[0]),
    id: "shared-view",
    name: "Imported shared view",
    visibility: "team",
    teamId,
    filters: {
      match: "all",
      rules: [
        { id: "project", field: "project", operator: "is", value: project.id },
      ],
    },
  }
  await preserve(`forge:workspace:${marker}:custom-views:v1:${users[0]}`, {
    version: 1,
    views: [
      privateView,
      sharedView,
      {
        ...newCustomView("issues", users[1]),
        id: "ambiguous",
        name: "Ambiguous retained view",
      },
    ],
  })
  await alice
    .getByRole("button", { name: "Check for preserved content" })
    .click()
  const progress = alice.locator(
    'section[aria-label="Browser import progress"]'
  )
  await expect(progress.locator("summary").first()).toBeVisible({
    timeout: 60000,
  })
  await progress.locator("summary").first().click()
  await expect(
    progress.getByRole("button", { name: "Resume import" })
  ).toBeVisible({ timeout: 60000 })
  await progress.getByRole("button", { name: "Resume import" }).click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT encoded_manifest FROM legacy_imports WHERE workspace_id=$1",
            [marker]
          )
        ).rows
          .map(
            (r) =>
              JSON.parse(r.encoded_manifest).entries.filter(
                (e: { state: string }) => e.state === "pending"
              ).length
          )
          .reduce((a, b) => a + b, 0),
      { timeout: 60000 }
    )
    .toBe(0)
  await expect(
    progress.getByText("Corrupt retained document · quarantined")
  ).toBeVisible({ timeout: 60000 })
  await expect(
    progress.getByText("Ambiguous retained view · quarantined")
  ).toBeVisible()
  const counts = async () =>
    (
      await pool.query(
        "SELECT (SELECT count(*)::int FROM initiatives WHERE workspace_id=$1) initiatives,(SELECT count(*)::int FROM projects WHERE workspace_id=$1) projects,(SELECT count(*)::int FROM documents WHERE workspace_id=$1) documents,(SELECT count(*)::int FROM saved_views WHERE workspace_id=$1) views,(SELECT count(*)::int FROM saved_view_favorites WHERE workspace_id=$1) favorites",
        [marker]
      )
    ).rows[0]
  expect(await counts()).toEqual({
    initiatives: 1,
    projects: 1,
    documents: 2,
    views: 2,
    favorites: 0,
  })
  await alice.reload()
  await expect(
    alice.getByRole("heading", { name: "Browser import progress" })
  ).toBeVisible({ timeout: 60000 })
  await progress.locator("summary").first().click()
  await alice.getByRole("button", { name: "Resume import" }).click()
  await expect(
    alice.getByRole("button", { name: "Resume import" })
  ).toBeEnabled({ timeout: 60000 })
  expect(await counts()).toEqual({
    initiatives: 1,
    projects: 1,
    documents: 2,
    views: 2,
    favorites: 0,
  })
  const teamDoc = (
    await pool.query(
      "SELECT id,section_id,shared_with_workspace FROM documents WHERE workspace_id=$1 AND title='Imported team document'",
      [marker]
    )
  ).rows[0]
  const board = (
    await pool.query(
      "SELECT fields FROM team_resource_boards WHERE workspace_id=$1",
      [marker]
    )
  ).rows[0].fields
  expect(teamDoc.id).toBe(teamDocumentId)
  expect(teamDoc.section_id).toBe(board.sections[0].id)
  expect(board.links[0].sectionId).toBe(board.sections[0].id)
  expect(teamDoc.shared_with_workspace).toBe(false)
  await bob.goto(`${base}/teams/engineering/documents?document=${teamDoc.id}`)
  await expect(
    bob.getByRole("textbox", { name: "Document title", exact: true })
  ).toHaveValue("Imported team document", { timeout: 60000 })
  await expect(
    bob.getByRole("textbox", { name: "Document content", exact: true })
  ).toContainText("Preserved team content")
  for (const source of sources) {
    const row = (
      await pool.query(
        "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2 AND owner_id=$3",
        [marker, source.key, `user:${users[0]}`]
      )
    ).rows[0]
    expect(JSON.parse(row.encoded_value)).toBe(source.raw)
  }
  expect(pageErrors).toEqual([])
  await alice.screenshot({
    path: resolve(output, "for126-import-progress.png"),
    fullPage: true,
  })
  await bob.screenshot({
    path: resolve(output, "for126-imported-document.png"),
    fullPage: true,
  })
  const result = {
    passed: true,
    database: target.database,
    branch: target.branchId,
    checks: [
      "explicit preserved-content discovery",
      "canonical project/milestone/initiative deduplication across repeated source projections",
      "team/project document scopes",
      "section/link mappings",
      "saved definitions without personal favorites",
      "corrupt/ambiguous record quarantine",
      "reload and exact replay",
      "independent member reads imported document",
      "original source bytes retained",
    ],
    counts: await counts(),
    pageErrors,
  }
  writeFileSync(
    resolve(output, "for126-browser-result.json"),
    JSON.stringify(result, null, 2) + "\n"
  )
  console.log(JSON.stringify(result))
} finally {
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM organization WHERE id=$1", [marker])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    const cleanup = (
      await pool.query(
        'SELECT (SELECT count(*)::int FROM organization WHERE id=$1) workspaces,(SELECT count(*)::int FROM "user" WHERE id=ANY($2)) users,(SELECT count(*)::int FROM legacy_imports WHERE workspace_id=$1) manifests,(SELECT count(*)::int FROM command_receipts WHERE workspace_id=$1) receipts',
        [marker, users]
      )
    ).rows[0]
    if (Object.values(cleanup).some((n) => n !== 0)) {
      process.exitCode = 1
      console.error("Fixture cleanup incomplete.")
    }
    console.log(JSON.stringify({ cleanup }))
  }
  await pool.end()
}

import { readFileSync, mkdirSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file = process.env.FORGE_ISSUE_TEST_DATABASE_FILE
if (!file) throw new Error("FORGE_ISSUE_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_issue_creation_acceptance_v2" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base = process.env.FORGE_ISSUE_BROWSER_URL ?? "http://localhost:3041",
  baseUrl = new URL(base)
if (
  baseUrl.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(baseUrl.hostname) ||
  baseUrl.username ||
  baseUrl.password
)
  throw new Error("A local acceptance server is required")
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection }),
  marker = `for41-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for41-${crypto.randomUUID()}`,
  users = [`${marker}-admin`, `${marker}-member`]
let browser,
  verified = false
try {
  const identity = (
    await pool.query(
      "SELECT current_database() database,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  if (
    identity.database !== "forge_issue_creation_acceptance_v2" ||
    identity.branch !== "br-autumn-union-za0opf1e"
  )
    throw new Error("Wrong database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR41 Acceptance',$1)",
    [marker]
  )
  await pool.query(
    "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'enterprise','active')",
    [marker]
  )
  for (let i = 0; i < users.length; i++) {
    const id = users[i]
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [id, i === 0 ? "Alice Admin" : "Bob Member", `${id}@example.test`]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)",
      [crypto.randomUUID(), id, marker, i === 0 ? "admin" : "member"]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), id, await hashPassword(password)]
    )
  }
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Engineering','engineering','ENG','emoji','⚙️','#94a3b8','Europe/Paris',$3)",
    [teamId, marker, users[0]]
  )
  await pool.query(
    "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member'),($5,$2,$3,$6,'member')",
    [
      crypto.randomUUID(),
      marker,
      teamId,
      users[0],
      crypto.randomUUID(),
      users[1],
    ]
  )
  browser = await chromium.launch({ headless: true })
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 900 } }),
    browser.newContext({ viewport: { width: 1280, height: 900 } }),
  ])
  for (let i = 0; i < contexts.length; i++) {
    const login = await contexts[i].request.post(
      `${base}/api/auth/sign-in/email`,
      {
        data: { email: `${users[i]}@example.test`, password },
        headers: { Origin: base },
      }
    )
    if (!login.ok()) throw new Error(`Sign-in failed ${login.status()}`)
    const active = await contexts[i].request.post(
      `${base}/api/auth/organization/set-active`,
      { data: { organizationId: marker }, headers: { Origin: base } }
    )
    if (!active.ok())
      throw new Error(`Workspace selection failed ${active.status()}`)
  }
  const [admin, member] = await Promise.all(contexts.map((c) => c.newPage()))
  const errors = []
  admin.on("pageerror", (e) => errors.push(e.message))
  member.on("pageerror", (e) => errors.push(e.message))
  const projectId = crypto.randomUUID(),
    legacyId = crypto.randomUUID()
  const display = {
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
  }
  const now = new Date().toISOString()
  const legacy = {
    title: "Migrated browser issue",
    description: "Original description",
    priority: "No priority",
    dueDate: "",
    status: "todo",
    cycle: "2026-10-26",
    project: projectId,
    parentId: "",
    links: [],
    subIssues: [],
    recurrence: "",
    agent: "",
    agentSession: "",
    subscribers: "",
    milestone: "",
    autoClosed: false,
    descriptionDoc: null,
    reactions: [],
    comments: [],
    activity: [],
    favorite: false,
    id: legacyId,
    number: 42,
    createdAt: now,
    updatedAt: now,
    statusChangedAt: now,
    creator: users[0],
    suggestedLabel: "",
    completedAt: null,
    recurrenceSpawned: false,
  }
  const sources = {
    [`forge:team-issues:v1:${teamId}`]: JSON.stringify({
      version: 1,
      issues: [legacy],
      drafts: [],
      views: [],
      display,
      defaultDisplay: display,
      filters: { match: "all", rules: [] },
      favorite: false,
      notifications: [],
      nextNumber: 43,
    }),
    [`forge:workspace:${marker}:initiatives:v1`]: JSON.stringify({
      version: 1,
      nextNumber: 1,
      initiatives: [],
      workspaceProjects: [
        {
          id: projectId,
          name: "Migrated project",
          status: "Backlog",
          teamIds: [teamId],
          health: "On track",
        },
      ],
    }),
    [`forge:team-cycles:v1:${teamId}`]: JSON.stringify({
      enabled: true,
      duration: 2,
      cooldown: 2,
      startDay: 1,
      futureCycles: 2,
      activeIssues: false,
      startedIssues: true,
      completedIssues: true,
    }),
    "forge:desktop-tabs": JSON.stringify({ migrationExample: true }),
  }
  await admin.addInitScript(
    ({ sources }) => {
      if (window.top !== window) return
      const native = Storage.prototype.setItem
      for (const [key, value] of Object.entries(sources))
        native.call(localStorage, key, value)
      window.__productStorageWrites = []
      Storage.prototype.setItem = function (key, value) {
        if (/^forge[:.]/.test(key)) {
          window.__productStorageWrites.push(key)
          throw new Error("Persistent browser write forbidden")
        }
        return native.call(this, key, value)
      }
    },
    { sources }
  )
  await member.addInitScript(() => {
    const native = Storage.prototype.setItem
    window.__productStorageWrites = []
    Storage.prototype.setItem = function (key, value) {
      if (/^forge[:.]/.test(key)) {
        window.__productStorageWrites.push(key)
        throw new Error("Persistent browser write forbidden")
      }
      return native.call(this, key, value)
    }
  })
  await admin.goto(`${base}/teams/engineering/issues?view=all`)
  await expect(
    admin.getByRole("button", { name: "New issue", exact: true })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    admin.getByRole("button", { name: /Open ENG-1 Migrated browser issue/ })
  ).toBeVisible({ timeout: 30000 })
  await expect
    .poll(async () =>
      admin.evaluate(() =>
        Object.keys(localStorage).filter((k) => /^forge[:.]/.test(k))
      )
    )
    .toEqual([])
  const imported = (
    await pool.query(
      "SELECT id,number,project_id,cycle_id FROM issues WHERE workspace_id=$1 AND legacy_id=$2",
      [marker, legacyId]
    )
  ).rows[0]
  if (!imported?.project_id || !imported?.cycle_id)
    throw new Error("Migration lost canonical relations")
  await member.goto(`${base}/teams/engineering/issues?view=all`)
  await expect(
    member.getByRole("button", { name: /Open ENG-1 Migrated browser issue/ })
  ).toBeVisible({ timeout: 60000 })
  await admin.getByRole("button", { name: "New issue", exact: true }).click()
  await admin
    .getByRole("textbox", { name: "Issue title", exact: true })
    .fill("Canonical browser issue")
  await admin
    .getByRole("textbox", { name: "Issue description", exact: true })
    .fill("Visible in both browsers.")
  await admin.getByRole("button", { name: "Create issue", exact: true }).click()
  await expect(
    admin.getByRole("button", { name: /Open ENG-2 Canonical browser issue/ })
  ).toBeVisible({ timeout: 30000 })
  await member.reload()
  await expect(
    member.getByRole("button", { name: /Open ENG-2 Canonical browser issue/ })
  ).toBeVisible({ timeout: 60000 })
  await admin.reload()
  await expect(
    admin.getByRole("button", { name: /Open ENG-2 Canonical browser issue/ })
  ).toBeVisible({ timeout: 60000 })
  await admin.getByRole("button",{name:/Open ENG-2 Canonical browser issue/}).click()
  await member.getByRole("button",{name:/Open ENG-2 Canonical browser issue/}).click()
  await member.getByRole("textbox",{name:"Issue title",exact:true}).fill("Member resolved title")
  await admin.getByRole("textbox",{name:"Issue title",exact:true}).fill("Admin title")
  await admin.getByRole("textbox",{name:"Issue title",exact:true}).press("Enter")
  await expect.poll(async()=>(await pool.query("SELECT title FROM issues WHERE workspace_id=$1 AND number=2",[marker])).rows[0]?.title,{timeout:30000}).toBe("Admin title")
  await member.getByRole("textbox",{name:"Issue title",exact:true}).press("Enter")
  await expect(member.getByRole("button",{name:"Apply my edits to latest",exact:true})).toBeVisible({timeout:30000})
  if((await pool.query("SELECT title FROM issues WHERE workspace_id=$1 AND number=2",[marker])).rows[0].title!=="Admin title")throw new Error("A stale edit overwrote shared data")
  const savedDrafts=(await pool.query("SELECT count(*)::int n FROM product_state WHERE workspace_id=$1 AND owner_user_id=$2 AND key LIKE 'forge:team-issue-edit-drafts:%' AND encoded_value IS NOT NULL",[marker,users[1]])).rows[0].n
  if(savedDrafts!==1)throw new Error("The conflicting edit did not retain a server draft")
  await member.getByRole("button",{name:"Apply my edits to latest",exact:true}).click()
  await expect.poll(async()=>(await pool.query("SELECT title FROM issues WHERE workspace_id=$1 AND number=2",[marker])).rows[0]?.title,{timeout:30000}).toBe("Member resolved title")
  await expect.poll(async()=>(await pool.query("SELECT count(*)::int n FROM product_state WHERE workspace_id=$1 AND key LIKE 'forge:team-issue-edit-drafts:%' AND encoded_value IS NOT NULL",[marker])).rows[0].n,{timeout:30000}).toBe(0)
  await admin.reload()
  await expect(admin.getByRole("textbox",{name:"Issue title",exact:true})).toHaveValue("Member resolved title",{timeout:60000})
  await member.goto(`${base}/teams/engineering/issues?view=all`)
  await expect(member.getByRole("button",{name:/Open ENG-2 Member resolved title/})).toBeVisible({timeout:60000})
  const count = (
    await pool.query(
      "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
      [marker]
    )
  ).rows[0].n
  if (count !== 2) throw new Error(`Unexpected issue count ${count}`)
  for (const page of [admin, member]) {
    const writes = await page.evaluate(() => window.__productStorageWrites)
    if (writes.length) throw new Error(`Native writes ${writes.join(",")}`)
  }
  for (const page of [admin, member])
    await expect(
      page.getByRole("button", { name: "Retry saving", exact: true })
    ).toHaveCount(0, { timeout: 15000 })
  await expect(
    member.getByRole("link", {
      name: "View issues in project Migrated project",
    })
  ).toBeVisible()
  mkdirSync("/tmp/for41-browser", { recursive: true })
  await member.screenshot({
    path: "/tmp/for41-browser/shared-issues.png",
    fullPage: true,
  })
  await member.setViewportSize({ width: 390, height: 844 })
  await member.screenshot({
    path: "/tmp/for41-browser/shared-issues-mobile.png",
    fullPage: true,
  })
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`)
  console.log(
    JSON.stringify({
      passed: [
        "real admin/member sessions",
        "automatic browser migration and source removal",
        "project/cycle relation migration",
        "AC-01 shared identity after reload",
        "reload deduplication",
        "zero native product storage writes",
        "desktop/mobile","FOR-42 visible conflict with durable draft and explicit rebase",
      ],
      issueCount: count,
      importedIssue: imported,
    })
  )
} finally {
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM organization WHERE id=$1", [marker])
    for (const id of users)
      await pool.query('DELETE FROM "user" WHERE id=$1', [id])
  }
  await pool.end()
}

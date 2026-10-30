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
  decodeURIComponent(url.pathname) !== "/forge_issue_creation_acceptance_v3" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base = process.env.FORGE_ISSUE_BROWSER_URL ?? "http://localhost:3139",
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
  marker = `for139-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for139-${crypto.randomUUID()}`,
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
    identity.database !== "forge_issue_creation_acceptance_v3" ||
    identity.branch !== "br-autumn-union-za0opf1e"
  )
    throw new Error("Wrong database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR139 Acceptance',$1)",
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
  for (const page of [admin, member])
    page.on("pageerror", (e) => errors.push(e.message))
  for (let number = 1; number <= 5; number++)
    await pool.query(
      "INSERT INTO issues(workspace_id,team_id,number,title,status_id,assignee_id,creator_id) VALUES($1,$2,$3,$4,'todo',$5,$6)",
      [
        marker,
        teamId,
        number,
        `Started acceptance ${number}`,
        number === 3 ? users[1] : null,
        users[0],
      ]
    )
  async function row(number) {
    return (
      await pool.query(
        "SELECT status_id,assignee_id,revision,properties FROM issues WHERE workspace_id=$1 AND number=$2",
        [marker, number]
      )
    ).rows[0]
  }
  async function saved(number, status, assignee) {
    await expect
      .poll(
        async () => {
          const r = await row(number)
          return [r.status_id, r.assignee_id]
        },
        { timeout: 60000 }
      )
      .toEqual([status, assignee])
  }
  await admin.goto(`${base}/settings`)
  const toggle = admin.getByRole("switch", {
    name: "Assign started issues to self",
  })
  if (process.env.FORGE_STARTED_ASSIGNMENT_EXPECT_DISABLED === "true") {
    await expect(toggle).toBeDisabled({ timeout: 60000 })
    await expect(
      admin.getByText("This automation is currently unavailable")
    ).toBeVisible()
    await pool.query(
      `INSERT INTO account_preferences(user_id,values) VALUES($1,'{"general.assignStartedIssues":true}')`,
      [users[0]]
    )
    await admin.goto(`${base}/teams/engineering/issues?view=all`)
    await admin
      .getByRole("button", {
        name: "Change status for Started acceptance 1",
        exact: true,
      })
      .click({ timeout: 60000 })
    await admin
      .getByRole("option", { name: "In Progress", exact: true })
      .click()
    await saved(1, "in-progress", null)
    expect(
      (await row(1)).properties.activity[0].automaticAssignment
    ).toBeUndefined()
    console.log(
      JSON.stringify({
        passed: [
          "disabled gate withholds control and prevents automation despite persisted opt-in",
        ],
        environment: base,
      })
    )
  } else {
    await expect(toggle).toBeEnabled({ timeout: 60000 })
    await toggle.click()
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              `SELECT values->'general.assignStartedIssues' enabled FROM account_preferences WHERE user_id=$1`,
              [users[0]]
            )
          ).rows[0]?.enabled,
        { timeout: 30000 }
      )
      .toBe(true)
    await admin.reload()
    await expect(toggle).toBeChecked({ timeout: 60000 })
    await member.goto(`${base}/settings`)
    await expect(
      member.getByRole("switch", { name: "Assign started issues to self" })
    ).not.toBeChecked({ timeout: 60000 })
    async function list(page) {
      await page.goto(`${base}/teams/engineering/issues?view=all`)
      await expect(
        page.getByRole("button", { name: /Open ENG-1 Started acceptance 1/ })
      ).toBeVisible({ timeout: 60000 })
    }
    async function status(page, number, label) {
      await page
        .getByRole("button", {
          name: `Change status for Started acceptance ${number}`,
          exact: true,
        })
        .click()
      await page.getByRole("option", { name: label, exact: true }).click()
    }
    await list(admin)
    await status(admin, 1, "In Progress")
    await saved(1, "in-progress", users[0])
    expect((await row(1)).properties.activity).toHaveLength(1)
    await admin
      .getByRole("button", { name: /Open ENG-1 Started acceptance 1/ })
      .click()
    await expect(
      admin.getByText(/moved to In Progress and self-assigned the issue/)
    ).toBeVisible({ timeout: 30000 })
    await admin.reload()
    await expect(
      admin.getByRole("button", { name: "Assign to for Started acceptance 1" })
    ).toContainText("Alice Admin", { timeout: 60000 })
    await list(admin)
    for (const number of [2, 3])
      await admin
        .getByRole("checkbox", { name: `Select ENG-${number}`, exact: true })
        .check()
    await admin.getByRole("button", { name: "Actions", exact: true }).click()
    await admin
      .getByRole("button", { name: "Set selected status", exact: true })
      .click()
    await admin.getByRole("option", { name: "In Review", exact: true }).click()
    await saved(2, "in-review", users[0])
    await saved(3, "in-review", users[1])
    expect((await row(2)).properties.activity).toHaveLength(1)
    expect(
      (await row(3)).properties.activity[0].automaticAssignment
    ).toBeUndefined()
    await list(member)
    await status(member, 4, "In Progress")
    await saved(4, "in-progress", null)
    await list(admin)
    await member
      .getByRole("button", {
        name: "Assign to for Started acceptance 5",
        exact: true,
      })
      .click()
    await member
      .getByRole("option", { name: "Bob Member", exact: true })
      .click()
    await saved(5, "todo", users[1])
    await status(admin, 5, "In Progress")
    await expect(
      admin.getByRole("button", {
        name: "Apply my edits to latest",
        exact: true,
      })
    ).toBeVisible({ timeout: 30000 })
    expect((await row(5)).assignee_id).toBe(users[1])
    expect((await row(5)).status_id).toBe("todo")
    await admin
      .getByRole("button", { name: "Apply my edits to latest", exact: true })
      .click()
    await saved(5, "in-progress", users[1])
    mkdirSync("/tmp/for139-browser", { recursive: true })
    await admin.screenshot({
      path: "/tmp/for139-browser/started-assignment.png",
      fullPage: true,
    })
    expect(errors).toEqual([])
    console.log(
      JSON.stringify({
        passed: [
          "saved opt-in survives reload and is account-isolated",
          "single status edit assigns and displays one combined activity",
          "bulk edit assigns eligible issue and preserves existing owner",
          "other actor's disabled preference does not assign",
          "visible stale conflict and explicit rebase preserve concurrent assignee",
        ],
        environment: base,
      })
    )
  }
} finally {
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM session WHERE active_organization_id=$1", [
      marker,
    ])
    await pool.query("DELETE FROM organization WHERE id=$1", [marker])
    for (const id of users)
      await pool.query('DELETE FROM "user" WHERE id=$1', [id])
    const remaining = (
      await pool.query(
        `SELECT (SELECT count(*)::int FROM "user" WHERE id=ANY($1)) users,(SELECT count(*)::int FROM organization WHERE id=$2) workspaces,(SELECT count(*)::int FROM command_receipts WHERE workspace_id=$2) receipts,(SELECT count(*)::int FROM account_preferences WHERE user_id=ANY($1)) preferences`,
        [users, marker]
      )
    ).rows[0]
    expect(remaining).toEqual({
      users: 0,
      workspaces: 0,
      receipts: 0,
      preferences: 0,
    })
    console.log(JSON.stringify({ cleanup: remaining }))
  }
  await pool.end()
}

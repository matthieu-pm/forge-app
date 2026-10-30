import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file =
  process.env.FORGE_ISSUE_LIFECYCLE_TEST_DATABASE_FILE ??
  process.env.FORGE_AUTO_ASSIGNMENT_TEST_DATABASE_FILE
if (!file)
  throw new Error("FORGE_ISSUE_LIFECYCLE_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_auto_assignment_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base =
    process.env.FORGE_ISSUE_LIFECYCLE_BROWSER_URL ?? "http://localhost:3143",
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
  marker = `for45-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for45-${crypto.randomUUID()}`,
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
    identity.database !== "forge_auto_assignment_acceptance" ||
    identity.branch !== "br-autumn-union-za0opf1e"
  )
    throw new Error("Wrong database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR45 Acceptance',$1)",
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
  const id = crypto.randomUUID(),
    child = crypto.randomUUID()
  await pool.query(
    "INSERT INTO issues(id,workspace_id,team_id,number,title,creator_id,properties) VALUES($1,$3,$4,1,'Lifecycle Alpha',$5,$6),($2,$3,$4,2,'Surviving child',$5,'{}')",
    [
      id,
      child,
      marker,
      teamId,
      users[1],
      JSON.stringify({
        description: "Private description",
        subscribers: users.join(","),
        comments: [
          {
            id: crypto.randomUUID(),
            author: users[1],
            body: "Recoverable comment",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    ]
  )
  await pool.query("UPDATE issues SET parent_id=$1 WHERE id=$2", [id, child])
  const go = async (page) => {
    await page.goto(`${base}/teams/engineering/issues?view=all&issue=${id}`)
    await expect(
      page.getByRole("textbox", { name: "Issue title", exact: true })
    ).toHaveValue("Lifecycle Alpha", { timeout: 60000 })
  }
  await go(member)
  await go(admin)
  const menu = async () => {
    await member
      .getByRole("button", { name: "Issue options", exact: true })
      .click()
  }
  await menu()
  await member
    .getByRole("menuitem", { name: "Delete issue…", exact: true })
    .click()
  await member
    .getByRole("dialog")
    .getByRole("button", { name: "Delete issue", exact: true })
    .click()
  await expect(
    member.getByRole("textbox", { name: "Issue title", exact: true })
  ).toHaveCount(0)
  await admin.reload()
  await expect(
    admin.getByRole("textbox", { name: "Issue title", exact: true })
  ).toHaveCount(0)
  await expect(
    admin.getByText("This issue is unavailable or you no longer have access.", {
      exact: false,
    })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    admin.getByText("Recoverable comment", { exact: true })
  ).toHaveCount(0)
  const recovery = async (kind = "Deleted") => {
    await member
      .getByRole("button", { name: "Archived and deleted", exact: true })
      .click()
    await member
      .getByRole("dialog")
      .getByRole("button", { name: kind, exact: true })
      .click()
    await expect(
      member
        .getByRole("dialog")
        .getByText("#1 · Lifecycle Alpha", { exact: true })
    ).toBeVisible()
  }
  await recovery()
  await member.screenshot({ path: "/tmp/for45-recovery.png", fullPage: true })
  await member
    .getByRole("dialog")
    .getByRole("button", { name: "Restore", exact: true })
    .click()
  await expect(
    member.getByRole("dialog").getByText("No deleted issues.", { exact: true })
  ).toBeVisible()
  await member.keyboard.press("Escape")
  await go(member)
  await expect(
    member.getByText("Recoverable comment", { exact: true })
  ).toBeVisible()
  await menu()
  await member
    .getByRole("menuitem", { name: "Archive issue", exact: true })
    .click()
  await expect(
    member.getByRole("textbox", { name: "Issue title", exact: true })
  ).toHaveCount(0)
  await recovery("Archived")
  await member
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click()
  await member
    .getByRole("dialog")
    .getByRole("button", { name: "Delete issue", exact: true })
    .click()
  await expect(
    member.getByRole("dialog").getByText("No archived issues.", { exact: true })
  ).toBeVisible()
  await member
    .getByRole("dialog")
    .getByRole("button", { name: "Deleted", exact: true })
    .click()
  await expect(
    member
      .getByRole("dialog")
      .getByText("Restores to archive", { exact: false })
  ).toBeVisible()
  await member
    .getByRole("dialog")
    .getByRole("button", { name: "Restore", exact: true })
    .click()
  await expect(
    member.getByRole("dialog").getByText("No deleted issues.", { exact: true })
  ).toBeVisible()
  await member
    .getByRole("dialog")
    .getByRole("button", { name: "Archived", exact: true })
    .click()
  await expect(
    member
      .getByRole("dialog")
      .getByText("#1 · Lifecycle Alpha", { exact: true })
  ).toBeVisible()
  await member
    .getByRole("dialog")
    .getByRole("button", { name: "Unarchive", exact: true })
    .click()
  await expect(
    member.getByRole("dialog").getByText("No archived issues.", { exact: true })
  ).toBeVisible()
  await member.keyboard.press("Escape")
  await go(member)
  // Stale revision is visible and never deletes the concurrent edit.
  await pool.query("UPDATE issues SET title='Concurrent change' WHERE id=$1", [
    id,
  ])
  await menu()
  await member
    .getByRole("menuitem", { name: "Delete issue…", exact: true })
    .click()
  await member
    .getByRole("dialog")
    .getByRole("button", { name: "Delete issue", exact: true })
    .click()
  await expect(member.getByRole("dialog").getByRole("alert")).toContainText(
    "This issue changed. Reload and review it before trying again."
  )
  expect(
    (await pool.query("SELECT deleted_at FROM issues WHERE id=$1", [id]))
      .rows[0].deleted_at
  ).toBeNull()
  await member.keyboard.press("Escape")
  await member.reload()
  await expect(
    member.getByRole("textbox", { name: "Issue title", exact: true })
  ).toHaveValue("Concurrent change")
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-45",
      environment: identity,
      passed: true,
      checks: [
        "two real Better Auth sessions",
        "member deletes and restores",
        "second account old link hides private content",
        "comments survive restore",
        "archive and unarchive from recovery dialog",
        "archived issue deletion and restore preserve archive state",
        "stale revision refusal preserves concurrent edit",
      ],
    })
  )
} finally {
  await browser?.close()
  if (verified) {
    // Closing the browser does not cancel already-running server transactions.
    // Retry only serialization/deadlock rollbacks of this exact owned fixture.
    for (let attempt = 0; ; attempt++) {
      try {
        await pool.query("DELETE FROM organization WHERE id=$1", [marker])
        break
      } catch (error) {
        if (attempt >= 4 || !["40P01", "40001"].includes(error?.code))
          throw error
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
      }
    }
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    const leftovers = (
      await pool.query(
        'SELECT (SELECT count(*)::int FROM organization WHERE id=$1) workspaces,(SELECT count(*)::int FROM "user" WHERE id=ANY($2)) users,(SELECT count(*)::int FROM command_receipts WHERE workspace_id=$1) receipts',
        [marker, users]
      )
    ).rows[0]
    expect(leftovers).toEqual({ workspaces: 0, users: 0, receipts: 0 })
    console.log(JSON.stringify({ cleanup: leftovers }))
  }
  await pool.end()
}

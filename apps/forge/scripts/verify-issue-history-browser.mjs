import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file = process.env.FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE
if (!file) throw new Error("FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_issue_history_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base =
    process.env.FORGE_ISSUE_HISTORY_BROWSER_URL ?? "http://localhost:3149",
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
  marker = `for49-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for49-${crypto.randomUUID()}`,
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
    identity.database !== "forge_issue_history_acceptance" ||
    identity.branch !== "br-autumn-union-za0opf1e"
  )
    throw new Error("Wrong database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR49 Acceptance',$1)",
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
  const id = crypto.randomUUID()
  await pool.query(
    "INSERT INTO issues(id,workspace_id,team_id,number,title,creator_id,properties) VALUES($1,$2,$3,1,'History Alpha',$4,'{}')",
    [id, marker, teamId, users[1]]
  )
  const go = async (page) => {
    await page.goto(`${base}/teams/engineering/issues?view=all&issue=${id}`)
    await expect(
      page.getByRole("textbox", { name: "Issue title", exact: true })
    ).toHaveValue("History Alpha", { timeout: 60000 })
  }
  await go(member)
  await member
    .getByRole("button", {
      name: "Change status for History Alpha",
      exact: true,
    })
    .click()
  await member.getByRole("option", { name: "Done", exact: true }).click()
  const history = (page) =>
    page.getByLabel("Committed issue history", { exact: true })
  await expect(history(member)).toContainText("status from Backlog to Done", {
    timeout: 30000,
  })
  const composer = member.getByRole("textbox", { name: "Comment", exact: true })
  await composer.fill("Current discussion body")
  await member
    .getByRole("button", { name: "Submit comment", exact: true })
    .click()
  await expect(history(member)).toContainText("Bob Member added a comment", {
    timeout: 30000,
  })
  await go(admin)
  await expect(history(admin)).toContainText(
    "Bob Member updated the issue: status from Backlog to Done",
    { timeout: 30000 }
  )
  await expect(history(admin)).toContainText("Bob Member added a comment")
  const rows = history(admin).locator("[data-activity-row]")
  expect(await rows.count()).toBe(2)
  expect(await rows.nth(0).innerText()).toContain("updated the issue")
  expect(await rows.nth(1).innerText()).toContain("added a comment")
  const stored = (
    await pool.query(
      "SELECT properties->'comments' comments FROM issues WHERE id=$1",
      [id]
    )
  ).rows[0].comments
  const commentId = stored[0].id
  const root = admin.locator(`[id="comment-${commentId}"]`)
  await root
    .getByRole("button", { name: "Comment options", exact: true })
    .first()
    .click()
  await admin
    .getByRole("menuitem", { name: "Delete comment", exact: true })
    .click()
  await expect(history(admin)).toContainText("Alice Admin deleted a comment", {
    timeout: 30000,
  })
  await expect(root).toContainText("Comment deleted")
  await member.reload()
  await expect(history(member)).toContainText("Alice Admin deleted a comment", {
    timeout: 60000,
  })
  await expect(
    member.getByText("Current discussion body", { exact: true })
  ).toHaveCount(0)
  const idsBefore = await history(member)
    .locator("[data-activity-row]")
    .evaluateAll((nodes) => nodes.map((node) => node.id))
  await member
    .getByRole("button", { name: "Refresh history", exact: true })
    .click()
  await expect(history(member).locator("[data-activity-row]")).toHaveCount(3)
  expect(
    await history(member)
      .locator("[data-activity-row]")
      .evaluateAll((nodes) => nodes.map((node) => node.id))
  ).toEqual(idsBefore)
  await member.screenshot({
    path:
      process.env.FORGE_ISSUE_HISTORY_SCREENSHOT ?? "/tmp/for49-history.png",
    fullPage: true,
  })
  await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
    teamId,
  ])
  await pool.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [
    teamId,
    users[1],
  ])
  await member
    .getByRole("button", { name: "Refresh history", exact: true })
    .click()
  await expect(history(member).getByRole("alert")).toContainText(
    "History could not be loaded",
    { timeout: 30000 }
  )
  await expect(history(member).locator("[data-activity-row]")).toHaveCount(0)
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-49",
      environment: identity,
      passed: true,
      checks: [
        "two authenticated readers",
        "status then comment in committed order",
        "verified actor names",
        "moderator attribution and body redaction",
        "stable refresh IDs",
        "access revocation clears history",
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

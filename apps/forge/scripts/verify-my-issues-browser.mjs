import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file = process.env.FORGE_MY_ISSUES_TEST_DATABASE_FILE
if (!file) throw new Error("FORGE_MY_ISSUES_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_issue_history_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base = process.env.FORGE_MY_ISSUES_BROWSER_URL ?? "http://localhost:3151",
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
  marker = `for51-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for51-${crypto.randomUUID()}`,
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
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR51 Acceptance',$1)",
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
    browser.newContext({ viewport: { width: 1280, height: 900 } }),
  ])
  for (let i = 0; i < contexts.length; i++) {
    const login = await contexts[i].request.post(
      `${base}/api/auth/sign-in/email`,
      {
        data: { email: `${users[i === 0 ? 0 : 1]}@example.test`, password },
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
  const [admin, bob, bob2] = await Promise.all(contexts.map((c) => c.newPage()))
  const errors = []
  for (const page of [admin, bob, bob2])
    page.on("pageerror", (e) => errors.push(e.message))
  const assignedId = crypto.randomUUID(),
    ownId = crypto.randomUUID()
  await pool.query(
    "INSERT INTO issues(id,workspace_id,team_id,number,title,creator_id,properties) VALUES($1,$2,$3,1,'Shared personal issue',$4,'{}'),($5,$2,$3,2,'Bob created issue',$6,jsonb_build_object('subscribers',$6::text))",
    [assignedId, marker, teamId, users[0], ownId, users[1]]
  )
  const title = (page) =>
    page.getByRole("textbox", { name: "Issue title", exact: true })
  const row = (page, text = "Shared personal issue") =>
    page.getByRole("button", { name: `Open ENG-1 ${text}`, exact: true })
  const go = async (page, path) => {
    await page.goto(`${base}${path}`)
    await expect(
      page.getByRole("heading", { name: "My issues", exact: true })
    ).toBeVisible({ timeout: 60000 })
  }
  const personal = (view, id) =>
    `/my-issues?view=${view}${id ? `&issue=${id}` : ""}`
  await admin.goto(
    `${base}/teams/engineering/issues?view=all&issue=${assignedId}`
  )
  await expect(title(admin)).toHaveValue("Shared personal issue", {
    timeout: 60000,
  })
  await admin
    .getByRole("button", {
      name: "Assign to for Shared personal issue",
      exact: true,
    })
    .click()
  await admin.getByRole("option", { name: "Bob Member", exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          await pool.query("SELECT assignee_id FROM issues WHERE id=$1", [
            assignedId,
          ])
        ).rows[0].assignee_id
    )
    .toBe(users[1])
  for (const page of [bob, bob2]) {
    await go(page, personal("assigned"))
    await expect(row(page)).toBeVisible({ timeout: 30000 })
    await row(page).click()
    await expect(title(page)).toHaveValue("Shared personal issue")
    expect(new URL(page.url()).searchParams.get("issue")).toBe(assignedId)
  }
  await title(bob2).fill("Edited in My issues")
  await title(bob2).press("Enter")
  await expect
    .poll(
      async () =>
        (await pool.query("SELECT title FROM issues WHERE id=$1", [assignedId]))
          .rows[0].title
    )
    .toBe("Edited in My issues")
  await admin.reload()
  await expect(title(admin)).toHaveValue("Edited in My issues", {
    timeout: 60000,
  })
  await bob.reload()
  await expect(title(bob)).toHaveValue("Edited in My issues", {
    timeout: 60000,
  })
  await bob
    .getByRole("button", { name: "Subscribe to issue", exact: true })
    .click()
  await expect(
    bob.getByRole("button", { name: "Unsubscribe from issue", exact: true })
  ).toBeEnabled()
  // Use the actual tab links; account preferences and query caches stay live.
  await go(bob2, personal("subscribed"))
  await expect(row(bob2, "Edited in My issues")).toBeVisible({ timeout: 30000 })
  await expect(
    bob2.getByRole("button", {
      name: "Open ENG-2 Bob created issue",
      exact: true,
    })
  ).toBeVisible()
  await bob2.getByRole("link", { name: "Created", exact: true }).click()
  await expect(
    bob2.getByRole("button", {
      name: "Open ENG-2 Bob created issue",
      exact: true,
    })
  ).toBeVisible()
  await expect(row(bob2, "Edited in My issues")).toHaveCount(0)
  await bob2.getByRole("link", { name: "Subscribed", exact: true }).click()
  await row(bob2, "Edited in My issues").click()
  await bob2
    .getByRole("button", { name: "Unsubscribe from issue", exact: true })
    .click()
  await expect(
    bob2.getByRole("button", { name: "Subscribe to issue", exact: true })
  ).toBeEnabled()
  // Browser one refreshes its open direct detail through the provider's focus path.
  await bob.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(
    bob.getByRole("button", { name: "Subscribe to issue", exact: true })
  ).toBeEnabled({ timeout: 30000 })
  await go(bob, personal("subscribed"))
  await expect(row(bob, "Edited in My issues")).toHaveCount(0)
  await bob.getByRole("link", { name: "Assigned", exact: true }).click()
  await expect(row(bob, "Edited in My issues")).toBeVisible()
  await bob.getByRole("button", { name: "Open details", exact: true }).click()
  await row(bob, "Edited in My issues").click()
  await expect(
    bob.getByRole("complementary", { name: "Issue details" })
  ).toContainText("Edited in My issues")
  await expect(
    bob.getByRole("button", { name: "New issue", exact: true })
  ).toBeEnabled()
  await expect(
    bob.getByText("Saving preferences…", { exact: true })
  ).toHaveCount(0, { timeout: 30000 })
  await expect(bob.getByText("Saving changes…", { exact: true })).toHaveCount(
    0,
    { timeout: 30000 }
  )
  await bob.screenshot({
    path: process.env.FORGE_MY_ISSUES_SCREENSHOT ?? "/tmp/for51-my-issues.png",
    fullPage: true,
  })
  // Keep browser two's full detail open, and browser one's preview cached.
  await bob2.goto(`${base}${personal("assigned", assignedId)}`)
  await expect(title(bob2)).toHaveValue("Edited in My issues", {
    timeout: 60000,
  })
  const comment = bob2.getByRole("textbox", { name: "Comment", exact: true })
  await comment.fill("Unsent personal comment survives refresh")
  const editor = await comment.elementHandle()
  await bob2.evaluate(() => window.dispatchEvent(new Event("focus")))
  // Cross an actual metadata polling interval as well as the focus refresh.
  await bob2.waitForTimeout(32_000)
  expect(await editor.evaluate((node) => node.isConnected)).toBe(true)
  await expect(comment).toHaveText("Unsent personal comment survives refresh")
  await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
    teamId,
  ])
  await pool.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [
    teamId,
    users[1],
  ])
  await bob.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(row(bob, "Edited in My issues")).toHaveCount(0)
  await expect(
    bob.getByRole("complementary", { name: "Issue details" })
  ).not.toContainText("Edited in My issues")
  await bob2.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(title(bob2)).toHaveCount(0, { timeout: 30000 })
  await expect(
    bob2.getByText(/This issue is no longer available/)
  ).toBeVisible()
  // SPA tab switches must not restore another tab's cached private row.
  for (const view of ["Created", "Subscribed", "Assigned", "Activity"]) {
    await bob.getByRole("link", { name: view, exact: true }).click()
    await expect(bob.getByText("0 of 0 issues", { exact: true })).toBeVisible({
      timeout: 30000,
    })
    await expect(
      bob.getByText("Edited in My issues", { exact: true })
    ).toHaveCount(0)
    await expect(
      bob.getByText("Bob created issue", { exact: true })
    ).toHaveCount(0)
  }
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-51",
      environment: identity,
      passed: true,
      checks: [
        "Alice assigns and two independent Bob browsers open the same canonical ID",
        "My issues edits shared with team detail and another device",
        "Created and Subscribed tabs use durable actor-owned state",
        "Subscribe/unsubscribe changes propagate through focus refresh",
        "Assigned details preview uses the canonical row",
        "Authorized focus and periodic refresh retain the same personal comment editor and unsent text",
        "Private membership revocation removes list, preview and full detail",
        "SPA tab switches cannot resurrect revoked personal issues",
        "No browser page errors",
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

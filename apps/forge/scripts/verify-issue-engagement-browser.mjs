import { readFileSync } from "node:fs"
import { chromium, expect as baseExpect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const expect = baseExpect.configure({ timeout: 20000 })
const file =
  process.env.FORGE_ISSUE_ENGAGEMENT_TEST_DATABASE_FILE ??
  process.env.FORGE_AUTO_ASSIGNMENT_TEST_DATABASE_FILE
if (!file)
  throw new Error("FORGE_ISSUE_ENGAGEMENT_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_auto_assignment_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base =
    process.env.FORGE_ISSUE_ENGAGEMENT_BROWSER_URL ?? "http://localhost:3147",
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
  marker = `for47-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for47-${crypto.randomUUID()}`,
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
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR47 Acceptance',$1)",
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
  const [admin, member, secondBrowser] = await Promise.all(
    contexts.map((c) => c.newPage())
  )
  const errors = []
  for (const page of [admin, member, secondBrowser])
    page.on("pageerror", (e) => errors.push(e.message))
  const id = crypto.randomUUID()
  await pool.query(
    "INSERT INTO issues(id,workspace_id,team_id,number,title,creator_id,properties) VALUES($1,$2,$3,1,'Reaction Alpha',$4,'{}')",
    [id, marker, teamId, users[1]]
  )
  const go = async (page) => {
    await page.goto(`${base}/teams/engineering/issues?view=all&issue=${id}`)
    await expect(
      page.getByRole("textbox", { name: "Issue title", exact: true })
    ).toHaveValue("Reaction Alpha", { timeout: 60000 })
  }
  await go(admin)
  await admin
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Acknowledge this shared comment")
  await admin
    .getByRole("button", { name: "Submit comment", exact: true })
    .click()
  await expect(
    admin.getByRole("textbox", { name: "Comment", exact: true })
  ).toHaveText("")
  const stored = (
    await pool.query(
      "SELECT properties->'comments' comments FROM issues WHERE id=$1",
      [id]
    )
  ).rows[0].comments
  const commentId = stored[0].id
  const root = (page) => page.locator(`[id="comment-${commentId}"]`)
  const reaction = (page, count) =>
    root(page).getByRole("button", {
      name: `👍: ${count} reactions`,
      exact: true,
    })
  const choose = async (page) => {
    await root(page)
      .getByRole("button", { name: "React to comment", exact: true })
      .click()
    await page
      .getByRole("textbox", { name: "Search emoji", exact: true })
      .fill("thumbs up")
    await page.getByRole("button", { name: "thumbs up", exact: true }).click()
  }
  await go(member)
  await expect(
    member.getByRole("button", { name: "Change subscribers", exact: true })
  ).toHaveCount(0)
  await member
    .getByRole("button", { name: "Subscribe to issue", exact: true })
    .click()
  await expect(
    member.getByRole("button", { name: "Unsubscribe from issue", exact: true })
  ).toBeEnabled()
  await choose(member)
  await expect(reaction(member, 1)).toHaveAttribute("aria-pressed", "true")
  await go(secondBrowser)
  await expect(
    secondBrowser.getByRole("button", {
      name: "Unsubscribe from issue",
      exact: true,
    })
  ).toBeVisible()
  await expect(reaction(secondBrowser, 1)).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  await admin.reload()
  await expect(reaction(admin, 1)).toHaveAttribute("aria-pressed", "false")
  await choose(admin)
  await expect(reaction(admin, 2)).toHaveAttribute("aria-pressed", "true")
  await member.reload()
  await expect(reaction(member, 2)).toHaveAttribute("aria-pressed", "true")
  await member
    .getByRole("button", { name: "Unsubscribe from issue", exact: true })
    .click()
  await expect(
    member.getByRole("button", { name: "Subscribe to issue", exact: true })
  ).toBeEnabled()
  // Drop only the response after the actual server commit, then reload and
  // explicitly replay the persisted command instead of inverting the new state.
  let dropped = false
  await member.route("**/*", async (route) => {
    const req = route.request()
    if (
      !dropped &&
      req.method() === "POST" &&
      req.postData()?.includes("emoji") &&
      req.postData()?.includes("reaction") &&
      !req.postData()?.includes("forge:issue-engagement-draft")
    ) {
      dropped = true
      await route.fetch()
      await route.abort("failed")
    } else await route.continue()
  })
  await reaction(member, 2).click()
  await expect(
    member.getByRole("button", { name: "Retry discussion change", exact: true })
  ).toBeVisible()
  await expect.poll(() => dropped).toBe(true)
  await member.unroute("**/*")
  await member.reload()
  await expect(
    member.getByRole("button", { name: "Retry discussion change", exact: true })
  ).toBeVisible({ timeout: 60000 })
  await expect(reaction(member, 1)).toHaveAttribute("aria-pressed", "false")
  await member
    .getByRole("button", { name: "Retry discussion change", exact: true })
    .click()
  await expect(
    member.getByRole("button", { name: "Retry discussion change", exact: true })
  ).toHaveCount(0)
  await expect(reaction(member, 1)).toHaveAttribute("aria-pressed", "false")
  await secondBrowser.reload()
  await expect(
    secondBrowser.getByRole("button", {
      name: "Subscribe to issue",
      exact: true,
    })
  ).toBeVisible()
  await expect(reaction(secondBrowser, 1)).toHaveAttribute(
    "aria-pressed",
    "false"
  )
  await admin
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("A later direct mention ")
  await admin
    .getByRole("button", { name: "Mention a person", exact: true })
    .click()
  await admin.getByRole("button", { name: "Bob Member", exact: true }).click()
  await admin
    .getByRole("button", { name: "Submit comment", exact: true })
    .click()
  await expect(
    admin.getByRole("textbox", { name: "Comment", exact: true })
  ).toHaveText("")
  const final = (
    await pool.query("SELECT properties FROM issues WHERE id=$1", [id])
  ).rows[0].properties
  expect(final.subscribers).toBe("")
  expect(final.comments[0].body).toBe("Acknowledge this shared comment")
  expect(final.comments[0].reactions).toEqual([
    { emoji: "👍", users: [users[0]] },
  ])
  const events = (
    await pool.query(
      "SELECT topic,payload FROM command_outbox_events WHERE workspace_id=$1",
      [marker]
    )
  ).rows
  expect(
    events.filter((e) => e.topic === "issue.reaction.changed")
  ).toHaveLength(3)
  expect(
    events.filter((e) => e.topic === "issue.subscription.changed")
  ).toHaveLength(2)
  expect(
    events
      .filter((e) => e.topic === "issue.comment.mentioned")
      .map((e) => e.payload.recipientId)
  ).toEqual([users[1]])
  await member.screenshot({
    path:
      process.env.FORGE_ISSUE_ENGAGEMENT_SCREENSHOT ??
      "/tmp/for47-discussion.png",
    fullPage: true,
  })
  await member.setViewportSize({ width: 390, height: 844 })
  await expect(reaction(member, 1)).toBeVisible()
  expect(
    await member.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-47",
      environment: identity,
      passed: true,
      checks: [
        "three real sessions with two independent browsers for Bob",
        "subscription and one reaction survive a second browser login",
        "separate actors share reactions without replacing each other",
        "unsubscribe preserves discussion and direct mention producer events",
        "post-commit lost response and reload replay never resurrect removed reaction",
        "shared subscriber management cannot edit other users",
        "mobile viewport and no page errors",
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

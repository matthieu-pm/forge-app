import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file =
  process.env.FORGE_ISSUE_COMMENT_TEST_DATABASE_FILE ??
  process.env.FORGE_AUTO_ASSIGNMENT_TEST_DATABASE_FILE
if (!file) throw new Error("FORGE_ISSUE_COMMENT_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_auto_assignment_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base =
    process.env.FORGE_ISSUE_COMMENT_BROWSER_URL ?? "http://localhost:3146",
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
  marker = `for46-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for46-${crypto.randomUUID()}`,
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
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR46 Acceptance',$1)",
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
    "INSERT INTO issues(id,workspace_id,team_id,number,title,creator_id,properties) VALUES($1,$2,$3,1,'Comment Alpha',$4,'{}')",
    [id, marker, teamId, users[1]]
  )
  const go = async (page) => {
    await page.goto(`${base}/teams/engineering/issues?view=all&issue=${id}`)
    await expect(
      page.getByRole("textbox", { name: "Issue title", exact: true })
    ).toHaveValue("Comment Alpha", { timeout: 60000 })
  }
  await go(member)
  const composer = member.getByRole("textbox", { name: "Comment", exact: true })
  await member.getByRole("button", { name: "Bold", exact: true }).click()
  await composer.fill("Shared rich discussion ")
  await member
    .getByRole("button", { name: "Mention a person", exact: true })
    .click()
  await member.getByRole("button", { name: "Alice Admin", exact: true }).click()
  await member
    .getByRole("button", { name: "Submit comment", exact: true })
    .click()
  await expect(
    member.getByText("Shared rich discussion", { exact: false }).first()
  ).toBeVisible()
  await expect(composer).toHaveText("")
  await go(admin)
  await expect(admin.getByText("@Alice Admin", { exact: true })).toBeVisible()
  const stored = (
    await pool.query(
      "SELECT properties->'comments' comments FROM issues WHERE id=$1",
      [id]
    )
  ).rows[0].comments
  expect(stored).toHaveLength(1)
  expect(stored[0].author).toBe(users[1])
  const commentId = stored[0].id
  const root = (page) => page.locator(`[id="comment-${commentId}"]`)
  await expect(root(admin).locator("strong")).toContainText([
    "Shared rich discussion",
  ])
  await root(member)
    .getByRole("textbox", { name: "Reply", exact: true })
    .fill("Durable reply")
  await root(member)
    .getByRole("button", { name: "Submit reply", exact: true })
    .click()
  await expect(
    root(member).getByRole("textbox", { name: "Reply", exact: true }).first()
  ).toHaveText("")
  await root(admin)
    .getByRole("button", { name: "Comment options", exact: true })
    .first()
    .click()
  await admin
    .getByRole("menuitem", { name: "Edit comment", exact: true })
    .click()
  await admin
    .getByRole("textbox", { name: "Edit comment", exact: true })
    .fill("Admin edited discussion")
  await admin.getByRole("button", { name: "Save comment", exact: true }).click()
  await expect(
    admin.getByRole("textbox", { name: "Edit comment", exact: true })
  ).toHaveCount(0)
  await member.reload()
  await expect(
    root(member).getByText("Admin edited discussion", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  const metadata = (
    await pool.query(
      "SELECT properties->'comments'->0 c FROM issues WHERE id=$1",
      [id]
    )
  ).rows[0].c
  expect(metadata.author).toBe(users[1])
  expect(metadata.editedBy).toBe(users[0])
  await root(admin)
    .getByRole("button", { name: "Comment options", exact: true })
    .first()
    .click()
  await admin
    .getByRole("menuitem", { name: "Delete comment", exact: true })
    .click()
  await expect(
    root(admin).getByText("Comment deleted", { exact: true })
  ).toBeVisible()
  await expect(
    root(admin).getByText("Durable reply", { exact: true })
  ).toBeVisible()
  await root(admin)
    .getByRole("button", { name: "Comment options", exact: true })
    .first()
    .click()
  await admin
    .getByRole("menuitem", { name: "Restore comment", exact: true })
    .click()
  await expect(
    root(admin).getByText("Admin edited discussion", { exact: true })
  ).toBeVisible()
  // A response is deliberately lost AFTER the server has committed the comment.
  let dropped = false
  await member.route("**/*", async (route) => {
    const req = route.request()
    if (
      !dropped &&
      req.method() === "POST" &&
      req.postData()?.includes("Lost response discussion") &&
      req.postData()?.includes("commentId")
    ) {
      dropped = true
      await route.fetch()
      await route.abort("failed")
    } else await route.continue()
  })
  await member
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Lost response discussion")
  await member
    .getByRole("button", { name: "Submit comment", exact: true })
    .click()
  await expect.poll(() => dropped).toBe(true)
  await expect(
    member.getByRole("button", { name: "Submit comment", exact: true })
  ).toHaveCount(1)
  await expect(
    member.getByRole("button", { name: "Submit comment", exact: true })
  ).toHaveText("Retry comment")
  await member.unroute("**/*")
  await member.reload()
  await expect(
    member.getByRole("button", { name: "Submit comment", exact: true })
  ).toHaveText("Retry comment", { timeout: 60000 })
  await member
    .getByRole("button", { name: "Submit comment", exact: true })
    .click()
  await expect(
    member.getByRole("textbox", { name: "Comment", exact: true })
  ).toHaveText("")
  const afterRetry = (
    await pool.query(
      "SELECT properties->'comments' c FROM issues WHERE id=$1",
      [id]
    )
  ).rows[0].c
  expect(
    afterRetry.filter((c) => c.body === "Lost response discussion")
  ).toHaveLength(1)
  // Reload hostile stored JSON; no executable nodes/attributes/unsafe links become DOM.
  const malicious = {
    id: crypto.randomUUID(),
    author: users[1],
    body: '<img src=x onerror="window.for46Executed=true"> unsafe fixture',
    createdAt: new Date().toISOString(),
    document: {
      type: "doc",
      content: [{ type: "script", text: "window.for46Executed=true" }],
    },
  }
  await pool.query(
    "UPDATE issues SET properties=jsonb_set(properties,'{comments}',(properties->'comments') || $2::jsonb) WHERE id=$1",
    [id, JSON.stringify([malicious])]
  )
  await admin.reload()
  await expect(admin.getByText(malicious.body, { exact: true })).toBeVisible({
    timeout: 60000,
  })
  expect(await admin.evaluate(() => Boolean(window.for46Executed))).toBe(false)
  const unsafe = admin.locator(`[id="comment-${malicious.id}"]`)
  await expect(
    unsafe.locator('script,img,[onerror],a[href^="javascript:"]')
  ).toHaveCount(0)
  const hostileNodes = [
    {
      type: "paragraph",
      attrs: { onclick: "window.for46Executed=true" },
      content: [{ type: "text", text: "Event handler fixture" }],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Unsafe link fixture",
          marks: [
            {
              type: "link",
              attrs: { href: "javascript:window.for46Executed=true" },
            },
          ],
        },
      ],
    },
  ]
  const hostile = hostileNodes.map((node, index) => ({
    id: crypto.randomUUID(),
    author: users[1],
    body: `Hostile stored fixture ${index}`,
    createdAt: new Date().toISOString(),
    document: { type: "doc", content: [node] },
  }))
  await pool.query(
    "UPDATE issues SET properties=jsonb_set(properties,'{comments}',(properties->'comments') || $2::jsonb) WHERE id=$1",
    [id, JSON.stringify(hostile)]
  )
  await admin.reload()
  for (const c of hostile) {
    await expect(admin.getByText(c.body, { exact: true })).toBeVisible({
      timeout: 60000,
    })
    await expect(
      admin
        .locator(`[id="comment-${c.id}"]`)
        .locator('script,img,[onclick],a[href^="javascript:"]')
    ).toHaveCount(0)
  }
  expect(await admin.evaluate(() => Boolean(window.for46Executed))).toBe(false)
  await admin.screenshot({ path: "/tmp/for46-discussion.png", fullPage: true })
  // Private-team picker excludes a current workspace member without team access.
  await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
    teamId,
  ])
  await pool.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [
    teamId,
    users[1],
  ])
  await admin
    .getByRole("button", { name: "Mention a person", exact: true })
    .last()
    .click()
  await admin
    .getByRole("textbox", { name: "Find people to mention", exact: true })
    .fill("Bob")
  await expect(
    admin.getByRole("button", { name: "Bob Member", exact: true })
  ).toHaveCount(0)
  const events = (
    await pool.query(
      "SELECT topic,payload FROM command_outbox_events WHERE workspace_id=$1 AND topic LIKE 'issue.comment.%'",
      [marker]
    )
  ).rows
  expect(
    events.filter((e) => e.topic === "issue.comment.mentioned")
  ).toHaveLength(1)
  expect(
    events.find((e) => e.topic === "issue.comment.mentioned").payload
      .recipientId
  ).toBe(users[0])
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-46",
      environment: identity,
      passed: true,
      checks: [
        "two Better Auth sessions and reload",
        "eligible mention persisted atomically",
        "rich formatting and replies persist",
        "admin edit preserves original author",
        "delete and restore retain replies",
        "lost response and reload replay one comment",
        "hostile stored JSON inert after reload",
        "private-team picker excludes ineligible member",
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

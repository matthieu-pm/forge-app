import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file =
  process.env.FORGE_TRIAGE_TEST_DATABASE_FILE ??
  process.env.FORGE_AUTO_ASSIGNMENT_TEST_DATABASE_FILE
if (!file) throw new Error("FORGE_TRIAGE_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_triage_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base = process.env.FORGE_TRIAGE_BROWSER_URL ?? "http://localhost:3150",
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
  marker = `for50-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for50-${crypto.randomUUID()}`,
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
    identity.database !== "forge_triage_acceptance" ||
    identity.branch !== "br-autumn-union-za0opf1e"
  )
    throw new Error("Wrong database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR50 Acceptance',$1)",
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
  const acceptedId = crypto.randomUUID(),
    racedId = crypto.randomUUID(),
    declinedId = crypto.randomUUID()
  for (const [index, id] of [acceptedId, racedId, declinedId].entries()) {
    await pool.query(
      "INSERT INTO issues(id,workspace_id,team_id,number,title,status_id,creator_id,properties) VALUES($1,$2,$3,$4,$5,'backlog',$6,$7)",
      [
        id,
        marker,
        teamId,
        index + 1,
        ["Incoming accepted", "Incoming raced", "Incoming declined"][index],
        users[0],
        JSON.stringify({
          triage: true,
          snoozed: false,
          description: "A valid incoming request",
          links: [
            {
              title: "Original source",
              url: "https://example.test/source/123",
            },
          ],
        }),
      ]
    )
  }
  await pool.query(
    "INSERT INTO team_issue_numbers(team_id,last_number) VALUES($1,3) ON CONFLICT(team_id) DO UPDATE SET last_number=greatest(team_issue_numbers.last_number,3)",
    [teamId]
  )
  // Use the real settings UI to enable the queue, then load it in both sessions.
  await admin.goto(`${base}/settings/teams/engineering/triage`)
  await expect(
    admin.getByRole("switch", { name: "Enable triage for this team" })
  ).toBeVisible({ timeout: 60000 })
  await admin
    .getByRole("switch", { name: "Enable triage for this team" })
    .click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT (encoded_value::jsonb#>>'{}')::jsonb->>'enabled' enabled FROM product_state WHERE workspace_id=$1 AND key=$2",
            [marker, `forge:team-triage:v1:${teamId}`]
          )
        ).rows[0]?.enabled,
      { timeout: 60000 }
    )
    .toBe("true")
  const go = async (page) => {
    await page.goto(`${base}/teams/engineering/triage`)
    await expect(
      page.getByRole("button", { name: "Open ENG-1 Incoming accepted" })
    ).toBeVisible({ timeout: 60000 })
  }
  await go(admin)
  await go(member)
  await member
    .getByRole("button", { name: "Open ENG-1 Incoming accepted" })
    .click()
  await expect(
    member.getByRole("link", { name: "Original source" })
  ).toHaveAttribute("href", "https://example.test/source/123")
  await member.getByRole("combobox", { name: "Acceptance status" }).click()
  await member.getByRole("option", { name: "Todo", exact: true }).click()
  await member.getByRole("combobox", { name: "Triage assignee" }).click()
  await member.getByRole("option", { name: "Bob Member", exact: true }).click()
  await member.screenshot({ path: "/tmp/for50-decision.png", fullPage: true })
  await member
    .getByRole("button", { name: "Accept issue", exact: true })
    .click()
  await expect(
    member.getByText("Saving issue changes…", { exact: true })
  ).toHaveCount(0, { timeout: 60000 })
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT properties->>'triage' triage FROM issues WHERE id=$1",
            [acceptedId]
          )
        ).rows[0].triage
    )
    .toBe("false")
  const accepted = (
    await pool.query(
      "SELECT id,number,status_id,assignee_id,properties FROM issues WHERE id=$1",
      [acceptedId]
    )
  ).rows[0]
  expect(accepted).toMatchObject({
    id: acceptedId,
    number: 1,
    status_id: "todo",
    assignee_id: users[1],
  })
  expect(accepted.properties.links).toEqual([
    { title: "Original source", url: "https://example.test/source/123" },
  ])
  // The same canonical row is visible in team work with the shared history.
  await member.goto(
    `${base}/teams/engineering/issues?view=all&issue=${acceptedId}`
  )
  await expect(
    member.getByRole("textbox", { name: "Issue title", exact: true })
  ).toHaveValue("Incoming accepted", { timeout: 60000 })
  await expect(
    member.getByText("accepted from triage", { exact: false })
  ).toBeVisible()
  await member.goto(`${base}/teams/engineering/triage`)
  await expect(
    member.getByRole("button", { name: "Open ENG-1 Incoming accepted" })
  ).toHaveCount(0)
  await admin.reload()
  await expect(
    admin.getByRole("button", { name: "Open ENG-2 Incoming raced" })
  ).toBeVisible({ timeout: 60000 })
  await admin.getByRole("button", { name: "Open ENG-2 Incoming raced" }).click()
  await member
    .getByRole("button", { name: "Open ENG-2 Incoming raced" })
    .click()
  await expect(
    admin.getByRole("button", { name: "Accept issue", exact: true })
  ).toBeEnabled()
  await expect(
    member.getByRole("button", { name: "Accept issue", exact: true })
  ).toBeEnabled()
  await Promise.all([
    admin.getByRole("button", { name: "Accept issue", exact: true }).click(),
    member.getByRole("button", { name: "Decline issue", exact: true }).click(),
  ])
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM command_outbox_events WHERE workspace_id=$1 AND topic LIKE 'issue.triage.%' AND payload->>'issueId'=$2",
            [marker, racedId]
          )
        ).rows[0].n
    )
    .toBe(1)
  await expect
    .poll(
      async () =>
        (await admin
          .getByText(/These issues changed in another session/)
          .count()) +
        (await member
          .getByText(/These issues changed in another session/)
          .count())
    )
    .toBe(1)
  const loser = (await admin
    .getByText(/These issues changed in another session/)
    .count())
    ? admin
    : member
  await expect(
    loser.getByRole("button", { name: "Apply my edits to latest" })
  ).toBeDisabled()
  await loser.getByText("Review saved issue edits").click()
  await expect(loser.getByText(/already left triage/)).toBeVisible()
  await loser.screenshot({ path: "/tmp/for50-conflict.png", fullPage: true })
  await loser.getByRole("button", { name: "Discard unavailable triage decisions" }).click()
  await expect(
    loser.getByText(/These issues changed in another session/)
  ).toHaveCount(0)
  await member.reload()
  await member
    .getByRole("button", { name: "Open ENG-3 Incoming declined" })
    .click()
  await member
    .getByRole("button", { name: "Decline issue", exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (
          await pool.query("SELECT status_id FROM issues WHERE id=$1", [
            declinedId,
          ])
        ).rows[0].status_id
    )
    .toBe("canceled")
  await member.reload()
  await expect(
    member.getByText("Nothing to triage", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  // Test canonical incoming creation as well as decisions.
  await member
    .getByRole("button", { name: "Create triage issue", exact: true })
    .click()
  await member
    .getByRole("textbox", { name: "Issue title", exact: true })
    .fill("Created in shared triage")
  await member
    .getByRole("button", { name: "Create issue", exact: true })
    .click()
  await expect(
    member.getByRole("heading", {
      name: "Created in shared triage",
      exact: true,
    })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    member.getByRole("button", { name: "Accept issue", exact: true })
  ).toBeEnabled()
  await member.screenshot({ path: "/tmp/for50-triage.png", fullPage: true })
  await admin.reload()
  await expect(
    admin.getByRole("button", { name: "Open ENG-4 Created in shared triage" })
  ).toBeVisible({ timeout: 60000 })
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-50",
      environment: identity,
      passed: true,
      checks: [
        "two Better Auth sessions",
        "same-ID accept and assignment",
        "source references",
        "team history",
        "competing decisions with visible conflict",
        "no rebase after decision",
        "decline to Canceled",
        "shared creation and reload",
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

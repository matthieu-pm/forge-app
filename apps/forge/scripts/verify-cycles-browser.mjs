import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file =
  process.env.FORGE_CYCLE_TEST_DATABASE_FILE ??
  process.env.FORGE_CYCLE_TEST_DATABASE_FILE
if (!file) throw new Error("FORGE_CYCLE_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_cycles_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base = process.env.FORGE_CYCLE_BROWSER_URL ?? "http://localhost:3155",
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
  marker = `for55-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for55-${crypto.randomUUID()}`,
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
    identity.database !== "forge_cycles_acceptance" ||
    identity.branch !== "br-autumn-union-za0opf1e"
  )
    throw new Error("Wrong database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR55 Acceptance',$1)",
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
    browser.newContext({
      viewport: { width: 1280, height: 900 },
      timezoneId: "America/Los_Angeles",
    }),
    browser.newContext({
      viewport: { width: 1280, height: 900 },
      timezoneId: "Asia/Tokyo",
    }),
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
  await admin.goto(`${base}/settings/teams/engineering/cycles`)
  await expect(
    admin.getByRole("switch", { name: "Enable cycles" })
  ).toBeEnabled({ timeout: 60000 })
  await admin.getByRole("switch", { name: "Enable cycles" }).click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM issue_cycles WHERE team_id=$1",
            [teamId]
          )
        ).rows[0].n,
      { timeout: 60000 }
    )
    .toBe(2)
  const cycles = (
    await pool.query(
      "SELECT * FROM issue_cycles WHERE team_id=$1 ORDER BY number",
      [teamId]
    )
  ).rows
  await member.goto(`${base}/settings/teams/engineering/cycles`)
  await expect(
    member.getByRole("switch", { name: "Enable cycles" })
  ).toBeDisabled({ timeout: 60000 })
  await admin.goto(`${base}/teams/engineering/cycle/upcoming`)
  await expect(
    admin
      .getByRole("main", { name: `Cycle ${cycles[0].number}`, exact: true })
      .getByRole("button", { name: "Create new issue", exact: true })
  ).toBeVisible({ timeout: 60000 })
  await admin
    .getByRole("main", { name: `Cycle ${cycles[0].number}`, exact: true })
    .getByRole("button", { name: "Create new issue", exact: true })
    .click()
  await admin
    .getByRole("textbox", { name: "Issue title", exact: true })
    .fill("Shared cycle planning")
  await expect(
    admin.getByRole("button", { name: "Change cycle", exact: true })
  ).toBeVisible()
  await admin.screenshot({ path: "/tmp/for55-composer.png", fullPage: true })
  await admin.getByRole("button", { name: "Create issue", exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM issues WHERE team_id=$1",
            [teamId]
          )
        ).rows[0].n,
      { timeout: 60000 }
    )
    .toBe(1)
  const issue = (
    await pool.query(
      "SELECT id,title,cycle_id,revision,properties FROM issues WHERE team_id=$1",
      [teamId]
    )
  ).rows[0]
  expect(issue.cycle_id).toBe(cycles[0].id)
  await member.goto(`${base}/teams/engineering/cycle/${cycles[0].number}`)
  await expect(
    member.getByRole("button", { name: "Open ENG-1 Shared cycle planning" })
  ).toBeVisible({ timeout: 60000 })
  await member.getByRole("button", { name: "Open cycle details" }).click()
  await expect(
    member.getByRole("complementary", { name: "Cycle details", exact: true })
  ).toContainText("Europe/Paris")
  await member.screenshot({
    path: "/tmp/for55-shared-cycle.png",
    fullPage: true,
  })
  await member.goto(
    `${base}/teams/engineering/issues?view=all&issue=${issue.id}`
  )
  await expect(
    member.getByRole("textbox", { name: "Issue title", exact: true })
  ).toHaveValue("Shared cycle planning", { timeout: 60000 })
  await member
    .getByRole("button", { name: "Change cycle", exact: true })
    .click()
  await member.getByRole("option", { name: /Cycle 2 · Planned/ }).click()
  await expect
    .poll(
      async () =>
        (
          await pool.query("SELECT cycle_id FROM issues WHERE id=$1", [
            issue.id,
          ])
        ).rows[0].cycle_id,
      { timeout: 60000 }
    )
    .toBe(cycles[1].id)
  await admin.reload()
  await expect(
    admin
      .getByRole("main", { name: `Cycle ${cycles[0].number}`, exact: true })
      .getByRole("button", { name: "Create new issue", exact: true })
  ).toBeVisible({ timeout: 60000 })
  await member.goto(`${base}/teams/engineering/cycle/${cycles[1].number}`)
  await expect(
    member.getByRole("button", { name: "Open ENG-1 Shared cycle planning" })
  ).toBeVisible({ timeout: 60000 })
  // A stale settings page receives a conflict; preserve the planned dates.
  await admin.goto(`${base}/settings/teams/engineering/cycles`)
  await expect(
    admin.getByRole("textbox", { name: "Cycle timezone" })
  ).toHaveValue("Europe/Paris", { timeout: 60000 })
  const before = (
    await pool.query(
      "SELECT id,start_date,end_date,timezone,number FROM issue_cycles WHERE team_id=$1 ORDER BY number",
      [teamId]
    )
  ).rows
  await pool.query(
    "UPDATE product_state SET revision=revision+1,encoded_value=to_jsonb(((encoded_value::jsonb#>>'{}')::jsonb || '{\"duration\":1}'::jsonb)::text)::text WHERE workspace_id=$1 AND key=$2",
    [marker, `forge:team-cycles:v1:${teamId}`]
  )
  await admin
    .getByRole("textbox", { name: "Cycle timezone" })
    .fill("America/New_York")
  await admin.getByRole("textbox", { name: "Cycle timezone" }).press("Tab")
  await expect(
    admin.getByRole("alert").filter({ hasText: "Cycle settings changed" })
  ).toBeVisible({ timeout: 60000 })
  await admin.getByRole("button", { name: "Retry saved change" }).click()
  await expect(
    admin.getByRole("textbox", { name: "Cycle timezone" })
  ).toHaveValue("America/New_York", { timeout: 60000 })
  expect(
    (
      await pool.query(
        "SELECT id,start_date,end_date,timezone,number FROM issue_cycles WHERE team_id=$1 ORDER BY number",
        [teamId]
      )
    ).rows
  ).toEqual(before)
  expect(
    (
      await pool.query("SELECT id,cycle_id FROM issues WHERE team_id=$1", [
        teamId,
      ])
    ).rows
  ).toEqual([{ id: issue.id, cycle_id: cycles[1].id }])
  await member.setViewportSize({ width: 390, height: 844 })
  await member.reload()
  await expect(
    member.getByRole("button", { name: "Open ENG-1 Shared cycle planning" })
  ).toBeVisible({ timeout: 60000 })
  expect(
    await member.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await member.screenshot({ path: "/tmp/for55-mobile.png", fullPage: true })
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-55",
      environment: identity,
      passed: true,
      checks: [
        "two authenticated members in different browser timezones",
        "admin schedule setup and member read-only settings",
        "canonical cycle creation",
        "same issue ID and dates across members",
        "membership move without duplicate",
        "stable numbered routes",
        "visible stale settings conflict and explicit retry",
        "immutable windows",
        "mobile layout",
      ],
    })
  )
} catch (error) {
  for (const [i, context] of (browser?.contexts() ?? []).entries())
    for (const page of context.pages()) {
      await page
        .screenshot({ path: `/tmp/for55-failure-${i}.png`, fullPage: true })
        .catch(() => {})
      console.log(
        JSON.stringify({
          stage: "failure",
          page: i,
          url: new URL(page.url()).pathname,
          body: (await page.locator("body").innerText()).slice(-3000),
        })
      )
    }
  throw error
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

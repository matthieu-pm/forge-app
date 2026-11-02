import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim()
const authorizedRevision =
  process.env.FORGE_VIEWS_PRODUCTION_AUTHORIZED_REVISION
const production = Boolean(authorizedRevision)
if (
  production &&
  (authorizedRevision !== revision ||
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
)
  throw new Error(
    "Production verification requires a clean, exact authorized source revision."
  )
const file = production
  ? process.env.FORGE_VIEWS_PRODUCTION_DATABASE_FILE
  : process.env.FORGE_SAVED_VIEWS_TEST_DATABASE_FILE
if (!file) throw new Error("An explicit acceptance database file is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
const expectedHost = production
  ? "ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech"
  : "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech"
const expectedDatabase = production ? "neondb" : "forge_saved_views_acceptance"
const expectedBranch = production
  ? "br-muddy-queen-zaeeysjt"
  : "br-autumn-union-za0opf1e"
if (
  url.hostname.replace("-pooler.", ".") !== expectedHost ||
  decodeURIComponent(url.pathname) !== `/${expectedDatabase}` ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Wrong acceptance database")
const base = production
    ? "https://app.forgenow.tech"
    : (process.env.FORGE_VIEWS_BROWSER_URL ?? "http://localhost:3160"),
  baseUrl = new URL(base)
if (
  !production &&
  (baseUrl.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(baseUrl.hostname) ||
    baseUrl.username ||
    baseUrl.password)
)
  throw new Error("A local acceptance server is required")
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection }),
  marker = `for60-${production ? "production-" : ""}browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for60-${crypto.randomUUID()}`,
  users = [`${marker}-admin`, `${marker}-member`]
let activePage,
  browser,
  verified = false
try {
  const identity = (
    await pool.query(
      "SELECT current_database() database,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  if (
    identity.database !== expectedDatabase ||
    identity.branch !== expectedBranch
  )
    throw new Error("Wrong database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR60 Acceptance',$1)",
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
        timeout: 120000,
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

  async function createView(page, name, scope = "Personal") {
    activePage = page
    await page.goto(`${base}/workspace/views`)
    await expect(
      page.getByRole("button", { name: "New view", exact: true })
    ).toBeEnabled({ timeout: 60000 })
    await page.getByRole("button", { name: "New view", exact: true }).click()
    await page
      .getByRole("textbox", { name: "View name", exact: true })
      .fill(name)
    if (scope !== "Personal") {
      await page
        .getByRole("button", { name: "Save view to", exact: true })
        .click()
      await page.getByRole("option", { name: scope, exact: true }).click()
    }
    await page.getByRole("button", { name: "Create view", exact: true }).click()
    let row
    await expect
      .poll(
        async () => {
          row = (
            await pool.query(
              "SELECT id,revision FROM saved_views WHERE workspace_id=$1 AND definition->>'name'=$2",
              [marker, name]
            )
          ).rows[0]
          return Boolean(row)
        },
        { timeout: 60000 }
      )
      .toBe(true)
    await expect(
      page
        .getByRole("button", { name: "Add to favorites", exact: true })
        .first()
    ).toBeVisible({ timeout: 30000 })
    return row.id
  }
  const personal = await createView(admin, "Alice private")
  const shared = await createView(admin, "Shared work", "Workspace")
  // The same default saved query includes visible work and excludes hidden work for Bob.
  const privateTeam = crypto.randomUUID()
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Private planning','private-planning','PRV','private','emoji','🔥','#94a3b8','Europe/Paris',$3)",
    [privateTeam, marker, users[0]]
  )
  for (const [id, title] of [
    [teamId, "FOR60 visible work"],
    [privateTeam, "FOR60 HIDDEN SECRET"],
  ])
    await pool.query(
      "INSERT INTO issues(workspace_id,team_id,number,title,status_id,creator_id,properties) VALUES($1,$2,1,$3,'todo',$4,$5)",
      [
        marker,
        id,
        title,
        users[0],
        { title, status: "todo", priority: "High", description: "" },
      ]
    )
  await member.goto(`${base}/workspace/views`)
  await expect(
    member.getByRole("link", { name: "Shared work", exact: true })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    member.getByRole("link", { name: "Alice private", exact: true })
  ).toHaveCount(0)
  await member.getByRole("link", { name: "Shared work", exact: true }).click()
  await expect(
    member.getByText("FOR60 visible work", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    member.getByText("FOR60 HIDDEN SECRET", { exact: true })
  ).toHaveCount(0)
  await member
    .getByRole("button", { name: "Add to favorites", exact: true })
    .first()
    .click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM saved_view_favorites WHERE workspace_id=$1 AND user_id=$2 AND view_id=$3",
            [marker, users[1], shared]
          )
        ).rows[0].n
    )
    .toBe(1)
  await member
    .getByRole("button", { name: "View options", exact: true })
    .first()
    .click()
  await expect(
    member.getByRole("button", { name: "Edit view…", exact: true })
  ).toBeDisabled()
  await expect(
    member.getByRole("button", { name: "Delete view…", exact: true })
  ).toBeDisabled()
  await member.keyboard.press("Escape")
  // Independent browser profiles carry only session cookies, with no product storage.
  const fresh = []
  for (let i = 0; i < contexts.length; i++) {
    const state = await contexts[i].storageState()
    const context = await browser.newContext({
      storageState: { cookies: state.cookies, origins: [] },
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()
    fresh.push(page)
    await page.goto(`${base}/workspace/views`)
    await expect(
      page.getByRole("link", { name: "Shared work", exact: true }).last()
    ).toBeVisible({ timeout: 60000 })
    await expect(
      page.getByRole("link", { name: "Alice private", exact: true })
    ).toHaveCount(i === 0 ? 1 : 0)
    if (i === 1)
      await expect(page.getByText("Favorites", { exact: true })).toBeVisible()
    else
      await expect(page.getByText("Favorites", { exact: true })).toHaveCount(0)
  }
  const conflict = fresh[0]
  await conflict.goto(
    `${base}/workspace/views?kind=issues&view=${shared}&edit=true`
  )
  await expect(
    conflict.getByRole("textbox", { name: "View name", exact: true })
  ).toHaveValue("Shared work", { timeout: 60000 })
  await conflict
    .getByRole("textbox", { name: "View name", exact: true })
    .fill("My conflict draft")
  await pool.query(
    "UPDATE saved_views SET revision=revision+1,definition=jsonb_set(definition,'{name}',$2::jsonb) WHERE id=$1",
    [shared, JSON.stringify("Changed elsewhere")]
  )
  await conflict.getByRole("button", { name: "Save view", exact: true }).click()
  await expect(
    conflict
      .getByRole("alert")
      .filter({ hasText: "changed in another session" })
  ).toBeVisible({ timeout: 30000 })
  await expect(
    conflict.getByRole("textbox", { name: "View name", exact: true })
  ).toHaveValue("My conflict draft")
  // Corrupt or newer definitions never execute a broad default query.
  await pool.query(
    "UPDATE saved_views SET definition=jsonb_set(definition,'{filters,rules}',$2::jsonb) WHERE id=$1",
    [
      shared,
      JSON.stringify([
        { id: "unknown", field: "secret", operator: "is", value: "x" },
      ]),
    ]
  )
  await fresh[1].reload()
  await expect(
    fresh[1].getByRole("alert").filter({ hasText: "unsupported filters" })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    fresh[1].getByText("FOR60 visible work", { exact: true })
  ).toHaveCount(0)
  await expect(
    fresh[1].getByRole("link", { name: "Changed elsewhere", exact: true })
  ).toHaveCount(0)
  // Real project view uses the authorized server projection.
  const project = crypto.randomUUID()
  await pool.query(
    "INSERT INTO projects(id,workspace_id,name,properties) VALUES($1,$2,'FOR60 shared project',$3)",
    [project, marker, { status: "Planned", health: "On track" }]
  )
  await admin.goto(`${base}/workspace/views?kind=projects&view=new`)
  await admin
    .getByRole("textbox", { name: "View name", exact: true })
    .fill("Project work")
  await admin.getByRole("button", { name: "Save view to", exact: true }).click()
  await admin.getByRole("option", { name: "Workspace", exact: true }).click()
  await admin.getByRole("button", { name: "Create view", exact: true }).click()
  await expect(
    admin.getByText("FOR60 shared project", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  let projectView
  await expect
    .poll(
      async () => {
        projectView = (
          await pool.query(
            "SELECT id FROM saved_views WHERE workspace_id=$1 AND definition->>'name'='Project work'",
            [marker]
          )
        ).rows[0]?.id
        return Boolean(projectView)
      },
      { timeout: 60000 }
    )
    .toBe(true)
  await member.goto(`${base}/workspace/views?kind=projects&view=${projectView}`)
  await expect(
    member.getByText("FOR60 shared project", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await member.screenshot({
    path: "/tmp/for60-saved-views.png",
    fullPage: true,
  })
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-60",
      revision,
      production,
      passed: true,
      environment: identity,
      checks: [
        "private/shared visibility",
        "two new device profiles without local product data",
        "actor-owned favorites",
        "authorized issue and project results",
        "creator/admin-only controls",
        "revision conflict draft retained",
        "invalid filters fail closed",
      ],
    })
  )
} catch (error) {
  if (activePage) {
    await activePage
      .screenshot({ path: "/tmp/for60-browser-failure.png", fullPage: true })
      .catch(() => {})
    writeFileSync(
      "/tmp/for60-browser-failure.txt",
      await activePage
        .locator("body")
        .innerText()
        .catch(() => "unavailable")
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

import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file = process.env.FORGE_AUTO_ASSIGNMENT_TEST_DATABASE_FILE
if (!file)
  throw new Error("FORGE_AUTO_ASSIGNMENT_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_auto_assignment_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base =
    process.env.FORGE_AUTO_ASSIGNMENT_BROWSER_URL ?? "http://localhost:3138",
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
  marker = `for138-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for138-${crypto.randomUUID()}`,
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
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR138 Acceptance',$1)",
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
  admin.on("pageerror", (error) => errors.push(error.message))
  await admin.goto(`${base}/settings`)
  const toggle = admin.getByRole("switch", {
    name: "Auto-assign new issues to self",
    exact: true,
  })
  await expect(toggle).toBeEnabled({ timeout: 60000 })
  await toggle.click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT values->>'general.autoAssignToSelf' enabled FROM account_preferences WHERE user_id=$1",
            [users[0]]
          )
        ).rows[0]?.enabled
    )
    .toBe("true")
  await admin.reload()
  await expect(toggle).toBeChecked({ timeout: 60000 })
  async function create(title, assignee, child = false) {
    await admin.goto(`${base}/teams/engineering/issues?view=all`)
    await admin.getByRole("button", { name: "New issue", exact: true }).click()
    await admin
      .getByRole("textbox", { name: "Issue title", exact: true })
      .fill(title)
    if (assignee !== undefined) {
      await admin
        .getByRole("button", { name: "Change assignee", exact: true })
        .click()
      await admin.getByRole("option", { name: assignee, exact: true }).click()
    }
    if (child) {
      await admin
        .getByRole("button", { name: "More actions", exact: true })
        .click()
      await admin.getByRole("button", { name: /Add sub-issue/ }).click()
      await admin
        .getByRole("textbox", { name: "Sub-issue title", exact: true })
        .fill("Automatically owned child")
      await admin
        .getByRole("button", { name: "Add sub-issue", exact: true })
        .click()
      await admin
        .getByRole("button", { name: "More actions", exact: true })
        .click()
    }
    await admin
      .getByRole("button", { name: "Create issue", exact: true })
      .click()
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              "SELECT count(*)::int n FROM issues WHERE workspace_id=$1 AND title=$2",
              [marker, title]
            )
          ).rows[0].n
      )
      .toBe(1)
    return (
      await pool.query(
        "SELECT * FROM issues WHERE workspace_id=$1 AND title=$2",
        [marker, title]
      )
    ).rows[0]
  }
  const auto = await create("Auto assigned browser issue", undefined, true)
  expect(auto.assignee_id).toBe(users[0])
  expect(auto.properties.activity).toMatchObject([
    { author: users[0], field: "assignee", to: users[0] },
  ])
  const child = (
    await pool.query("SELECT * FROM issues WHERE parent_id=$1", [auto.id])
  ).rows[0]
  expect(child.assignee_id).toBe(users[0])
  expect(child.properties.activity).toMatchObject([
    { author: users[0], field: "assignee", to: users[0] },
  ])
  expect(
    (await create("Explicitly unassigned browser issue", "No assignee"))
      .assignee_id
  ).toBe(null)
  expect(
    (await create("Explicit other browser issue", "Bob Member")).assignee_id
  ).toBe(users[1])
  await member.goto(`${base}/teams/engineering/issues?view=all`)
  await expect(
    member.getByRole("button", {
      name: /Open ENG-1 Auto assigned browser issue/,
    })
  ).toBeVisible({ timeout: 60000 })
  await member.reload()
  await expect(
    member.getByRole("button", {
      name: /Open ENG-1 Auto assigned browser issue/,
    })
  ).toBeVisible({ timeout: 60000 })
  await admin.goto(`${base}/settings`)
  await expect(toggle).toBeChecked({ timeout: 60000 })
  await toggle.click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT values->>'general.autoAssignToSelf' enabled FROM account_preferences WHERE user_id=$1",
            [users[0]]
          )
        ).rows[0]?.enabled
    )
    .toBe("false")
  expect((await create("Disabled preference browser issue")).assignee_id).toBe(
    null
  )
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-138",
      environment: identity,
      checks: [
        "saved preference through real Better Auth browser session",
        "auto assigned parent and child with history",
        "explicit unassigned",
        "explicit other member",
        "independent account reload",
        "disabled preference",
      ],
      passed: true,
    })
  )
} finally {
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM organization WHERE id=$1", [marker])
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

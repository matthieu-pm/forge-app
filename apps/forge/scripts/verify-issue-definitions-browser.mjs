import { readFileSync, mkdirSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file = process.env.FORGE_DEFINITION_TEST_DATABASE_FILE
if (!file) throw new Error("FORGE_DEFINITION_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !==
    "/forge_issue_definitions_acceptance_v3" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base =
    process.env.FORGE_DEFINITION_BROWSER_URL ?? "http://localhost:3040",
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
  marker = `for40-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for40-${crypto.randomUUID()}`,
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
    identity.database !== "forge_issue_definitions_acceptance_v3" ||
    identity.branch !== "br-autumn-union-za0opf1e"
  )
    throw new Error("Wrong database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR40 Acceptance',$1)",
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
  admin.on("pageerror", (e) => errors.push(e.message))
  member.on("pageerror", (e) => errors.push(e.message))
  await admin.goto(`${base}/settings/teams/engineering/statuses`)
  await admin
    .getByRole("button", { name: "Add unstarted status", exact: true })
    .click({ timeout: 30000 })
  await admin
    .getByRole("textbox", { name: "Status name", exact: true })
    .fill("Ready")
  await admin.getByRole("button", { name: "Save status", exact: true }).click()
  await expect(admin.getByText("Ready", { exact: true })).toBeVisible()
  await member.goto(`${base}/settings/teams/engineering/statuses`)
  await expect(member.getByText("Ready", { exact: true })).toBeVisible({
    timeout: 30000,
  })
  await expect(
    member.getByRole("button", { name: "Add unstarted status", exact: true })
  ).toBeDisabled()
  await admin.goto(`${base}/settings/teams/engineering/labels`)
  await admin
    .getByRole("button", { name: "New label", exact: true })
    .click({ timeout: 30000 })
  await admin
    .getByRole("textbox", { name: "Definition name", exact: true })
    .fill("Mobile")
  await admin.getByRole("button", { name: "Save label", exact: true }).click()
  await expect(admin.getByText("Mobile", { exact: true })).toBeVisible()
  await member.goto(`${base}/settings/teams/engineering/labels`)
  await expect(member.getByText("Mobile", { exact: true })).toBeVisible({
    timeout: 30000,
  })
  await admin.reload()
  await expect(admin.getByText("Mobile", { exact: true })).toBeVisible({
    timeout: 30000,
  })
  mkdirSync("/tmp/for40-browser", { recursive: true })
  await admin.screenshot({
    path: "/tmp/for40-browser/shared-labels.png",
    fullPage: true,
  })
  // Inheritance and real issue picker consistency.
  await admin.goto(`${base}/settings/issue-labels`)
  await admin
    .getByRole("button", { name: "New label", exact: true })
    .click({ timeout: 30000 })
  await admin
    .getByRole("textbox", { name: "Definition name", exact: true })
    .fill("Workspace shared")
  await admin.getByRole("button", { name: "Save label", exact: true }).click()
  await expect(
    admin.getByText("Workspace shared", { exact: true })
  ).toBeVisible()
  await member.goto(`${base}/settings/teams/engineering/labels`)
  await expect(
    member.getByText("Workspace shared", { exact: true })
  ).toBeVisible({ timeout: 30000 })
  await admin.goto(`${base}/settings/teams/engineering/workflows`)
  await admin
    .getByRole("checkbox", { name: "Todo to Done", exact: true })
    .click({ timeout: 30000 })
  await expect
    .poll(async () =>
      (
        await pool.query(
          "SELECT value->'transitions'->'todo' transitions FROM issue_definition_scopes WHERE team_id=$1",
          [teamId]
        )
      ).rows[0]?.transitions?.includes("done")
    )
    .toBe(false)
  await member.goto(`${base}/settings/teams/engineering/workflows`)
  await expect(
    member.getByRole("checkbox", { name: "Todo to Done", exact: true })
  ).not.toBeChecked({ timeout: 30000 })
  await admin.screenshot({
    path: "/tmp/for40-browser/shared-workflows.png",
    fullPage: true,
  })
  // A canonical assignment must prevent deletion without an explicit replacement.
  const issueId = crypto.randomUUID()
  await pool.query(
    "INSERT INTO issues(id,workspace_id,team_id,number,title,status_id) SELECT $1,$2,$3,1,'Assigned issue',id FROM issue_statuses WHERE team_id=$3 AND name='Ready'",
    [issueId, marker, teamId]
  )
  await admin.goto(`${base}/settings/teams/engineering/statuses`)
  await admin
    .getByRole("button", { name: "Delete Ready", exact: true })
    .click({ timeout: 30000 })
  await admin
    .getByRole("button", { name: "Delete status", exact: true })
    .click()
  await expect(
    admin.getByRole("alert").filter({ hasText: "assigned to issues" })
  ).toBeVisible()
  await admin
    .getByRole("combobox", { name: "Replacement status", exact: true })
    .selectOption("todo")
  await admin
    .getByRole("button", { name: "Delete status", exact: true })
    .click()
  await expect(
    admin.getByRole("dialog", { name: "Delete Ready", exact: true })
  ).not.toBeVisible()
  await expect
    .poll(
      async () =>
        (
          await pool.query("SELECT status_id FROM issues WHERE id=$1", [
            issueId,
          ])
        ).rows[0]?.status_id
    )
    .toBe("todo")
  await admin.setViewportSize({ width: 390, height: 844 })
  await admin.screenshot({
    path: "/tmp/for40-browser/mobile-statuses.png",
    fullPage: true,
  })
  if (errors.length)
    throw new Error(
      `Browser runtime errors: ${errors.join("; ").slice(0, 600)}`
    )
  console.log(
    JSON.stringify({
      status: "passed",
      checks: [
        "real Better Auth sign-in for admin and member",
        "Ready shared after reload",
        "Mobile shared after reload",
        "member controls read only",
        "workspace label inheritance",
        "allowed transition persistence",
        "referenced deletion rejected",
        "explicit replacement migrates canonical assignment",
        "desktop and mobile screenshots",
        "no browser runtime errors",
      ],
      environment: identity,
    })
  )
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.split("Call log:")[0].slice(0, 900)
      : "Browser verification failed"
  )
  process.exitCode = 1
} finally {
  await browser?.close()
  if (verified) {
    for (let attempt = 0; ; attempt++) {
      try {
        await pool.query("DELETE FROM organization WHERE id=$1", [marker])
        break
      } catch (error) {
        if (error.code !== "40P01" || attempt >= 2) throw error
      }
    }
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    console.log(
      JSON.stringify({
        cleanup: (
          await pool.query(
            'SELECT count(*)::int n FROM "user" WHERE id=ANY($1)',
            [users]
          )
        ).rows[0].n,
      })
    )
  }
  await pool.end()
}

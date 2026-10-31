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
const base = process.env.FORGE_PROJECT_BROWSER_URL ?? "http://localhost:3154",
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
  marker = `for54-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for54-${crypto.randomUUID()}`,
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

  await admin.goto(`${base}/workspace/projects`)
  await expect(
    admin.getByRole("button", { name: "New project", exact: true })
  ).toBeEnabled({ timeout: 60000 })
  await admin.getByRole("button", { name: "New project", exact: true }).click()
  await admin
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("FOR54 Shared Release")
  await admin
    .getByRole("textbox", { name: "Project summary", exact: true })
    .fill("Created by Alice for the shared team")
  await admin
    .getByRole("button", { name: "Create project", exact: true })
    .click()
  let project
  await expect
    .poll(
      async () => {
        project = (
          await pool.query(
            "SELECT id,name,revision,properties FROM projects WHERE workspace_id=$1 AND name='FOR54 Shared Release'",
            [marker]
          )
        ).rows[0]
        return Boolean(project)
      },
      { timeout: 60000 }
    )
    .toBe(true)
  await admin.goto(`${base}/projects/${project.id}?tab=issues`)
  const projectMain = admin.getByRole("main", {
    name: "FOR54 Shared Release",
    exact: true,
  })
  await expect(
    projectMain.getByRole("button", { name: "Create new issue", exact: true })
  ).toBeEnabled({ timeout: 60000 })
  await projectMain
    .getByRole("button", { name: "Create new issue", exact: true })
    .click()
  await admin
    .getByRole("textbox", { name: "Issue title", exact: true })
    .fill("FOR54 canonical browser work")
  await admin.getByRole("button", { name: "Create issue", exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM issues WHERE workspace_id=$1 AND project_id=$2 AND title='FOR54 canonical browser work'",
            [marker, project.id]
          )
        ).rows[0].n,
      { timeout: 60000 }
    )
    .toBe(1)
  const privateTeam = crypto.randomUUID()
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Private planning','private-planning','PRV','private','emoji','🔥','#94a3b8','Europe/Paris',$3)",
    [privateTeam, marker, users[0]]
  )
  await pool.query(
    "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
    [marker, project.id, privateTeam]
  )
  await pool.query(
    "INSERT INTO issues(workspace_id,team_id,number,title,status_id,project_id,creator_id,properties) VALUES($1,$2,1,'FOR54 PRIVATE SECRET','todo',$3,$4,'{}')",
    [marker, privateTeam, project.id, users[0]]
  )
  await member.goto(`${base}/workspace/projects`)
  await expect(
    member.getByText("FOR54 Shared Release", { exact: true }).first()
  ).toBeVisible({ timeout: 60000 })
  await member.goto(`${base}/projects/${project.id}?tab=issues`)
  await expect(
    member.getByText("FOR54 canonical browser work", { exact: true }).first()
  ).toBeVisible({ timeout: 60000 })
  await expect(
    member.getByText("FOR54 PRIVATE SECRET", { exact: true })
  ).toHaveCount(0)
  await expect(
    member.getByText("Private planning", { exact: true })
  ).toHaveCount(0)
  await member.goto(`${base}/projects/${project.id}?tab=overview`)
  const summary = member.getByRole("textbox", {
    name: "Project summary",
    exact: true,
  })
  await expect(summary).toHaveValue("Created by Alice for the shared team", {
    timeout: 60000,
  })
  await summary.fill("Bob edited the shared plan")
  await summary.blur()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT properties->>'summary' summary FROM projects WHERE id=$1",
            [project.id]
          )
        ).rows[0].summary,
      { timeout: 60000 }
    )
    .toBe("Bob edited the shared plan")
  await admin.goto(`${base}/projects/${project.id}?tab=overview`)
  await expect(
    admin.getByRole("textbox", { name: "Project summary", exact: true })
  ).toHaveValue("Bob edited the shared plan", { timeout: 60000 })
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM project_teams WHERE project_id=$1",
        [project.id]
      )
    ).rows[0].n
  ).toBe(2)
  // Change the shared version after Bob's editor loaded, before its next save.
  await pool.query(
    "UPDATE projects SET name='Concurrent Alice edit' WHERE id=$1",
    [project.id]
  )
  await summary.fill("Bob conflict draft")
  await summary.blur()
  await expect(
    member.getByText(/This project changed in another session/)
  ).toBeVisible({ timeout: 30000 })
  await member
    .getByText("Review pending project changes", { exact: true })
    .click()
  await expect(
    member.getByText("Bob conflict draft", { exact: true })
  ).toBeVisible()
  await member.screenshot({ path: "/tmp/for54-conflict.png", fullPage: true })
  await member
    .getByRole("button", {
      name: "Keep a server copy and load latest",
      exact: true,
    })
    .click()
  await expect(
    member.getByText("Saved project draft", { exact: true })
  ).toBeVisible({ timeout: 30000 })
  await expect(summary).toHaveValue("Bob edited the shared plan")
  // Revocation hides the recovered private content without destroying its
  // original server copy. Regrant makes that exact proposal available again.
  await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
    teamId,
  ])
  await pool.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [
    teamId,
    users[1],
  ])
  await member.reload()
  await expect(
    member.getByText("This project is no longer available in this workspace.", {
      exact: true,
    })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    member.getByText("Saved project draft", { exact: true })
  ).toHaveCount(0)
  await expect(
    member.getByText("Bob conflict draft", { exact: true })
  ).toHaveCount(0)
  await pool.query(
    "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member')",
    [crypto.randomUUID(), marker, teamId, users[1]]
  )
  await member.reload()
  await expect(
    member.getByText("Saved project draft", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await member.getByText("Saved project draft", { exact: true }).click()
  await member
    .getByRole("button", { name: "Apply draft to latest project", exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT properties->>'summary' summary FROM projects WHERE id=$1",
            [project.id]
          )
        ).rows[0].summary,
      { timeout: 30000 }
    )
    .toBe("Bob conflict draft")
  expect(
    (await pool.query("SELECT name FROM projects WHERE id=$1", [project.id]))
      .rows[0].name
  ).toBe("Concurrent Alice edit")
  await expect(
    member.getByRole("button", { name: "Discard saved draft", exact: true })
  ).toBeEnabled({ timeout: 30000 })
  await member
    .getByRole("button", { name: "Discard saved draft", exact: true })
    .click()
  await expect(
    member.getByText("Saved project draft", { exact: true })
  ).toHaveCount(0)
  await expect(
    member.getByText(/Unsaved changes — not confirmed by the server/)
  ).toHaveCount(0, { timeout: 30000 })
  await member.reload()
  await expect(
    member.getByRole("textbox", { name: "Project summary", exact: true })
  ).toHaveValue("Bob conflict draft", { timeout: 60000 })
  await member.screenshot({
    path: "/tmp/for54-shared-project.png",
    fullPage: true,
  })
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-54",
      passed: true,
      environment: identity,
      checks: [
        "two Better Auth sessions",
        "UI creates shared project",
        "project composer creates canonical issue membership",
        "private issues and teams hidden",
        "member edits shared core fields",
        "hidden team link retained",
        "conflict draft recovery and explicit rebase",
        "revoked recovery content hidden and restored after regrant",
        "reload retains shared state",
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

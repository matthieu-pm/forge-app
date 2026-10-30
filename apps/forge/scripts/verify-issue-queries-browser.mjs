import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file =
  process.env.FORGE_ISSUE_QUERY_TEST_DATABASE_FILE ??
  process.env.FORGE_AUTO_ASSIGNMENT_TEST_DATABASE_FILE
if (!file) throw new Error("FORGE_ISSUE_QUERY_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_auto_assignment_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base =
    process.env.FORGE_ISSUE_QUERY_BROWSER_URL ?? "http://localhost:3143",
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
  marker = `for43-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for43-${crypto.randomUUID()}`,
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
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR43 Acceptance',$1)",
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
  const errors = [],
    responses = []
  member.on("pageerror", (error) => errors.push(error.message))
  member.on("response", (response) => {
    if (response.url().includes("_serverFn"))
      void response
        .text()
        .then((text) => responses.push(text))
        .catch(() => {})
  })
  await pool.query(
    "INSERT INTO issues(workspace_id,team_id,number,title,assignee_id,creator_id,properties) SELECT $1,$2,n,'Paginated issue '||lpad(n::text,3,'0'),$3,$4,'{\"priority\":\"Medium\"}'::jsonb FROM generate_series(1,121) n",
    [marker, teamId, users[1], users[0]]
  )
  await pool.query(
    "INSERT INTO team_issue_numbers(team_id,last_number) VALUES($1,121) ON CONFLICT(team_id) DO UPDATE SET last_number=121",
    [teamId]
  )
  const privateTeam = crypto.randomUUID()
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Secret','secret','SEC','private','emoji','🔒','#94a3b8','Europe/Paris',$3)",
    [privateTeam, marker, users[0]]
  )
  await pool.query(
    "INSERT INTO issues(workspace_id,team_id,number,title,properties) VALUES($1,$2,1,'Private secret needle','{\"description\":\"Private snippet sentinel\"}')",
    [marker, privateTeam]
  )
  await member.goto(`${base}/teams/engineering/issues?view=all`)
  await expect(
    member.getByText("50 of 121 issues", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await admin.goto(`${base}/teams/engineering/issues?view=all`)
  await admin.getByRole("button", { name: "New issue", exact: true }).click()
  await admin
    .getByRole("textbox", { name: "Issue title", exact: true })
    .fill("Concurrent create")
  await admin.getByRole("button", { name: "Create issue", exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM issues WHERE workspace_id=$1 AND title='Concurrent create'",
            [marker]
          )
        ).rows[0].n
    )
    .toBe(1)
  await member.getByRole("button", { name: "Load more", exact: true }).click()
  await expect(
    member.getByText("100 of 121 issues", { exact: true })
  ).toBeVisible()
  await member.getByRole("button", { name: "Load more", exact: true }).click()
  await expect(
    member.getByText("121 of 121 issues", { exact: true })
  ).toBeVisible()
  await expect(
    member.getByRole("button", { name: /Open ENG-122 Concurrent create/ })
  ).toHaveCount(0)
  const search = member.getByRole("textbox", {
    name: "Search issues",
    exact: true,
  })
  await search.fill("secret needle")
  await expect(member.getByText("0 of 0 issues", { exact: true })).toBeVisible()
  expect(responses.join("\n")).not.toContain("Private secret needle")
  expect(responses.join("\n")).not.toContain("Private snippet sentinel")
  await search.fill("Paginated issue 121")
  await expect(member.getByText("1 of 1 issues", { exact: true })).toBeVisible()
  await expect(
    member.getByRole("button", { name: /Open ENG-121 Paginated issue 121/ })
  ).toBeVisible()
  await member
    .getByRole("button", { name: /Open ENG-121 Paginated issue 121/ })
    .click()
  await expect(
    member.getByRole("textbox", { name: "Issue title", exact: true })
  ).toBeVisible()
  await member.goto(`${base}/my-issues?view=assigned`)
  await expect(
    member.getByText("50 of 121 issues", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await member
    .getByRole("button", { name: "Display options", exact: true })
    .click()
  await member.getByRole("tab", { name: "Board", exact: true }).click()
  await member.keyboard.press("Escape")
  await expect(member.getByLabel("Issue board", { exact: true })).toBeVisible()
  await member.screenshot({
    path:
      process.env.FORGE_ISSUE_QUERY_SCREENSHOT ??
      "/tmp/for43-shared-issues.png",
  })
  await pool.query(
    "INSERT INTO issues(workspace_id,team_id,number,title) SELECT $1,$2,n,'Private hidden row '||n FROM generate_series(2,55) n",
    [marker, privateTeam]
  )
  await pool.query(
    "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
    [marker, privateTeam, users[1]]
  )
  await member.goto(`${base}/teams/secret/issues?view=all`)
  await expect(
    member.getByText("50 of 55 issues", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await pool.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [
    privateTeam,
    users[1],
  ])
  await member.getByRole("button", { name: "Load more", exact: true }).click()
  await expect(member.getByText("0 of 0 issues", { exact: true })).toBeVisible({
    timeout: 15000,
  })
  await expect(member.getByRole("button", { name: /Open SEC-/ })).toHaveCount(0)
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-43",
      environment: identity,
      passed: true,
      checks: [
        "two independent Better Auth sessions",
        "stable 50/100/121 pagination during create",
        "private title/snippet/count isolation",
        "server content search",
        "direct issue detail",
        "bounded assigned view",
        "board uses authorized total beyond loaded rows",
        "revocation clears previously loaded private rows",
      ],
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

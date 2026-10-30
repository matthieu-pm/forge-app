import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file =
  process.env.FORGE_ISSUE_RELATIONSHIP_TEST_DATABASE_FILE ??
  process.env.FORGE_AUTO_ASSIGNMENT_TEST_DATABASE_FILE
if (!file)
  throw new Error("FORGE_ISSUE_RELATIONSHIP_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_auto_assignment_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base =
    process.env.FORGE_ISSUE_RELATIONSHIP_BROWSER_URL ?? "http://localhost:3143",
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
  marker = `for44-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for44-${crypto.randomUUID()}`,
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
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR44 Acceptance',$1)",
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
  const otherTeam = crypto.randomUUID(),
    a = crypto.randomUUID(),
    b = crypto.randomUUID(),
    c = crypto.randomUUID()
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Design','design','DES','emoji','🎨','#94a3b8','Europe/Paris',$3)",
    [otherTeam, marker, users[0]]
  )
  await pool.query(
    "INSERT INTO issues(id,workspace_id,team_id,number,title,creator_id) VALUES($1,$4,$5,1,'Relationship Alpha',$7),($2,$4,$6,1,'Relationship Beta',$7),($3,$4,$5,2,'Relationship Gamma',$7)",
    [a, b, c, marker, teamId, otherTeam, users[0]]
  )
  await pool.query(
    "INSERT INTO issues(workspace_id,team_id,number,title) SELECT $1,$2,n,'Unrelated fixture '||n FROM generate_series(3,65) n",
    [marker, teamId]
  )
  const go = async (page, slug, id) => {
    await page.goto(`${base}/teams/${slug}/issues?view=all&issue=${id}`)
    await expect(
      page.getByRole("region", { name: "Issue relationships", exact: true })
    ).toBeVisible({ timeout: 60000 })
  }
  const panel = (page) =>
    page.getByRole("region", { name: "Issue relationships", exact: true })
  const link = async (page, kind, title) => {
    const section = panel(page)
    await section
      .getByRole("button", { name: "Add relationship", exact: true })
      .click()
    await section
      .getByRole("combobox", { name: "Relationship type", exact: true })
      .selectOption(kind)
    await section
      .getByRole("textbox", { name: "Search relationship issues", exact: true })
      .fill(title)
    await section.getByRole("button", { name: new RegExp(title) }).click()
    await section
      .getByRole("button", { name: "Link issue", exact: true })
      .click()
  }
  await go(admin, "engineering", a)
  await expect(
    panel(admin).getByText("No linked issues yet.", { exact: true })
  ).toBeVisible()
  await link(admin, "blockedBy", "Relationship Beta")
  await expect(
    panel(admin).getByRole("link", {
      name: "Open DES-1 Relationship Beta",
      exact: true,
    })
  ).toBeVisible()
  await admin.reload()
  await expect(
    panel(admin).getByText("Blocked by", { exact: true })
  ).toBeVisible({ timeout: 30000 })
  await go(member, "design", b)
  await expect(panel(member).getByText("Blocks", { exact: true })).toBeVisible()
  await panel(member)
    .getByRole("button", { name: "Remove blocks ENG-1", exact: true })
    .click()
  await expect(
    panel(member).getByText("No linked issues yet.", { exact: true })
  ).toBeVisible()
  await admin.reload()
  await expect(
    panel(admin).getByText("No linked issues yet.", { exact: true })
  ).toBeVisible({ timeout: 30000 })
  await link(admin, "parent", "Relationship Beta")
  await expect(panel(admin).getByText("Parent", { exact: true })).toBeVisible()
  await member.reload()
  await expect(
    panel(member).getByText("Sub-issue", { exact: true })
  ).toBeVisible({ timeout: 30000 })
  await link(admin, "child", "Relationship Beta")
  await expect(panel(admin).getByRole("alert")).toContainText("cycle")
  expect(
    (
      await pool.query(
        "SELECT id,parent_id FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id",
        [[a, b]]
      )
    ).rows.find((row) => row.id === b).parent_id
  ).toBeNull()
  await panel(admin)
    .getByRole("button", { name: "Choose another relationship", exact: true })
    .click()
  await panel(admin)
    .getByRole("button", { name: "Cancel", exact: true })
    .click()
  await pool.query(
    "UPDATE issues SET title='Relationship Alpha updated' WHERE id=$1",
    [a]
  )
  await link(admin, "related", "Relationship Gamma")
  await expect(
    panel(admin).getByRole("button", { name: "Apply to latest", exact: true })
  ).toBeVisible()
  await panel(admin)
    .getByRole("button", { name: "Apply to latest", exact: true })
    .click()
  await expect(
    panel(admin).getByRole("link", {
      name: "Open ENG-2 Relationship Gamma",
      exact: true,
    })
  ).toBeVisible()
  // Creation through the existing composer refreshes reciprocal children immediately.
  await admin
    .getByRole("button", { name: "Add sub-issues", exact: true })
    .click()
  await admin
    .getByRole("textbox", { name: "Sub-issue title", exact: true })
    .fill("New relationship child")
  await admin
    .getByRole("region", { name: "Sub-issues", exact: true })
    .getByRole("button", { name: "Create", exact: true })
    .click()
  await expect(
    panel(admin).getByRole("link", {
      name: "Open ENG-66 New relationship child",
      exact: true,
    })
  ).toBeVisible()
  // Lose the response after commit, reload the retained draft, then replay exactly once.
  let lostResponse = false
  const loseResponse = async (route) => {
    const request = route.request(),
      body = request.postData() ?? ""
    if (
      !lostResponse &&
      request.method() === "POST" &&
      body.includes("expectedTargetRevision") &&
      !body.includes("team-relationship-draft")
    ) {
      lostResponse = true
      await route.fetch()
      await route.abort("failed")
    } else await route.continue()
  }
  await admin.route("**/*", loseResponse)
  await link(admin, "blocks", "Relationship Gamma")
  await expect(
    panel(admin).getByRole("button", {
      name: "Retry saved change",
      exact: true,
    })
  ).toBeEnabled()
  await admin.unroute("**/*", loseResponse)
  expect(lostResponse).toBe(true)
  const savedDraft = (
    await pool.query(
      "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2",
      [marker, `forge:team-relationship-draft:v1:${teamId}:${a}`]
    )
  ).rows[0]
  const retained = JSON.parse(JSON.parse(savedDraft.encoded_value))
  await admin.reload()
  await expect(
    panel(admin).getByRole("button", {
      name: "Retry saved change",
      exact: true,
    })
  ).toBeEnabled({ timeout: 30000 })
  await panel(admin)
    .getByRole("button", { name: "Retry saved change", exact: true })
    .click()
  await expect(
    panel(admin).getByRole("button", {
      name: "Retry saved change",
      exact: true,
    })
  ).toHaveCount(0)
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM command_receipts WHERE command_key=$1",
        [retained.input.commandKey]
      )
    ).rows[0].n
  ).toBe(1)
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM issue_relations WHERE issue_id=$1 AND related_issue_id=$2 AND kind='blocks'",
        [a, c]
      )
    ).rows[0].n
  ).toBe(1)
  await pool.query("UPDATE issues SET archived_at=now() WHERE id=$1", [b])
  await admin.reload()
  await expect(
    panel(admin).getByRole("link", {
      name: "Open DES-1 Relationship Beta",
      exact: true,
    })
  ).toHaveCount(0)
  await pool.query("UPDATE issues SET archived_at=null WHERE id=$1", [b])
  await admin.reload()
  await expect(
    panel(admin).getByRole("link", {
      name: "Open DES-1 Relationship Beta",
      exact: true,
    })
  ).toBeVisible({ timeout: 30000 })
  // Revoke access between relationship pages without navigating away.
  await pool.query(
    "INSERT INTO issues(workspace_id,team_id,number,title) SELECT $1,$2,n,'Private continuation '||n FROM generate_series(2,56) n",
    [marker, otherTeam]
  )
  await pool.query(
    "INSERT INTO issue_relations(workspace_id,issue_id,related_issue_id,kind) SELECT workspace_id,$1,id,'related' FROM issues WHERE workspace_id=$2 AND team_id=$3 AND id<>$1 ON CONFLICT DO NOTHING",
    [a, marker, otherTeam]
  )
  await go(member, "engineering", a)
  await expect(
    panel(member).getByRole("button", {
      name: "Load more relationships",
      exact: true,
    })
  ).toBeVisible()
  await expect(
    panel(member)
      .getByRole("link", { name: /Private continuation/ })
      .first()
  ).toBeVisible()
  await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
    otherTeam,
  ])
  await panel(member)
    .getByRole("button", { name: "Load more relationships", exact: true })
    .click()
  await expect(
    panel(member).getByRole("link", { name: /Private continuation/ })
  ).toHaveCount(0)
  await expect(
    panel(member).getByRole("link", {
      name: "Open DES-1 Relationship Beta",
      exact: true,
    })
  ).toHaveCount(0)
  await expect(
    panel(member).getByRole("link", {
      name: "Open ENG-2 Relationship Gamma",
      exact: true,
    })
  ).toHaveCount(2)
  // Revoke while the selected private search result is still on screen.
  await pool.query("UPDATE teams SET visibility='workspace' WHERE id=$1", [
    otherTeam,
  ])
  await member.reload()
  await expect(
    panel(member).getByRole("button", { name: "Add relationship", exact: true })
  ).toBeVisible({ timeout: 30000 })
  await panel(member)
    .getByRole("button", { name: "Add relationship", exact: true })
    .click()
  await panel(member)
    .getByRole("textbox", { name: "Search relationship issues", exact: true })
    .fill("Relationship Beta")
  await panel(member)
    .getByRole("button", { name: /DES-1.*Relationship Beta/ })
    .click()
  await expect(
    panel(member).getByRole("button", { name: "Link issue", exact: true })
  ).toBeEnabled()
  const bodies = []
  member.on("response", (response) => {
    if (response.url().includes("_serverFn"))
      void response
        .text()
        .then((body) => bodies.push(body))
        .catch(() => {})
  })
  await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
    otherTeam,
  ])
  await member.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(
    panel(member).getByRole("button", { name: /DES-1.*Relationship Beta/ })
  ).toHaveCount(0)
  await expect(
    panel(member).getByRole("button", { name: "Link issue", exact: true })
  ).toBeDisabled()
  // The global provider may remount detail while refreshing protected caches.
  await expect(
    panel(member).getByRole("link", {
      name: "Open ENG-2 Relationship Gamma",
      exact: true,
    })
  ).toHaveCount(2)
  if (
    (await panel(member)
      .getByRole("textbox", { name: "Search relationship issues", exact: true })
      .count()) === 0
  )
    await panel(member)
      .getByRole("button", { name: "Add relationship", exact: true })
      .click()
  await panel(member)
    .getByRole("textbox", { name: "Search relationship issues", exact: true })
    .fill("Relationship Beta")
  await expect(
    panel(member).getByText("No matching issues.", { exact: true })
  ).toBeVisible()
  await expect(
    panel(member).getByRole("link", {
      name: "Open DES-1 Relationship Beta",
      exact: true,
    })
  ).toHaveCount(0)
  expect(bodies.join("\n")).not.toContain("Relationship Beta")
  expect(errors).toEqual([])
  await member.screenshot({
    path: "/tmp/for44-relationships.png",
    fullPage: true,
  })
  console.log(
    JSON.stringify({
      issue: "FOR-44",
      environment: identity,
      passed: true,
      checks: [
        "two independent Better Auth sessions",
        "reciprocal cross-team blocking after reload",
        "unlink from reciprocal endpoint",
        "cross-team parent/sub-issue reciprocity",
        "cycle rejection retains records",
        "visible stale-revision resolution",
        "soft-delete hides and restore returns links",
        "private endpoints omitted from reads/search",
        "revocation between pages removes retained private relationships",
        "focus revocation clears open picker results and selection",
        "direct issue detail independent of list page",
        "new sub-issue appears immediately",
        "lost committed response survives reload and replays exactly once",
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

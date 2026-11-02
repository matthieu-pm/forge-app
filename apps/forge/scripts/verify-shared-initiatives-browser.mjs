import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim()
const authorizedRevision =
  process.env.FORGE_INITIATIVE_PRODUCTION_AUTHORIZED_REVISION
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
  ? process.env.FORGE_INITIATIVE_PRODUCTION_DATABASE_FILE
  : process.env.FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE
if (!file) throw new Error("An explicit acceptance database file is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
const rehearsal = config.target === "initiative-rehearsal"
const expectedHost = production
  ? "ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech"
  : rehearsal
    ? "ep-broad-dawn-zaijxea7.c-2.eu-west-2.aws.neon.tech"
    : "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech"
const expectedDatabase =
  production || rehearsal ? "neondb" : "forge_issue_history_acceptance"
const expectedBranch = production
  ? "br-muddy-queen-zaeeysjt"
  : rehearsal
    ? "br-sparkling-boat-zay5z06u"
    : "br-autumn-union-za0opf1e"
if (
  url.hostname.replace("-pooler.", ".") !== expectedHost ||
  decodeURIComponent(url.pathname) !== `/${expectedDatabase}` ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Wrong acceptance database")
const base = production
    ? "https://app.forgenow.tech"
    : (process.env.FORGE_INITIATIVE_BROWSER_URL ?? "http://localhost:3159"),
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
  marker = `for59-${production ? "production-" : ""}browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for59-${crypto.randomUUID()}`,
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
    identity.database !== expectedDatabase ||
    identity.branch !== expectedBranch
  )
    throw new Error("Wrong database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR59 Acceptance',$1)",
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

  const publicProjects = [crypto.randomUUID(), crypto.randomUUID()],
    secretProject = crypto.randomUUID(),
    privateTeam = crypto.randomUUID()
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Private Team','private','PRV','private','emoji','🔒','#94a3b8','Europe/Paris',$3)",
    [privateTeam, marker, users[0]]
  )
  for (const [index, id] of [...publicProjects, secretProject].entries()) {
    await pool.query(
      "INSERT INTO projects(id,workspace_id,name,properties,revision) VALUES($1,$2,$3,$4,1)",
      [
        id,
        marker,
        index === 2
          ? "Private project secret"
          : `Authorized project ${index + 1}`,
        JSON.stringify({ status: "Active", health: "Update missing" }),
      ]
    )
    const team = index === 2 ? privateTeam : teamId
    await pool.query(
      "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
      [marker, id, team]
    )
    for (const [position, [status, group]] of [
      ["todo", "unstarted"],
      ["done", "completed"],
    ].entries())
      await pool.query(
        "INSERT INTO issue_statuses(id,workspace_id,team_id,name,status_group,color,position) VALUES($1,$2,$3,$1,$4,'#94a3b8',$5) ON CONFLICT DO NOTHING",
        [status, marker, team, group, position]
      )
    await pool.query(
      "INSERT INTO issues(workspace_id,team_id,number,title,status_id,project_id) VALUES($1,$2,$3,$4,'todo',$5)",
      [
        marker,
        team,
        index + 1,
        index === 2 ? "Private work secret" : `Visible work ${index + 1}`,
        id,
      ]
    )
  }
  await admin.goto(`${base}/workspace/initiatives?view=all`)
  await expect(
    admin.getByRole("button", { name: "New initiative", exact: true })
  ).toBeEnabled({ timeout: 60000 })
  await admin
    .getByRole("button", { name: "New initiative", exact: true })
    .click()
  await admin
    .getByRole("textbox", { name: "Initiative name", exact: true })
    .fill("FOR59 Shared Strategy")
  await admin
    .getByRole("textbox", { name: "Initiative summary", exact: true })
    .fill("Durable shared strategy")
  await admin
    .getByRole("form", { name: "Create initiative", exact: true })
    .getByRole("button", { name: "Create", exact: true })
    .click()
  let initiative
  await expect
    .poll(
      async () => {
        initiative = (
          await pool.query(
            "SELECT id,revision,properties FROM initiatives WHERE workspace_id=$1 AND name='FOR59 Shared Strategy'",
            [marker]
          )
        ).rows[0]
        return Boolean(initiative)
      },
      { timeout: 60000 }
    )
    .toBe(true)
  const quiet = async (page) =>
    expect(page.getByText(/Unsaved changes — not confirmed/)).toHaveCount(0, {
      timeout: 60000,
    })
  await quiet(admin)
  await admin.goto(
    `${base}/workspace/initiatives/${initiative.id}?tab=projects`
  )
  await expect(
    admin.getByRole("button", {
      name: "Add project to initiative",
      exact: true,
    })
  ).toBeEnabled({ timeout: 60000 })
  await admin
    .getByRole("button", { name: "Add project to initiative", exact: true })
    .click()
  await admin
    .getByRole("menuitem", { name: "Add existing projects…", exact: true })
    .click()
  const dialog = admin.getByRole("dialog", {
    name: "Add existing projects",
    exact: true,
  })
  for (const name of [
    "Authorized project 1",
    "Authorized project 2",
    "Private project secret",
  ])
    await dialog.locator("label").filter({ hasText: name }).click()
  await dialog
    .getByRole("button", { name: "Add projects", exact: true })
    .click()
  await quiet(admin)
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM initiative_projects WHERE initiative_id=$1",
        [initiative.id]
      )
    ).rows[0].n
  ).toBe(3)
  await member.goto(
    `${base}/workspace/initiatives/${initiative.id}?tab=overview`
  )
  await expect(
    member.getByRole("textbox", { name: "Initiative name", exact: true })
  ).toHaveValue("FOR59 Shared Strategy", { timeout: 60000 })
  await expect(
    member.getByLabel("Initiative progress", { exact: true })
  ).toHaveText("0 of 2 issues completed · 0% · 2 projects you can access")
  expect(await member.locator("body").innerText()).not.toContain(
    "Private project secret"
  )
  expect(await member.locator("body").innerText()).not.toContain("Private Team")
  await pool.query("UPDATE issues SET status_id='done' WHERE project_id=$1", [
    publicProjects[0],
  ])
  await member.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(
    member.getByLabel("Initiative progress", { exact: true })
  ).toHaveText("1 of 2 issues completed · 50% · 2 projects you can access", {
    timeout: 60000,
  })
  await admin.goto(
    `${base}/workspace/initiatives/${initiative.id}?tab=overview`
  )
  await expect(
    admin.getByLabel("Initiative progress", { exact: true })
  ).toHaveText("1 of 3 issues completed · 33% · 3 projects you can access", {
    timeout: 60000,
  })
  await member.goto(
    `${base}/workspace/initiatives/${initiative.id}?tab=updates`
  )
  await expect(
    member.getByRole("textbox", { name: "Initiative update", exact: true })
  ).toBeEnabled({ timeout: 60000 })
  await expect(
    member.getByRole("button", {
      name: "Attach images, files, or videos",
      exact: true,
    })
  ).toBeDisabled()
  await member
    .getByRole("textbox", { name: "Initiative update", exact: true })
    .fill("Member-authored shared update")
  await member.getByRole("button", { name: "Post update", exact: true }).click()
  await quiet(member)
  await admin.goto(`${base}/workspace/initiatives/${initiative.id}?tab=updates`)
  await expect(
    admin.getByText("Member-authored shared update", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  const stored = (
    await pool.query("SELECT properties FROM initiatives WHERE id=$1", [
      initiative.id,
    ])
  ).rows[0].properties
  expect(stored.updates[0].authorId).toBe(users[1])
  await member.getByRole("tab", { name: "Comment", exact: true }).click()
  await member
    .getByRole("textbox", { name: "Initiative comment", exact: true })
    .fill("Shared member comment")
  await member
    .getByRole("button", { name: "Post comment", exact: true })
    .click()
  await quiet(member)
  await admin.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(
    admin.getByText("Shared member comment", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  // A workspace admin can moderate the member's post; an open member editor
  // must retain its original revision after that shared edit arrives.
  await member
    .locator(`[data-activity-id="${stored.updates[0].id}"]`)
    .getByRole("button", { name: "Update options", exact: true })
    .click()
  await member
    .getByRole("menuitem", { name: "Edit update", exact: true })
    .click()
  await member
    .getByRole("textbox", { name: "Edit activity text", exact: true })
    .fill("Stale member activity draft")
  await admin
    .locator(`[data-activity-id="${stored.updates[0].id}"]`)
    .getByRole("button", { name: "Update options", exact: true })
    .click()
  await admin
    .getByRole("menuitem", { name: "Edit update", exact: true })
    .click()
  await admin
    .getByRole("textbox", { name: "Edit activity text", exact: true })
    .fill("Admin moderated shared update")
  await admin.getByRole("button", { name: "Save post", exact: true }).click()
  await quiet(admin)
  const moderatedRefresh = member.waitForResponse(
    async (response) =>
      response.url().includes("/_serverFn/") &&
      (await response.text()).includes("Admin moderated shared update")
  )
  await member.evaluate(() => window.dispatchEvent(new Event("focus")))
  await moderatedRefresh
  await member.getByRole("button", { name: "Save post", exact: true }).click()
  await expect(
    member.getByRole("textbox", { name: "Edit activity text", exact: true })
  ).toHaveValue("Stale member activity draft")
  await expect(
    member.getByText(/Changes could not be saved. Your text has been kept/)
  ).toBeVisible()
  expect(
    (
      await pool.query(
        "SELECT properties->'updates'->0->>'text' text FROM initiatives WHERE id=$1",
        [initiative.id]
      )
    ).rows[0].text
  ).toBe("Admin moderated shared update")
  await member.getByRole("button", { name: "Cancel", exact: true }).click()
  // A departed initiative owner does not make the remaining workspace read-only.
  await admin.goto(
    `${base}/workspace/initiatives/${initiative.id}?tab=overview`
  )
  await pool.query(
    "UPDATE initiatives SET properties=jsonb_set(properties,'{ownerId}',to_jsonb($2::text)) WHERE id=$1",
    [initiative.id, users[1]]
  )
  await pool.query(
    "DELETE FROM member WHERE organization_id=$1 AND user_id=$2",
    [marker, users[1]]
  )
  await admin.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(
    admin.getByRole("textbox", { name: "Initiative summary", exact: true })
  ).toBeEnabled()
  // Wait for the fresh owner/revision snapshot before making the unrelated edit.
  await admin.reload()
  await expect(
    admin.getByRole("textbox", { name: "Initiative summary", exact: true })
  ).toBeEnabled({ timeout: 60000 })
  await admin
    .getByRole("textbox", { name: "Initiative summary", exact: true })
    .fill("Remaining admin can still collaborate")
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT properties->>'summary' summary FROM initiatives WHERE id=$1",
            [initiative.id]
          )
        ).rows[0].summary,
      { timeout: 60000 }
    )
    .toBe("Remaining admin can still collaborate")
  await quiet(admin)
  await pool.query(
    "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,'member')",
    [crypto.randomUUID(), users[1], marker]
  )
  // Force a real server revision conflict while the retained form still holds its old revision.
  await member.goto(
    `${base}/workspace/initiatives/${initiative.id}?tab=overview`
  )
  await expect(
    member.getByRole("textbox", { name: "Initiative name", exact: true })
  ).toHaveValue("FOR59 Shared Strategy", { timeout: 60000 })
  await pool.query(
    "UPDATE initiatives SET name='Concurrent lead edit' WHERE id=$1",
    [initiative.id]
  )
  await member
    .getByRole("textbox", { name: "Initiative name", exact: true })
    .fill("Retained member draft")
  await expect(
    member.getByText(/This initiative changed in another session/).first()
  ).toBeVisible({ timeout: 60000 })
  await member
    .getByRole("button", {
      name: "Keep a server copy and load latest",
      exact: true,
    })
    .click()
  await expect(
    member.getByRole("textbox", { name: "Initiative name", exact: true })
  ).toHaveValue("Concurrent lead edit", { timeout: 60000 })
  await member.getByText("Saved initiative draft", { exact: true }).click()
  await expect(
    member.getByText("name: Retained member draft", { exact: true })
  ).toBeVisible()
  await member
    .getByRole("button", {
      name: "Apply draft to latest initiative",
      exact: true,
    })
    .click()
  await quiet(member)
  expect(
    (
      await pool.query("SELECT name FROM initiatives WHERE id=$1", [
        initiative.id,
      ])
    ).rows[0].name
  ).toBe("Retained member draft")
  await member
    .getByRole("button", {
      name: "Discard saved initiative draft",
      exact: true,
    })
    .click()
  await quiet(member)
  // Freeze debounce timers so a newer authorized read reaches a dirty local
  // editor before it is enqueued; the user must explicitly review and rebase.
  await member.clock.install()
  await member.clock.pauseAt(new Date())
  await member
    .getByRole("textbox", { name: "Initiative name", exact: true })
    .fill("Reviewed background draft")
  await pool.query(
    "UPDATE initiatives SET properties=jsonb_set(properties,'{summary}',to_jsonb('Newer shared summary'::text)) WHERE id=$1",
    [initiative.id]
  )
  await member.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(
    member.getByRole("button", {
      name: "Apply text draft to latest initiative",
      exact: true,
    })
  ).toBeVisible({ timeout: 60000 })
  await member.getByText("Review latest shared text", { exact: true }).click()
  await expect(
    member.getByText("Summary: Newer shared summary", { exact: true })
  ).toBeVisible()
  await member
    .getByRole("button", {
      name: "Apply text draft to latest initiative",
      exact: true,
    })
    .click()
  await quiet(member)
  expect(
    (
      await pool.query("SELECT name FROM initiatives WHERE id=$1", [
        initiative.id,
      ])
    ).rows[0].name
  ).toBe("Reviewed background draft")
  await member.clock.resume()
  await member.screenshot({
    path: production
      ? "/tmp/for59-production-browser.png"
      : "/tmp/for59-initiative-browser.png",
    fullPage: true,
  })
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      acceptance: "FOR-59",
      revision,
      production,
      environment: identity,
      passed: true,
      checks: [
        "member-visible authorized rollups",
        "project progress updates across sessions",
        "private child/team omission",
        "shared attributed updates/comments",
        "administrator post moderation",
        "stale post text retained after background refresh",
        "departed initiative owner does not block collaboration",
        "real revision conflict and reviewed draft recovery",
        "background refresh preserves dirty text until explicitly reviewed",
      ],
      screenshot: "/tmp/for59-initiative-browser.png",
    })
  )
} catch (error) {
  if (browser) {
    const page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .at(-1)
    if (page) {
      await page.screenshot({
        path: "/tmp/for59-browser-failure.png",
        fullPage: true,
      })
      writeFileSync(
        "/tmp/for59-browser-failure.txt",
        await page.locator("body").innerText()
      )
    }
  }
  throw error
} finally {
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM organization WHERE id=$1", [marker])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    const leftovers = (
      await pool.query(
        'SELECT (SELECT count(*)::int FROM organization WHERE id=$1) workspaces,(SELECT count(*)::int FROM "user" WHERE id=ANY($2)) users',
        [marker, users]
      )
    ).rows[0]
    expect(leftovers).toEqual({ workspaces: 0, users: 0 })
    console.log(JSON.stringify({ cleanup: leftovers }))
  }
  await pool.end()
}

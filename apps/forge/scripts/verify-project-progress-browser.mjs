import { execFileSync } from "node:child_process"
import { del, get } from "@vercel/blob"
import { readFileSync, writeFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const authorizedRevision =
  process.env.FORGE_PROJECT_PRODUCTION_AUTHORIZED_REVISION
const production = Boolean(authorizedRevision)
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim()
if (
  production &&
  (authorizedRevision !== revision ||
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
)
  throw new Error(
    "Production verification requires a clean, exact authorized source revision."
  )
const file = production
  ? process.env.FORGE_PROJECT_PRODUCTION_DATABASE_FILE
  : process.env.FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE
if (!file) throw new Error("An explicit acceptance database file is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
const expectedHost = production
  ? "ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech"
  : "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech"
const expectedDatabase = production
  ? "neondb"
  : "forge_issue_history_acceptance"
const expectedBranch = production
  ? "br-muddy-queen-zaeeysjt"
  : "br-autumn-union-za0opf1e"
if (
  url.hostname !== expectedHost ||
  decodeURIComponent(url.pathname) !== `/${expectedDatabase}` ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Wrong acceptance database")
const base = production
    ? "https://app.forgenow.tech"
    : (process.env.FORGE_PROJECT_BROWSER_URL ?? "http://localhost:3158"),
  baseUrl = new URL(base)
if (
  !production &&
  (baseUrl.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(baseUrl.hostname) ||
    baseUrl.username ||
    baseUrl.password)
)
  throw new Error("A local acceptance server is required")
const blob = production
  ? JSON.parse(
      readFileSync(process.env.FORGE_PROJECT_PRODUCTION_BLOB_FILE, "utf8")
    )
  : null
if (
  production &&
  (blob?.storeId !== "store_z6l5eIW5xSJCsoUL" ||
    typeof blob.token !== "string" ||
    blob.token.split("_")[3] !== blob.storeId.slice(6))
)
  throw new Error("Wrong production byte store")
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection }),
  marker = `for58-${production ? "production-" : ""}browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for58-${crypto.randomUUID()}`,
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
  if (production)
    writeFileSync(
      "/tmp/for58-production-fixture.json",
      JSON.stringify({ marker, users, teamId, revision }),
      { mode: 0o600 }
    )
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR58 Acceptance',$1)",
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
    .fill("FOR58 Shared Release")
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
            "SELECT id,name,revision,properties FROM projects WHERE workspace_id=$1 AND name='FOR58 Shared Release'",
            [marker]
          )
        ).rows[0]
        return Boolean(project)
      },
      { timeout: 60000 }
    )
    .toBe(true)

  await expect(admin.getByText(/Unsaved changes — not confirmed/)).toHaveCount(
    0,
    { timeout: 60000 }
  )
  await admin.goto(`${base}/projects/${project.id}?tab=overview`)
  await expect(
    admin.getByRole("button", { name: /^(Open|Close) project details$/ })
  ).toBeVisible({ timeout: 60000 })
  if (
    await admin
      .getByRole("button", { name: "Open project details", exact: true })
      .isVisible()
  )
    await admin
      .getByRole("button", { name: "Open project details", exact: true })
      .click()
  await admin
    .getByRole("button", { name: "Add milestone", exact: true })
    .click()
  await admin
    .getByRole("textbox", { name: "Milestone name", exact: true })
    .fill("Browser release")
  await admin
    .getByRole("textbox", { name: "Milestone name", exact: true })
    .press("Enter")
  let milestone
  await expect
    .poll(
      async () => {
        const row = (
          await pool.query("SELECT properties FROM projects WHERE id=$1", [
            project.id,
          ])
        ).rows[0]
        milestone = row.properties.milestones?.[0]
        return milestone?.name
      },
      { timeout: 30000 }
    )
    .toBe("Browser release")
  await expect(admin.getByText(/Unsaved changes — not confirmed/)).toHaveCount(
    0,
    { timeout: 60000 }
  )
  await admin.goto(`${base}/settings/project-statuses`)
  await admin
    .getByRole("button", {
      name: "Create project status in In Progress",
      exact: true,
    })
    .click()
  const statusForm = admin.getByRole("form", {
    name: "Create project status",
    exact: true,
  })
  await statusForm
    .getByRole("textbox", { name: "Status name", exact: true })
    .fill("Browser review")
  await statusForm.getByRole("button", { name: "Create", exact: true }).click()
  await expect
    .poll(
      async () => {
        const rows = (
          await pool.query(
            "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND owner_id='workspace' AND key=$2",
            [marker, `forge:project-statuses:v1:${marker}`]
          )
        ).rows
        return rows.length
          ? JSON.parse(JSON.parse(rows[0].encoded_value)).statuses.some(
              (status) => status.name === "Browser review"
            )
          : false
      },
      { timeout: 30000 }
    )
    .toBe(true)
  await admin.goto(`${base}/projects/${project.id}?tab=overview`)
  await admin
    .getByRole("button", { name: "Change project status", exact: true })
    .first()
    .click()
  await admin
    .getByRole("option", { name: "Browser review", exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT properties->>'statusId' id FROM projects WHERE id=$1",
            [project.id]
          )
        ).rows[0].id,
      { timeout: 30000 }
    )
    .toBeTruthy()
  const privateTeam = crypto.randomUUID()
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Hidden','hidden','HID','private','emoji','🔥','#94a3b8','Europe/Paris',$3)",
    [privateTeam, marker, users[0]]
  )
  await pool.query(
    "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
    [marker, project.id, privateTeam]
  )
  for (const [index, team, status] of [
    [1, teamId, "done"],
    [2, teamId, "todo"],
    [1, privateTeam, "done"],
  ])
    await pool.query(
      "INSERT INTO issues(workspace_id,team_id,number,title,status_id,project_id,creator_id,properties) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        marker,
        team,
        index,
        team === privateTeam ? "FOR58 PRIVATE SECRET" : `Visible work ${index}`,
        status,
        project.id,
        users[0],
        { milestone: milestone.id },
      ]
    )
  await member.goto(`${base}/projects/${project.id}?tab=overview`)
  await expect(
    member.getByRole("button", { name: "View issues for Browser release" })
  ).toContainText("2 issues · 50%", { timeout: 60000 })
  await member.goto(`${base}/projects/${project.id}?tab=activity`)
  const composer = member.getByRole("form", {
    name: "Project activity composer",
  })
  await composer
    .getByRole("textbox", { name: "Project update", exact: true })
    .fill("FOR58 real progress update")
  await composer
    .getByLabel("Project attachments", { exact: true })
    .setInputFiles({
      name: "private-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Private project attachment acceptance"),
    })
  await expect(
    composer.getByRole("button", { name: "Post update", exact: true })
  ).toBeEnabled({ timeout: 60000 })
  await expect(
    composer.getByText("private-note.txt", { exact: true })
  ).toBeVisible()
  await expect(member.getByText(/Unsaved changes — not confirmed/)).toHaveCount(
    0,
    { timeout: 60000 }
  )
  await member.reload()
  await expect(
    composer.getByRole("textbox", { name: "Project update", exact: true })
  ).toHaveValue("FOR58 real progress update", { timeout: 60000 })
  await expect(
    composer.getByText("private-note.txt", { exact: true })
  ).toBeVisible()
  await composer
    .getByRole("button", { name: "Post update", exact: true })
    .click()
  let post, file
  await expect
    .poll(
      async () => {
        const row = (
          await pool.query("SELECT properties FROM projects WHERE id=$1", [
            project.id,
          ])
        ).rows[0]
        post = row.properties.updates?.[0]
        return post?.text
      },
      { timeout: 60000 }
    )
    .toBe("FOR58 real progress update")
  expect(post.authorId).toBe(users[1])
  expect(post.attachments).toHaveLength(1)
  file = post.attachments[0]
  expect(file.fileId).toBeTruthy()
  expect(file.data).toBeUndefined()
  await admin.goto(`${base}/projects/${project.id}?tab=activity`)
  await expect(
    admin.getByText("FOR58 real progress update", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    admin.getByRole("link", { name: "private-note.txt", exact: true })
  ).toBeVisible()
  const grant = await contexts[0].request.post(
    `${base}/api/files/resources/${file.fileId}/grant`,
    { data: { purpose: "download" }, headers: { Origin: base } }
  )
  expect(grant.ok()).toBe(true)
  const downloadUrl = (await grant.json()).url
  const bytes = await contexts[0].request.get(`${base}${downloadUrl}`)
  expect(bytes.ok()).toBe(true)
  expect(await bytes.text()).toBe("Private project attachment acceptance")
  await member.reload()
  await expect(
    member.getByText("FOR58 real progress update", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    member.getByText("50% · 1 of 2 issues completed", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await member.screenshot({
    path: "/tmp/for58-project-update.png",
    fullPage: true,
  })
  // A loaded milestone editor carries its original revision to the save queue.
  await member.goto(`${base}/projects/${project.id}?tab=overview`)
  const title = member.getByRole("textbox", {
    name: "Milestone name for Browser release",
    exact: true,
  })
  await expect(title).toHaveValue("Browser release", { timeout: 60000 })
  await title.fill("My stale milestone draft")
  await pool.query(
    "UPDATE projects SET properties=jsonb_set(properties,'{summary}',to_jsonb('Concurrent project change'::text)) WHERE id=$1",
    [project.id]
  )
  await title.blur()
  await expect(
    member.getByText(/This project changed in another session/)
  ).toBeVisible({ timeout: 30000 })
  await member
    .getByText("Review pending project changes", { exact: true })
    .click()
  await expect(
    member.getByText("My stale milestone draft", { exact: true }).last()
  ).toBeVisible()
  expect(
    (
      await pool.query(
        "SELECT properties->'milestones'->0->>'name' name FROM projects WHERE id=$1",
        [project.id]
      )
    ).rows[0].name
  ).toBe("Browser release")
  await pool.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [
    teamId,
    users[1],
  ])
  await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
    teamId,
  ])
  const denied = await contexts[1].request.post(
    `${base}/api/files/resources/${file.fileId}/grant`,
    { data: { purpose: "download" }, headers: { Origin: base } }
  )
  expect(denied.status()).toBe(404)
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-58",
      revision,
      production,
      passed: true,
      environment: identity,
      checks: [
        "two sessions",
        "shared custom status creation and assignment through UI",
        "private uploaded composer draft survives reload",
        "UI milestone creation",
        "authorized 2-issue 50% progress",
        "member authored update",
        "private direct upload, post binding and collaborator byte equality",
        "reload persistence",
        "stale milestone draft preserved",
        "revoked attachment grant denied",
      ],
    })
  )
} catch (error) {
  const pages = browser?.contexts().flatMap((c) => c.pages()) ?? []
  if (pages[0]) {
    await pages[0].screenshot({
      path: "/tmp/for58-browser-failure.png",
      fullPage: true,
    })
    const { writeFileSync } = await import("node:fs")
    writeFileSync(
      "/tmp/for58-browser-failure.txt",
      await pages[0].locator("body").innerText()
    )
  }
  throw error
} finally {
  await browser?.close()
  if (verified) {
    const refs = (
      await pool.query(
        "SELECT storage_reference FROM resource_files WHERE workspace_id=$1 UNION SELECT storage_reference FROM file_upload_intents WHERE workspace_id=$1",
        [marker]
      )
    ).rows
    const { rm } = await import("node:fs/promises")
    for (const ref of refs) {
      if (!/^files\/[0-9a-f-]{36}$/.test(ref.storage_reference))
        throw new Error("Unexpected fixture file reference")
      if (production) {
        const pathname = `forge/${ref.storage_reference}`
        await del(pathname, { token: blob.token })
        if (
          await get(pathname, {
            token: blob.token,
            access: "private",
            useCache: false,
          })
        )
          throw new Error("Fixture bytes remain")
      } else
        await rm(`/tmp/for58-private-files/${ref.storage_reference}`, {
          force: true,
        })
    }
    await pool.query("DELETE FROM file_upload_intents WHERE workspace_id=$1", [
      marker,
    ])
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

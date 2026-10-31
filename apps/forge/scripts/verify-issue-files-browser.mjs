import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file =
  process.env.FORGE_ISSUE_FILE_TEST_DATABASE_FILE ??
  process.env.FORGE_AUTO_ASSIGNMENT_TEST_DATABASE_FILE
if (!file) throw new Error("FORGE_ISSUE_FILE_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_auto_assignment_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base =
    process.env.FORGE_ISSUE_FILE_BROWSER_URL ?? "http://localhost:3148",
  baseUrl = new URL(base)
if (
  baseUrl.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(baseUrl.hostname) ||
  baseUrl.username ||
  baseUrl.password
)
  throw new Error("A local acceptance server is required")
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({
    connectionString: config.connection,
    idleTimeoutMillis: 1000,
    max: 2,
  }),
  marker = `for48-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for48-${crypto.randomUUID()}`,
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
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR48 Acceptance',$1)",
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
  const id = crypto.randomUUID()
  await pool.query(
    "INSERT INTO issues(id,workspace_id,team_id,number,title,creator_id,properties) VALUES($1,$2,$3,1,'File Alpha',$4,'{}')",
    [id, marker, teamId, users[1]]
  )
  const go = async (page) => {
    await page.goto(`${base}/teams/engineering/issues?view=all&issue=${id}`)
    await expect(
      page.getByRole("textbox", { name: "Issue title", exact: true })
    ).toHaveValue("File Alpha", { timeout: 60000 })
  }
  await go(member)
  const issueFiles = (page) => page.getByLabel("Issue files", { exact: true })
  const issueContent = Buffer.from("FOR-48 durable issue evidence")
  await issueFiles(member)
    .getByLabel("Upload attachment", { exact: true })
    .setInputFiles({
      name: "issue-evidence.txt",
      mimeType: "text/plain",
      buffer: issueContent,
    })
  await expect(
    issueFiles(member).getByRole("button", {
      name: "Download issue-evidence.txt",
      exact: true,
    })
  ).toBeVisible({ timeout: 60000 })
  await go(admin)
  const download = admin.waitForEvent("download")
  await issueFiles(admin)
    .getByRole("button", { name: "Download issue-evidence.txt", exact: true })
    .click()
  const artifact = await download
  const { readFile, rm } = await import("node:fs/promises")
  expect(await readFile(await artifact.path())).toEqual(issueContent)
  await admin.screenshot({ path: "/tmp/for48-files.png", fullPage: true })
  await issueFiles(admin)
    .getByRole("button", { name: "Preview issue-evidence.txt", exact: true })
    .click()
  const preview = admin.getByRole("dialog")
  await expect(preview.locator("iframe")).toHaveAttribute("sandbox", "")
  await expect(
    preview.locator("iframe").contentFrame().locator("body")
  ).toContainText("FOR-48 durable issue evidence")
  await admin.keyboard.press("Escape")
  // Cross the real periodic metadata refresh while a comment upload is pending.
  // The open editor and the selected bytes must survive revalidation.
  await member.route("**/api/files/uploads/*/token", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 32_000))
    await route.continue().catch(() => {})
  })
  const composer = member.getByRole("textbox", { name: "Comment", exact: true })
  await composer.fill("Comment evidence")
  const draftComposer = member
    .locator(".group\\/composer")
    .filter({ has: composer })
  await draftComposer
    .getByLabel("Upload attachment", { exact: true })
    .setInputFiles({
      name: "comment-evidence.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("FOR-48 durable comment evidence"),
    })
  await expect(
    draftComposer.getByText("comment-evidence.txt", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await member.unroute("**/api/files/uploads/*/token")
  await expect(
    draftComposer.getByRole("button", { name: "Submit comment", exact: true })
  ).toBeEnabled()
  await member.reload()
  await expect(
    member.getByText("comment-evidence.txt", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await member
    .getByRole("button", { name: "Submit comment", exact: true })
    .click()
  await expect(
    member.getByRole("button", {
      name: "Download comment-evidence.txt",
      exact: true,
    })
  ).toBeVisible({ timeout: 60000 })
  await admin.reload()
  await expect(
    admin.getByRole("button", {
      name: "Download comment-evidence.txt",
      exact: true,
    })
  ).toBeVisible({ timeout: 60000 })
  const stored = (
    await pool.query("SELECT properties FROM issues WHERE id=$1", [id])
  ).rows[0].properties
  expect(stored.attachments[0]).toMatchObject({
    data: "",
    name: "issue-evidence.txt",
  })
  expect(stored.comments[0].attachments[0]).toMatchObject({
    data: "",
    name: "comment-evidence.txt",
  })
  const fileId = stored.attachments[0].fileId
  const grant = await contexts[0].request.post(
    `${base}/api/files/resources/${fileId}/grant`,
    { data: { purpose: "download" }, headers: { Origin: base } }
  )
  expect(grant.ok()).toBe(true)
  const oldUrl = (await grant.json()).url
  await issueFiles(admin)
    .getByRole("button", { name: "Remove issue-evidence.txt", exact: true })
    .click()
  await expect(
    issueFiles(admin).getByRole("button", {
      name: "Download issue-evidence.txt",
      exact: true,
    })
  ).toHaveCount(0)
  expect((await contexts[0].request.get(`${base}${oldUrl}`)).status()).toBe(404)
  let dropped = false
  await member.route("**/*", async (route) => {
    const req = route.request(),
      body = req.postData() ?? ""
    if (
      !dropped &&
      req.method() === "POST" &&
      body.includes("fileIds") &&
      !body.includes("expectedRevision") &&
      !body.includes("forge:file-draft")
    ) {
      dropped = true
      await route.fetch()
      await route.abort("failed")
    } else await route.continue()
  })
  await issueFiles(member)
    .getByLabel("Upload attachment", { exact: true })
    .setInputFiles({
      name: "lost-evidence.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Survives a lost binding response"),
    })
  await expect(
    issueFiles(member).getByRole("button", {
      name: "Retry file change",
      exact: true,
    })
  ).toBeEnabled({ timeout: 60000 })
  expect(dropped).toBe(true)
  await member.unroute("**/*")
  await member.reload()
  await issueFiles(member)
    .getByRole("button", { name: "Retry file change", exact: true })
    .click()
  await expect(
    issueFiles(member).getByRole("button", {
      name: "Retry file change",
      exact: true,
    })
  ).toHaveCount(0)
  expect(
    (
      await pool.query(
        "SELECT properties->'attachments' files FROM issues WHERE id=$1",
        [id]
      )
    ).rows[0].files.filter((f) => f.name === "lost-evidence.txt")
  ).toHaveLength(1)
  await admin.goto(`${base}/teams/engineering/issues?view=all`)
  await admin.getByRole("button", { name: "New issue", exact: true }).click()
  await admin
    .getByRole("textbox", { name: "Issue title", exact: true })
    .fill("Files on creation")
  await admin.getByLabel("Issue attachments", { exact: true }).setInputFiles({
    name: "created-evidence.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Created with a durable file"),
  })
  await admin.getByRole("button", { name: "Create issue", exact: true }).click()
  await expect(
    admin.getByLabel("Issue attachments", { exact: true })
  ).toHaveCount(0, { timeout: 60000 })
  const created = (
    await pool.query(
      "SELECT properties FROM issues WHERE workspace_id=$1 AND title='Files on creation'",
      [marker]
    )
  ).rows
  expect(created).toHaveLength(1)
  expect(created[0].properties.attachments[0]).toMatchObject({
    data: "",
    name: "created-evidence.txt",
  })
  let expired = false
  await admin.route("**/api/files/uploads/*/finalize", async (route) => {
    const intent = new URL(route.request().url()).pathname.split("/").at(-2)
    if (!expired) {
      expired = true
      await pool.query(
        "UPDATE file_upload_intents SET state='expired',expires_at=created_at+interval '1 millisecond' WHERE id=$1 AND workspace_id=$2 AND state='pending'",
        [intent, marker]
      )
    }
    await route.continue()
  })
  await admin.goto(`${base}/teams/engineering/issues?view=all`)
  await admin.getByRole("button", { name: "New issue", exact: true }).click()
  await admin
    .getByRole("textbox", { name: "Issue title", exact: true })
    .fill("Recover refused creation files")
  await admin.getByLabel("Issue attachments", { exact: true }).setInputFiles({
    name: "retry-creation.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Recoverable creation source"),
  })
  await admin.getByRole("button", { name: "Create issue", exact: true }).click()
  await expect(
    admin.getByLabel("Issue attachments", { exact: true })
  ).toHaveCount(0, { timeout: 60000 })
  const pending = (
    await pool.query(
      "SELECT id,properties FROM issues WHERE workspace_id=$1 AND title='Recover refused creation files'",
      [marker]
    )
  ).rows
  expect(pending).toHaveLength(1)
  expect(pending[0].properties.attachments).toHaveLength(0)
  await admin.goto(
    `${base}/teams/engineering/issues?view=all&issue=${pending[0].id}`
  )
  await expect(
    admin.getByRole("button", { name: "Finish file uploads", exact: true })
  ).toBeVisible({ timeout: 60000 })
  await admin.reload()
  await expect(
    admin.getByRole("button", { name: "Finish file uploads", exact: true })
  ).toBeVisible({ timeout: 60000 })
  expect(expired).toBe(true)
  await admin.unroute("**/api/files/uploads/*/finalize")
  await admin
    .getByRole("button", { name: "Finish file uploads", exact: true })
    .click()
  await expect(
    admin.getByRole("button", {
      name: "Download retry-creation.txt",
      exact: true,
    })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    admin.getByRole("button", { name: "Finish file uploads", exact: true })
  ).toHaveCount(0)
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM issues WHERE workspace_id=$1 AND title='Recover refused creation files'",
        [marker]
      )
    ).rows[0].n
  ).toBe(1)
  await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
    teamId,
  ])
  await pool.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [
    teamId,
    users[1],
  ])
  const commentFile = stored.comments[0].attachments[0].fileId
  const denied = await contexts[1].request.post(
    `${base}/api/files/resources/${commentFile}/grant`,
    { data: { purpose: "download" }, headers: { Origin: base } }
  )
  expect(denied.status()).toBe(404)
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-48",
      passed: true,
      environment: identity,
      checks: [
        "issue upload and collaborator byte equality",
        "sandboxed authorized preview",
        "comment draft upload survives reload and binds on submit",
        "detach invalidates issued grant",
        "lost binding response replays once after reload",
        "issue creation publishes durable files",
        "expired creation upload survives reload and restarts without a duplicate issue",
        "private team access revokes file grants",
      ],
    })
  )
} finally {
  await browser?.close()
  if (verified) {
    const files = (
      await pool.query(
        "SELECT storage_reference FROM resource_files WHERE workspace_id=$1 UNION SELECT storage_reference FROM file_upload_intents WHERE workspace_id=$1",
        [marker]
      )
    ).rows
    const { rm } = await import("node:fs/promises")
    const { resolve } = await import("node:path")
    const root = process.env.FORGE_AGENT_ARTIFACT_DIRECTORY
    if (!root || !root.startsWith("/tmp/for48-"))
      throw new Error("Dedicated file directory required for cleanup")
    for (const file of files)
      await rm(resolve(root, file.storage_reference), { force: true })
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

import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const connectionFile = process.env.FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE
if (!connectionFile)
  throw new Error("FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(connectionFile, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  url.pathname !== "/forge_issue_history_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base = process.env.FORGE_IMPORT_BROWSER_URL ?? "http://localhost:3156",
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
  marker = `for56-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = crypto.randomUUID(),
  users = [`${marker}-alice`, `${marker}-bob`]
let browser,
  verified = false
try {
  const identity = (
    await pool.query(
      "SELECT current_database() db,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  if (
    identity.db !== "forge_issue_history_acceptance" ||
    identity.branch !== "br-autumn-union-za0opf1e"
  )
    throw new Error("Wrong database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR56 Acceptance',$1)",
    [marker]
  )
  for (const [index, id] of users.entries()) {
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [id, index ? "Bob Member" : "Alice Admin", `${id}@example.test`]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)",
      [crypto.randomUUID(), id, marker, index ? "member" : "admin"]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), id, await hashPassword(password)]
    )
  }
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Engineering','engineering','ENG','emoji','x','#94a3b8','Europe/Paris',$3)",
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
  const now = new Date().toISOString(),
    record = {
      id: "legacy-parent",
      number: 1,
      title: "Browser import parent",
      description: "Original local body",
      status: "todo",
      priority: "No priority",
      dueDate: "",
      parentId: "",
      createdAt: now,
      updatedAt: now,
      statusChangedAt: now,
      creator: "historical-person",
      suggestedLabel: "",
      completedAt: null,
      recurrenceSpawned: false,
      attachments: [
        {
          name: "evidence.txt",
          data: "data:text/plain;base64,Rk9SLTU2IGJyb3dzZXIgZXZpZGVuY2U=",
        },
      ],
    }
  async function saveSource(user, records) {
    await pool.query(
      "INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5)",
      [
        marker,
        `user:${user}`,
        user,
        `forge:team-issues:v1:${teamId}`,
        JSON.stringify(JSON.stringify({ version: 1, issues: records })),
      ]
    )
  }
  await saveSource(users[0], [
    record,
    {
      ...record,
      id: "legacy-child",
      title: "Browser import child",
      description: "Child source body",
      parentId: "legacy-parent",
      attachments: [],
    },
  ])
  browser = await chromium.launch({ headless: true })
  const contexts = await Promise.all(
      users.map(() =>
        browser.newContext({ viewport: { width: 1280, height: 900 } })
      )
    ),
    pages = []
  for (const [index, context] of contexts.entries()) {
    const login = await context.request.post(`${base}/api/auth/sign-in/email`, {
      data: { email: `${users[index]}@example.test`, password },
      headers: { Origin: base },
    })
    if (!login.ok()) throw new Error(`Sign in failed ${login.status()}`)
    const active = await context.request.post(
      `${base}/api/auth/organization/set-active`,
      { data: { organizationId: marker }, headers: { Origin: base } }
    )
    if (!active.ok())
      throw new Error(`Workspace selection failed ${active.status()}`)
    pages.push(await context.newPage())
  }
  const errors = []
  for (const page of pages)
    page.on("pageerror", (error) => errors.push(error.message))
  const [alice, bob] = pages
  await alice.goto(`${base}/settings/import-export`)
  await expect(
    alice.getByRole("heading", { name: "Browser import progress" })
  ).toBeVisible({ timeout: 60000 })
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
            [marker]
          )
        ).rows[0].n,
      { timeout: 60000 }
    )
    .toBe(2)
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM resource_files WHERE workspace_id=$1 AND attachment_state='attached'",
            [marker]
          )
        ).rows[0].n,
      { timeout: 60000 }
    )
    .toBe(1)
  const rows = (
      await pool.query(
        "SELECT id,parent_id,legacy_id,properties FROM issues WHERE workspace_id=$1",
        [marker]
      )
    ).rows,
    parent = rows.find((r) => r.legacy_id === "legacy-parent"),
    child = rows.find((r) => r.legacy_id === "legacy-child")
  expect(child.parent_id).toBe(parent.id)
  expect(parent.properties.attachments[0].data).toBe("")
  const grant = await contexts[1].request.post(
    `${base}/api/files/resources/${parent.properties.attachments[0].fileId}/grant`,
    { data: { purpose: "download" }, headers: { Origin: base } }
  )
  expect(grant.ok()).toBe(true)
  const { url: downloadUrl } = await grant.json(),
    download = await contexts[1].request.get(new URL(downloadUrl, base).href)
  expect(await download.text()).toBe("FOR-56 browser evidence")
  await alice.reload()
  await expect(
    alice.getByRole("heading", { name: "Browser import progress" })
  ).toBeVisible({ timeout: 60000 })
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
        [marker]
      )
    ).rows[0].n
  ).toBe(2)
  await saveSource(users[1], [
    {
      ...record,
      title: "Browser import parent",
      description: "Changed source from another profile",
      attachments: [],
    },
  ])
  await bob.goto(`${base}/settings/import-export`)
  await expect(
    bob.getByRole("button", { name: "Keep both", exact: true })
  ).toBeVisible({ timeout: 60000 })
  await bob
    .getByText("Compare source and shared records", { exact: true })
    .click()
  await expect(
    bob.getByText("Source: Changed source from another profile", {
      exact: true,
    })
  ).toBeVisible()
  await bob.screenshot({
    path: "/tmp/for56-browser-conflict.png",
    fullPage: true,
  })
  await bob.getByRole("button", { name: "Keep both", exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
            [marker]
          )
        ).rows[0].n,
      { timeout: 60000 }
    )
    .toBe(3)
  expect(
    (
      await pool.query(
        "SELECT properties->>'description' body FROM issues WHERE id=$1",
        [parent.id]
      )
    ).rows[0].body
  ).toBe("Original local body")
  await bob.reload()
  await expect(
    bob.getByRole("heading", { name: "Browser import progress" })
  ).toBeVisible({ timeout: 60000 })
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
        [marker]
      )
    ).rows[0].n
  ).toBe(3)
  await bob.setViewportSize({ width: 390, height: 844 })
  await bob.screenshot({
    path: "/tmp/for56-browser-mobile.png",
    fullPage: true,
  })
  expect(
    await bob.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "real authenticated automatic import",
        "parent remapping",
        "verified durable file",
        "reload replay",
        "cross-profile conflict review",
        "keep-both preserves shared version",
        "second reload has no duplicate",
        "mobile layout",
        "no page errors",
      ],
    })
  )
} finally {
  await browser?.close()
  if (verified) {
    const files = (
      await pool.query(
        "SELECT storage_reference FROM resource_files WHERE workspace_id=$1",
        [marker]
      )
    ).rows
    for (const file of files) {
      if (!/^files\/[0-9a-f-]{36}$/.test(file.storage_reference))
        throw new Error("Unexpected fixture file reference")
      await rm(
        resolve(
          process.env.FORGE_IMPORT_BROWSER_FILES ?? "/tmp/for56-browser-files",
          file.storage_reference
        ),
        { force: true }
      )
    }
    await pool.query("DELETE FROM file_upload_intents WHERE workspace_id=$1", [
      marker,
    ])
    await pool.query("DELETE FROM organization WHERE id=$1", [marker])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
  }
  await pool.end()
}

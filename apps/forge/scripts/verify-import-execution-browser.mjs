import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { del, get } from "@vercel/blob"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
// Production verification requires the exact reviewed source plus explicit private targets.
const production = Boolean(
  process.env.FORGE_IMPORT_PRODUCTION_AUTHORIZED_REVISION
)
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim()
if (
  production &&
  (process.env.FORGE_IMPORT_PRODUCTION_AUTHORIZED_REVISION !== revision ||
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
)
  throw new Error("A clean, exact authorized release revision is required")
const connectionFile = production
  ? process.env.FORGE_IMPORT_PRODUCTION_DATABASE_FILE
  : process.env.FORGE_ISSUE_HISTORY_TEST_DATABASE_FILE
if (!connectionFile)
  throw new Error("An explicit acceptance database file is required")
const config = JSON.parse(readFileSync(connectionFile, "utf8")),
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
  url.pathname !== `/${expectedDatabase}` ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Wrong acceptance database")
const base = production
    ? "https://app.forgenow.tech"
    : (process.env.FORGE_IMPORT_BROWSER_URL ?? "http://localhost:3156"),
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
      readFileSync(process.env.FORGE_IMPORT_PRODUCTION_BLOB_FILE, "utf8")
    )
  : null
if (
  production &&
  (!blob ||
    typeof blob !== "object" ||
    typeof blob.token !== "string" ||
    blob.storeId !== "store_z6l5eIW5xSJCsoUL" ||
    blob.token.split("_")[3] !== blob.storeId.slice(6))
)
  throw new Error("Wrong production byte store")
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection }),
  marker = `for56-${production ? "production-" : ""}browser-${crypto.randomUUID()}`,
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
  if (identity.db !== expectedDatabase || identity.branch !== expectedBranch)
    throw new Error("Wrong database")
  verified = true
  if (production)
    writeFileSync(
      "/tmp/for56-production-fixture.json",
      JSON.stringify({ marker, users, teamId, revision }),
      { mode: 0o600 }
    )
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
      project: "legacy-project",
      cycle: "2026-10-01",
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
  await pool.query(
    "INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5)",
    [
      marker,
      `user:${users[0]}`,
      users[0],
      `forge:workspace:${marker}:initiatives:v1`,
      JSON.stringify(
        JSON.stringify({
          version: 1,
          initiatives: [],
          workspaceProjects: [
            {
              id: "legacy-project",
              name: "Browser imported project",
              teamIds: [teamId],
              status: "Planned",
              health: "On track",
              leadId: users[0],
            },
          ],
        })
      ),
    ]
  )
  await pool.query(
    "INSERT INTO product_state(workspace_id,owner_id,key,encoded_value) VALUES($1,'workspace',$2,$3)",
    [
      marker,
      `forge:team-cycles:v1:${teamId}`,
      JSON.stringify(
        JSON.stringify({
          enabled: false,
          timezone: "Asia/Tokyo",
          duration: 3,
          cooldown: 2,
          startDay: 1,
          futureCycles: 2,
          activeIssues: false,
          startedIssues: true,
          completedIssues: true,
        })
      ),
    ]
  )
  const publishedId = crypto.randomUUID(),
    published = {
      ...record,
      id: "published",
      title: "Published legacy issue",
      description: "Browser source version",
      project: "",
      cycle: "",
      attachments: [
        {
          id: "source-anchor",
          name: "published.txt",
          data: record.attachments[0].data,
          width: 40,
        },
      ],
    }
  await pool.query(
    "INSERT INTO issues(id,workspace_id,team_id,number,title,status_id,creator_id,legacy_id,properties) VALUES($1,$2,$3,99,$4,'todo',$5,'published',$6)",
    [
      publishedId,
      marker,
      teamId,
      published.title,
      users[0],
      {
        ...published,
        description: "Existing shared body",
        comments: [],
        attachments: [
          { ...published.attachments[0], id: "shared-anchor", width: 60 },
        ],
      },
    ]
  )
  await pool.query(
    "INSERT INTO team_issue_numbers(team_id,last_number) VALUES($1,99) ON CONFLICT(team_id) DO UPDATE SET last_number=99",
    [teamId]
  )
  await saveSource(users[0], [
    published,
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
    .toBe(3)
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
        "SELECT id,parent_id,project_id,cycle_id,legacy_id,properties FROM issues WHERE workspace_id=$1",
        [marker]
      )
    ).rows,
    parent = rows.find((r) => r.legacy_id === "legacy-parent"),
    child = rows.find((r) => r.legacy_id === "legacy-child")
  expect(child.parent_id).toBe(parent.id)
  const project = (
    await pool.query(
      "SELECT id FROM projects WHERE workspace_id=$1 AND legacy_id='legacy-project'",
      [marker]
    )
  ).rows[0]
  expect(parent.project_id).toBe(project.id)
  expect(child.project_id).toBe(project.id)
  const cycle = (
    await pool.query(
      "SELECT id,start_date,end_date,timezone FROM issue_cycles WHERE team_id=$1",
      [teamId]
    )
  ).rows[0]
  expect(cycle).toMatchObject({
    start_date: "2026-10-01",
    end_date: "2026-10-21",
    timezone: "Asia/Tokyo",
  })
  expect(parent.cycle_id).toBe(cycle.id)
  expect(child.cycle_id).toBe(cycle.id)
  await alice
    .getByRole("button", { name: "Convert existing files", exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT properties->'attachments'->0->>'fileId' id FROM issues WHERE id=$1",
            [publishedId]
          )
        ).rows[0].id,
      { timeout: 60000 }
    )
    .toBeTruthy()
  const converted = (
    await pool.query("SELECT properties FROM issues WHERE id=$1", [publishedId])
  ).rows[0].properties
  expect(converted.description).toBe("Existing shared body")
  expect(converted.attachments[0]).toMatchObject({
    id: "shared-anchor",
    width: 60,
    data: "",
  })
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
  ).toBe(3)
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
    .toBe(4)
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
  ).toBe(4)
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
      revision,
      production,
      checks: [
        "real authenticated automatic import",
        "parent remapping",
        "canonical project membership",
        "saved-settings cycle reconstruction",
        "same-issue conversion preserves shared fields, anchors and width",
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
        "SELECT storage_reference FROM resource_files WHERE workspace_id=$1 UNION SELECT storage_reference FROM file_upload_intents WHERE workspace_id=$1",
        [marker]
      )
    ).rows
    for (const file of files) {
      if (!/^files\/[0-9a-f-]{36}$/.test(file.storage_reference))
        throw new Error("Unexpected fixture file reference")
      if (production) {
        await del(`forge/${file.storage_reference}`, { token: blob.token })
        if (
          await get(`forge/${file.storage_reference}`, {
            token: blob.token,
            access: "private",
            useCache: false,
          })
        )
          throw new Error("Fixture bytes remain")
      } else
        await rm(
          resolve(
            process.env.FORGE_IMPORT_BROWSER_FILES ??
              "/tmp/for56-browser-files",
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
    const leftovers = (
      await pool.query(
        'SELECT (SELECT count(*)::int FROM organization WHERE id=$1) workspaces,(SELECT count(*)::int FROM "user" WHERE id=ANY($2)) users,(SELECT count(*)::int FROM legacy_imports WHERE workspace_id=$1) manifests,(SELECT count(*)::int FROM command_receipts WHERE workspace_id=$1) receipts',
        [marker, users]
      )
    ).rows[0]
    if (Object.values(leftovers).some((value) => value !== 0))
      throw new Error("Fixture cleanup incomplete")
    console.log(JSON.stringify({ cleanup: leftovers }))
  }
  await pool.end()
}

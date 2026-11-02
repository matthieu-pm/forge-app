import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"

const authorizedRevision =
  process.env.FORGE_RESOURCE_PRODUCTION_AUTHORIZED_REVISION
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
    "Production acceptance requires a clean exact authorized source revision."
  )
const file = production
  ? process.env.FORGE_RESOURCE_PRODUCTION_DATABASE_FILE
  : process.env.FORGE_RESOURCE_TEST_DATABASE_FILE
if (!file)
  throw new Error("An explicit resource acceptance database file is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
const expectedHost = production
    ? "ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech"
    : "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech",
  expectedDatabase = production ? "neondb" : "forge_resources_loops_acceptance",
  expectedBranch = production
    ? "br-muddy-queen-zaeeysjt"
    : "br-autumn-union-za0opf1e"
if (
  url.hostname !== expectedHost ||
  decodeURIComponent(url.pathname) !== `/${expectedDatabase}` ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Wrong resource acceptance database")
const base = production
    ? "https://app.forgenow.tech"
    : (process.env.FORGE_RESOURCE_BROWSER_URL ?? "http://localhost:3162"),
  baseUrl = new URL(base)
if (
  !production &&
  (baseUrl.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(baseUrl.hostname) ||
    baseUrl.username ||
    baseUrl.password)
)
  throw new Error("A local resource acceptance server is required")
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection }),
  marker = `for62-resources-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for62-${crypto.randomUUID()}`,
  users = [marker + "-alice", marker + "-bob"]
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
    throw new Error("Wrong resource database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR62 Resources Acceptance',$1)",
    [marker]
  )
  await pool.query(
    "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'enterprise','active')",
    [marker]
  )
  for (let i = 0; i < users.length; i++) {
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [
        users[i],
        i === 0 ? "Alice Admin" : "Bob Member",
        users[i] + "@example.test",
      ]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)",
      [crypto.randomUUID(), users[i], marker, i === 0 ? "admin" : "member"]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), users[i], await hashPassword(password)]
    )
  }
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Engineering','engineering','ENG','private','emoji','⚙️','#94a3b8','Europe/Paris',$3)",
    [teamId, marker, users[0]]
  )
  for (const userId of users)
    await pool.query(
      "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member')",
      [crypto.randomUUID(), marker, teamId, userId]
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
        data: { email: users[i] + "@example.test", password },
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
  const [alice, bob] = await Promise.all(contexts.map((c) => c.newPage())),
    errors = []
  for (const page of [alice, bob])
    page.on("pageerror", (error) => errors.push(error.message))
  const home = async (page) => {
    await page.goto(`${base}/teams/engineering/overview`)
    await expect(
      page.getByRole("button", { name: "Add section", exact: true })
    ).toBeEnabled({ timeout: 60000 })
  }
  const addSection = async (page, name) => {
    await page.getByRole("button", { name: "Add section", exact: true }).click()
    await page
      .getByRole("textbox", { name: "Section name", exact: true })
      .fill(name)
    await page
      .getByRole("button", { name: "Save section", exact: true })
      .click()
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30000 })
  }
  const board = async () =>
    (
      await pool.query(
        "SELECT fields,revision FROM team_resource_boards WHERE workspace_id=$1 AND team_id=$2",
        [marker, teamId]
      )
    ).rows[0]
  await home(alice)
  await addSection(alice, "Guides")
  await addSection(alice, "Plans")
  const sections = (await board()).fields.sections,
    guideId = sections.find((s) => s.name === "Guides").id,
    plansId = sections.find((s) => s.name === "Plans").id
  const section = (page, id) => page.locator(`[data-section-id="${id}"]`)
  await section(alice, guideId)
    .getByRole("button", { name: "Add resources", exact: true })
    .click()
  await alice.getByRole("menuitem", { name: "New link…", exact: true }).click()
  await alice
    .getByRole("textbox", { name: "Resource title", exact: true })
    .fill("Team handbook")
  await alice
    .getByRole("textbox", { name: "URL", exact: true })
    .fill(" https://EXAMPLE.com/handbook ")
  await alice.getByRole("button", { name: "Save link", exact: true }).click()
  await expect(alice.getByRole("dialog")).toHaveCount(0, { timeout: 30000 })
  await alice
    .getByRole("button", { name: "Actions for Plans section", exact: true })
    .click()
  await alice.getByRole("menuitem", { name: "Move up", exact: true }).click()
  await expect
    .poll(async () => (await board()).fields.sections.map((s) => s.name), {
      timeout: 30000,
    })
    .toEqual(["Plans", "Guides"])
  await home(bob)
  await expect(bob.locator("[data-section-id]").first()).toContainText("Plans")
  await expect(
    section(bob, guideId).getByRole("link", {
      name: "Team handbook",
      exact: true,
    })
  ).toHaveAttribute("href", "https://example.com/handbook")
  // Document creation and membership use the FOR-61 canonical editor and revision checks.
  await section(alice, guideId)
    .getByRole("button", { name: "Add resources", exact: true })
    .click()
  await alice
    .getByRole("menuitem", { name: "New document", exact: true })
    .click()
  await alice
    .getByRole("textbox", { name: "Document title", exact: true })
    .fill("FOR62 Shared document")
  await alice
    .getByRole("textbox", { name: "Document content", exact: true })
    .fill("Canonical resource membership")
  const documentRow = async () =>
    (
      await pool.query(
        "SELECT id,title,content,section_id,revision FROM documents WHERE workspace_id=$1 AND deleted_at IS NULL",
        [marker]
      )
    ).rows[0]
  await expect
    .poll(async () => (await documentRow())?.content, { timeout: 30000 })
    .toBe("Canonical resource membership")
  const doc = await documentRow()
  expect(doc.section_id).toBe(guideId)
  await bob.goto(`${base}/teams/engineering/documents?document=${doc.id}`)
  await expect(bob.getByLabel("Document section", { exact: true })).toBeVisible(
    { timeout: 60000 }
  )
  await bob
    .getByLabel("Document section", { exact: true })
    .selectOption(plansId)
  await expect
    .poll(async () => (await documentRow()).section_id, { timeout: 30000 })
    .toBe(plansId)
  await home(bob)
  await expect(
    section(bob, plansId).getByRole("button", {
      name: "FOR62 Shared document",
      exact: true,
    })
  ).toBeVisible()
  // Unsafe navigation is rejected before any command is committed.
  await bob
    .getByRole("button", { name: "Add resources", exact: true })
    .first()
    .click()
  await bob.getByRole("menuitem", { name: "New link…", exact: true }).click()
  await bob
    .getByRole("textbox", { name: "Resource title", exact: true })
    .fill("Unsafe link")
  await bob
    .getByRole("textbox", { name: "URL", exact: true })
    .fill("javascript:alert(1)")
  await bob.getByRole("button", { name: "Save link", exact: true }).click()
  await expect(bob.getByRole("dialog").getByRole("alert")).toContainText(
    "http or https"
  )
  expect(
    (await board()).fields.links.some((link) => link.title === "Unsafe link")
  ).toBe(false)
  await bob
    .getByRole("dialog")
    .locator("form")
    .getByRole("button", { name: "Close", exact: true })
    .click()
  // A failed transport is retained on this device and confirmed with the same retry key after reload.
  await bob.route("**/*", async (route) => {
    const request = route.request()
    if (
      request.method() === "POST" &&
      request.postData()?.includes("Network recovery section")
    )
      await route.abort("failed")
    else await route.continue()
  })
  await bob.getByRole("button", { name: "Add section", exact: true }).click()
  await bob
    .getByRole("textbox", { name: "Section name", exact: true })
    .fill("Network recovery section")
  await bob.getByRole("button", { name: "Save section", exact: true }).click()
  await expect(
    bob
      .getByRole("dialog")
      .getByRole("button", { name: "Retry resource save", exact: true })
  ).toBeVisible({ timeout: 30000 })
  await bob.unrouteAll({ behavior: "wait" })
  await bob.reload()
  await expect(
    bob.getByRole("button", { name: "Retry resource save", exact: true })
  ).toBeVisible({ timeout: 60000 })
  await bob
    .getByRole("button", { name: "Retry resource save", exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (await board()).fields.sections.filter(
          (s) => s.name === "Network recovery section"
        ).length,
      { timeout: 30000 }
    )
    .toBe(1)
  await expect(
    bob.getByRole("button", { name: "Retry resource save", exact: true })
  ).toHaveCount(0, { timeout: 30000 })
  // Hold one proposal while another member commits a newer board.
  let release,
    held = false
  const barrier = new Promise((resolve) => {
    release = resolve
  })
  await bob.route("**/*", async (route) => {
    const request = route.request()
    if (
      request.method() === "POST" &&
      request.postData()?.includes("Bob conflicting proposal") &&
      !held
    ) {
      held = true
      await barrier
    }
    await route.continue()
  })
  await bob.getByRole("button", { name: "Add section", exact: true }).click()
  await bob
    .getByRole("textbox", { name: "Section name", exact: true })
    .fill("Bob conflicting proposal")
  await bob.getByRole("button", { name: "Save section", exact: true }).click()
  await expect.poll(() => held, { timeout: 10000 }).toBe(true)
  await home(alice)
  await addSection(alice, "Alice newer section")
  release()
  await expect(
    bob
      .getByRole("dialog")
      .getByRole("button", { name: "Review latest resources", exact: true })
  ).toBeVisible({ timeout: 30000 })
  await expect(
    bob.getByRole("textbox", { name: "Section name", exact: true })
  ).toHaveValue("Bob conflicting proposal")
  expect(
    (await board()).fields.sections.some(
      (s) => s.name === "Bob conflicting proposal"
    )
  ).toBe(false)
  await bob.screenshot({
    path: production
      ? "/private/tmp/for62-production-resources-conflict.png"
      : "/private/tmp/for62-resources-conflict.png",
    fullPage: true,
  })
  await bob.unrouteAll({ behavior: "wait" })
  await bob.reload()
  await bob
    .getByRole("button", { name: "Retry resource save", exact: true })
    .click()
  await expect(
    bob.getByRole("button", { name: "Review latest resources", exact: true })
  ).toBeVisible({ timeout: 30000 })
  await bob
    .getByRole("button", { name: "Review latest resources", exact: true })
    .click()
  await expect(
    bob.getByRole("button", { name: "Add section", exact: true })
  ).toBeEnabled()
  // Removing navigation structure keeps the canonical document and its text revision.
  await home(alice)
  const before = await documentRow()
  await alice
    .getByRole("button", { name: "Actions for Plans section", exact: true })
    .click()
  await alice
    .getByRole("menuitem", {
      name: "Delete section · keep resources",
      exact: true,
    })
    .click()
  await expect
    .poll(
      async () => (await board()).fields.sections.some((s) => s.id === plansId),
      { timeout: 30000 }
    )
    .toBe(false)
  expect((await documentRow()).revision).toBe(before.revision)
  await home(bob)
  await expect(
    bob.getByRole("button", { name: "FOR62 Shared document", exact: true })
  ).toBeVisible()
  await bob.screenshot({
    path: production
      ? "/private/tmp/for62-production-resources-shared.png"
      : "/private/tmp/for62-resources-shared.png",
    fullPage: true,
  })
  await bob.setViewportSize({ width: 390, height: 844 })
  expect(
    await bob.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await bob.screenshot({
    path: production
      ? "/private/tmp/for62-production-resources-mobile.png"
      : "/private/tmp/for62-resources-mobile.png",
    fullPage: true,
  })
  // An old open editor must stop showing protected source data after team revocation.
  await bob.setViewportSize({ width: 1280, height: 900 })
  await bob
    .getByRole("button", { name: "Actions for Team handbook", exact: true })
    .click()
  await bob.getByRole("menuitem", { name: "Edit link", exact: true }).click()
  await pool.query(
    "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
    [marker, teamId, users[1]]
  )
  await bob.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(bob.getByRole("dialog")).toHaveCount(0, { timeout: 30000 })
  await expect(
    bob.getByRole("link", { name: "Team handbook", exact: true })
  ).toHaveCount(0)
  expect(
    errors.filter(
      (error) =>
        !error.includes("Failed to fetch") && !error.includes("path.endsWith")
    )
  ).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-62",
      slice: "resources",
      revision,
      target: production ? "production" : "local acceptance",
      passed: true,
      environment: identity,
      checks: [
        "two authenticated sessions",
        "ordinary member manages resources",
        "shared sections and order",
        "safe normalized links",
        "canonical document membership",
        "unsafe URL rejection",
        "network failure reload and exact retry",
        "conflict proposal retained through reload",
        "section deletion preserves document revision",
        "revoked open editor hidden",
        "mobile no horizontal overflow",
      ],
    })
  )
} finally {
  await browser?.close()
  if (verified) {
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

import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { chromium, expect as browserExpect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"

// Production reloads can include shared-definition hydration before the editor mounts.
const expect = browserExpect.configure({ timeout: 30000 })

const authorizedRevision =
  process.env.FORGE_PROFILE_PRODUCTION_AUTHORIZED_REVISION
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
    "Production verification requires a clean checkout at its exact authorized source revision"
  )
const file = production
  ? process.env.FORGE_PROFILE_PRODUCTION_DATABASE_FILE
  : process.env.FORGE_PROFILE_TEST_DATABASE_FILE
if (!file) throw new Error("An explicit acceptance database file is required")
const expectedHost = production
  ? "ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech"
  : "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech"
const expectedDatabase = production ? "neondb" : "forge_templates_acceptance"
const expectedBranch = production
  ? "br-muddy-queen-zaeeysjt"
  : "br-autumn-union-za0opf1e"
const config = JSON.parse(readFileSync(file, "utf8"))
for (const connection of [config.connection, config.applicationConnection]) {
  const url = new URL(connection)
  if (
    url.hostname.replace("-pooler.", ".") !== expectedHost ||
    url.pathname !== `/${expectedDatabase}` ||
    url.searchParams.get("sslmode") !== "require"
  )
    throw new Error("Wrong profile acceptance database")
}
const base = production
  ? "https://app.forgenow.tech"
  : (process.env.FORGE_PROFILE_BROWSER_URL ?? "http://localhost:3102")
const url = new URL(base)
if (
  !production &&
  (url.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.username ||
    url.password)
)
  throw new Error("Local profile acceptance server required")
const artifacts = production ? "/tmp/for102-production" : "../../.forge/for102"
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection })
const marker = `for102-browser-${crypto.randomUUID()}`,
  alice = `${marker}-alice`,
  bob = `${marker}-bob`,
  password = crypto.randomUUID()
let browser,
  verified = false
const errors = []
try {
  const identity = (
    await pool.query(
      "SELECT current_database() database,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  expect(identity).toEqual({
    database: expectedDatabase,
    branch: expectedBranch,
  })
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR102 Acceptance',$1)",
    [marker]
  )
  await pool.query(
    "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'enterprise','active')",
    [marker]
  )
  for (const id of [alice, bob]) {
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [id, id === alice ? "Alice Owner" : "Bob Member", `${id}@example.test`]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,'member')",
      [crypto.randomUUID(), id, marker]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), id, await hashPassword(password)]
    )
  }
  browser = await chromium.launch({ headless: true })
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ])
  for (const [index, context] of contexts.entries()) {
    const id = index === 2 ? bob : alice
    const login = await context.request.post(`${base}/api/auth/sign-in/email`, {
      data: { email: `${id}@example.test`, password },
      headers: { Origin: base },
    })
    expect(login.status()).toBe(200)
    const active = await context.request.post(
      `${base}/api/auth/organization/set-active`,
      { data: { organizationId: marker }, headers: { Origin: base } }
    )
    expect(active.status()).toBe(200)
  }
  const pages = await Promise.all(contexts.map((context) => context.newPage()))
  for (const page of pages) {
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${base}/settings/profile`)
    await expect(page.getByLabel("Title", { exact: true })).toBeEnabled({
      timeout: 60000,
    })
  }
  const [owner, otherSession, otherAccount] = pages
  await owner.getByLabel("Full name", { exact: true }).fill("Alice Canonical")
  await owner.getByLabel("Title", { exact: true }).fill("Product engineer")
  const username = `for102_${crypto.randomUUID().slice(0, 8)}`
  await owner.getByLabel("Username", { exact: true }).fill(username)
  const takenUsername = `taken_${crypto.randomUUID().slice(0, 8)}`
  await pool.query('UPDATE "user" SET username=$1 WHERE id=$2', [
    takenUsername,
    bob,
  ])
  await owner.getByLabel("Username", { exact: true }).fill(takenUsername)
  await owner.getByRole("button", { name: "Save profile", exact: true }).click()
  await expect(owner.getByRole("alert")).toContainText("already in use")
  await expect(owner.getByLabel("Username", { exact: true })).toBeEnabled()
  await expect(owner.getByLabel("Title", { exact: true })).toHaveValue(
    "Product engineer"
  )
  await owner.getByLabel("Username", { exact: true }).fill(username)
  await owner.getByRole("button", { name: "Save profile", exact: true }).click()
  await expect
    .poll(
      async () =>
        (await pool.query('SELECT title FROM "user" WHERE id=$1', [alice]))
          .rows[0].title
    )
    .toBe("Product engineer")
  await expect(
    owner.getByRole("button", { name: "Save profile", exact: true })
  ).toBeDisabled()
  await otherSession.getByLabel("Title", { exact: true }).fill("Stale draft")
  await otherSession
    .getByRole("button", { name: "Save profile", exact: true })
    .click()
  await expect(otherSession.getByRole("alert")).toContainText(
    "changed in another session"
  )
  await expect(otherSession.getByLabel("Title", { exact: true })).toHaveValue(
    "Stale draft"
  )
  await otherSession
    .getByRole("button", { name: "Discard draft and load latest profile" })
    .click()
  await otherSession.reload()
  await expect(otherSession.getByLabel("Title", { exact: true })).toHaveValue(
    "Product engineer",
    { timeout: 30000 }
  )
  await expect(
    otherSession.getByLabel("Full name", { exact: true })
  ).toHaveValue("Alice Canonical")
  await expect(
    otherSession.getByLabel("Username", { exact: true })
  ).toHaveValue(username)
  await otherAccount.reload()
  await expect(otherAccount.getByLabel("Title", { exact: true })).toHaveValue(
    ""
  )
  await expect(
    otherAccount.getByLabel("Full name", { exact: true })
  ).toHaveValue("Bob Member")

  await owner.getByLabel("Title", { exact: true }).fill("Offline draft")
  await contexts[0].setOffline(true)
  await owner.getByRole("button", { name: "Save profile", exact: true }).click()
  await expect(
    owner.getByRole("button", { name: "Retry profile update" })
  ).toBeVisible()
  await contexts[0].setOffline(false)
  await owner.getByRole("button", { name: "Retry profile update" }).click()
  await expect
    .poll(
      async () =>
        (await pool.query('SELECT title FROM "user" WHERE id=$1', [alice]))
          .rows[0].title
    )
    .toBe("Offline draft")
  await expect(
    owner.getByRole("button", { name: "Save profile", exact: true })
  ).toBeDisabled()

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=",
    "base64"
  )
  await owner
    .getByLabel("Upload profile picture")
    .setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: png })
  await owner.getByRole("button", { name: "Save profile", exact: true }).click()
  await expect
    .poll(
      async () =>
        (await pool.query('SELECT image FROM "user" WHERE id=$1', [alice]))
          .rows[0].image
    )
    .toMatch(/^data:image\/png;base64,/)
  await expect(
    owner.getByRole("button", { name: "Save profile", exact: true })
  ).toBeDisabled()
  await owner.reload()
  await expect(owner.getByLabel("Title", { exact: true })).toHaveValue(
    "Offline draft"
  )
  await expect(
    owner.getByRole("button", { name: "Change profile picture" })
  ).toBeEnabled()
  for (const body of [
    { userId: bob, title: "Hijacked" },
    { role: "owner" },
    { image: "https://example.test/unsafe.svg" },
  ]) {
    const response = await contexts[0].request.post(
      `${base}/api/auth/update-user`,
      { data: body, headers: { Origin: base } }
    )
    expect(response.status()).toBe(403)
  }
  expect(
    (
      await pool.query(
        "SELECT role FROM member WHERE user_id=$1 AND organization_id=$2",
        [alice, marker]
      )
    ).rows[0].role
  ).toBe("member")
  expect(errors).toEqual([])
  mkdirSync(artifacts, { recursive: true })
  await owner.screenshot({
    path: `${artifacts}/profile-settings.png`,
    fullPage: true,
  })
  writeFileSync(
    `${artifacts}/browser-evidence.json`,
    JSON.stringify(
      {
        status: "passed",
        sourceRevision: revision,
        target: production ? "production" : "local",
        environment: identity,
        checks: [
          "real Better Auth sign-in",
          "two owner sessions reload canonical profile",
          "other account isolation",
          "stale edit conflict and explicit discard",
          "offline retry",
          "raster avatar persistence",
          "taken username rejected without locking or losing the draft",
          "unversioned auth endpoint denied",
        ],
        pageErrors: errors,
      },
      null,
      2
    )
  )
  console.log("FOR-102 authenticated Chromium acceptance passed")
} finally {
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM organization WHERE id=$1", [marker])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[alice, bob]])
    const cleanup = (
      await pool.query(
        'SELECT (SELECT count(*)::int FROM "user" WHERE id=ANY($1)) users,(SELECT count(*)::int FROM command_receipts WHERE user_id=ANY($1)) receipts',
        [[alice, bob]]
      )
    ).rows[0]
    expect(cleanup).toEqual({ users: 0, receipts: 0 })
    console.log("FOR-102 fixture cleanup verified")
  }
  await pool.end()
}

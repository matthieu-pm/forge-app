import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { neon } from "@neondatabase/serverless"
import { chromium } from "@playwright/test"

const repositoryRoot = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../.."
)
config({ path: resolve(repositoryRoot, ".env"), quiet: true })
config({
  path: resolve(repositoryRoot, ".env.local"),
  override: true,
  quiet: true,
})

const origin = new URL(
  process.env.FORGE_VERIFY_ORIGIN ?? "http://localhost:3100"
).origin
assert.ok(
  ["localhost", "127.0.0.1"].includes(new URL(origin).hostname),
  "Run this smoke test against a local app."
)
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required.")
const sql = neon(process.env.DATABASE_URL)
const marker = `neon-smoke-${randomUUID()}`
const email = `${marker}@example.test`
const password = randomUUID() + randomUUID()
const artifactDirectory = resolve(repositoryRoot, ".forge/neon-verification")
await mkdir(artifactDirectory, { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ baseURL: origin })
const page = await context.newPage()
page.setDefaultTimeout(20_000)
const browserErrors = []
page.on("pageerror", (error) => browserErrors.push(error.stack ?? error.message))
let workspaceId
const pass = (message) => console.log(`PASS ${message}`)

async function authRequest(path, data) {
  const response = await context.request.post(`/api/auth/${path}`, {
    headers: { origin },
    data,
  })
  assert.ok(
    response.ok(),
    `${path}: HTTP ${response.status()} ${await response.text()}`
  )
  return response.json()
}

try {
  const migrations =
    await sql`select count(*)::int as count from drizzle.__drizzle_migrations`
  assert.ok(migrations[0].count >= 26)
  pass(`Postgres connected; ${migrations[0].count} migrations applied`)

  await page.goto("/inbox")
  await page.waitForURL("**/login**")
  pass("Unauthenticated protected page redirects to login")

  const anonymous = await context.request.get("/api/auth/get-session")
  assert.equal(await anonymous.json(), null)
  pass("Unauthenticated session endpoint returns null")

  await page.goto("/signup")
  await page.getByLabel("Name", { exact: true }).fill("Neon verification")
  await page.getByLabel("Email", { exact: true }).fill(email)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click()
  await page.waitForURL("**/onboarding/workspace")
  const users = await sql`select id from "user" where email = ${email}`
  assert.equal(users.length, 1)
  const userId = users[0].id
  const accounts =
    await sql`select id from account where user_id = ${userId} and provider_id = 'credential' and password is not null`
  assert.equal(accounts.length, 1)
  pass(
    "Browser signup creates a user and hashed credential in the new database"
  )

  await page.getByLabel("Workspace name", { exact: true }).fill(marker)
  await page
    .getByText("Workspace slug is available.", { exact: true })
    .waitFor()
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click()
  await page.waitForURL("**/inbox")
  const workspaces =
    await sql`select id from organization where slug = ${marker}`
  assert.equal(workspaces.length, 1)
  workspaceId = workspaces[0].id
  const membership =
    await sql`select role from member where organization_id = ${workspaceId} and user_id = ${userId}`
  assert.equal(membership[0].role, "owner")
  pass("Browser workspace creation persists the workspace and owner membership")

  await page.reload()
  await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor()
  const restored = await context.request.get("/api/auth/get-session")
  const restoredSession = await restored.json()
  assert.equal(restoredSession.user.id, userId)
  assert.equal(restoredSession.session.activeOrganizationId, workspaceId)
  await page.screenshot({
    path: resolve(artifactDirectory, "inbox.png"),
    fullPage: true,
  })
  pass("Reload restores the database-backed session and active workspace")

  await authRequest("organization/update", {
    organizationId: workspaceId,
    data: { name: `${marker} updated` },
  })
  const updated =
    await sql`select name from organization where id = ${workspaceId}`
  assert.equal(updated[0].name, `${marker} updated`)
  pass(
    "Authenticated workspace update is persisted and independently read from Postgres"
  )

  await authRequest("sign-out", {})
  const signedOut = await context.request.get("/api/auth/get-session")
  assert.equal(await signedOut.json(), null)
  const sessions = await sql`select id from session where user_id = ${userId}`
  assert.equal(sessions.length, 0)
  await page.goto("/inbox")
  await page.waitForURL("**/login**")
  pass("Sign-out deletes the session and protected access is denied")

  const rejected = await context.request.post("/api/auth/sign-in/email", {
    headers: { origin },
    data: { email, password: randomUUID() },
  })
  assert.equal(rejected.status(), 401)
  pass("Incorrect password is rejected with HTTP 401")

  await page.getByLabel("Email", { exact: true }).fill(email)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.waitForURL("**/inbox")
  await page.reload()
  await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor()
  pass("Browser password sign-in restores protected access after reload")

  assert.deepEqual(browserErrors, [])
  pass("No browser JavaScript errors")

  // Managed Auth is intentionally not the app's identity provider. Verify its
  // provisioned URL without creating a second identity or claiming a login test.
  assert.ok(process.env.NEON_AUTH_JWKS_URL)
  const jwks = await fetch(process.env.NEON_AUTH_JWKS_URL)
  assert.equal(jwks.status, 200)
  assert.ok((await jwks.json()).keys.length > 0)
  pass(
    "Provisioned managed Neon Auth publishes JWKS (not used for Forge login)"
  )
} catch (error) {
  await page
    .screenshot({
      path: resolve(artifactDirectory, "failure.png"),
      fullPage: true,
    })
    .catch(() => {})
  throw error
} finally {
  await browser.close()
  // Match only this run's random identifiers, including after a partial failure.
  await sql`delete from organization where slug = ${marker}`
  await sql`delete from "user" where email = ${email}`
  const remaining = await sql`select id from "user" where email = ${email}`
  assert.equal(remaining.length, 0)
  const remainingWorkspaces =
    await sql`select id from organization where slug = ${marker}`
  assert.equal(remainingWorkspaces.length, 0)
  pass("Temporary test user, workspace, credentials, and sessions cleaned up")
}

console.log("Neon end-to-end verification passed.")

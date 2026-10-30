import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const connectionFile = process.env.FORGE_PREFERENCE_TEST_DATABASE_FILE
if (!connectionFile)
  throw new Error("FORGE_PREFERENCE_TEST_DATABASE_FILE is required.")
const config = JSON.parse(
  (await import("node:fs")).readFileSync(connectionFile, "utf8")
)
const connectionUrl = new URL(config.connection)
if (
  connectionUrl.hostname !==
    "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(connectionUrl.pathname) !==
    "/forge_preferences_acceptance" ||
  connectionUrl.searchParams.get("sslmode") !== "require"
)
  throw new Error(
    "Only the dedicated preference acceptance database is allowed."
  )
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection })
const marker = `for127-browser-${crypto.randomUUID()}`
const base = process.env.FORGE_PREFERENCE_BROWSER_URL ?? "http://localhost:3017"
const baseUrl = new URL(base)
if (
  baseUrl.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(baseUrl.hostname) ||
  baseUrl.username ||
  baseUrl.password
)
  throw new Error("Browser verification requires a local development server.")
const password = `for127-${crypto.randomUUID()}`
const users = [`${marker}-alice`, `${marker}-bob`]
let browser,
  verified = false
try {
  const identity = (
    await pool.query(
      "SELECT current_database() AS database,current_setting('neon.branch_id',true) AS branch"
    )
  ).rows[0]
  if (
    identity.database !== "forge_preferences_acceptance" ||
    identity.branch !== "br-autumn-union-za0opf1e"
  )
    throw new Error("Wrong database")
  verified = true
  await pool.query("INSERT INTO organization(id,name,slug) VALUES($1,$2,$1)", [
    marker,
    "FOR127 Browser Acceptance",
  ])
  for (const user of users) {
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [user, user.endsWith("alice") ? "Alice" : "Bob", `${user}@example.test`]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,'owner')",
      [crypto.randomUUID(), user, marker]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), user, await hashPassword(password)]
    )
  }
  browser = await chromium.launch({ headless: true })
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ])
  for (let i = 0; i < contexts.length; i++) {
    const response = await contexts[i].request.post(
      `${base}/api/auth/sign-in/email`,
      {
        data: { email: `${users[i === 2 ? 1 : 0]}@example.test`, password },
        headers: { Origin: base },
      }
    )
    if (!response.ok()) throw new Error(`Sign-in failed: ${response.status()}`)
    const active = await contexts[i].request.post(
      `${base}/api/auth/organization/set-active`,
      { data: { organizationId: marker }, headers: { Origin: base } }
    )
    if (!active.ok())
      throw new Error(`Workspace selection failed: ${active.status()}`)
  }
  const pages = await Promise.all(contexts.map((context) => context.newPage()))
  for (const page of pages) {
    await page.goto(`${base}/settings`)
    await expect(
      page.getByText("Preferences saved to your account", { exact: true })
    ).toBeVisible({ timeout: 30000 })
  }
  const pointer = pages[0].getByRole("switch", {
    name: "Use pointer cursors",
    exact: true,
  })
  await pointer.click()
  await expect(
    pages[0].getByText("Preferences saved to your account", { exact: true })
  ).toBeVisible()
  await pages[1].reload()
  await expect(
    pages[1].getByRole("switch", { name: "Use pointer cursors", exact: true })
  ).toHaveAttribute("aria-checked", "true", { timeout: 30000 })
  await expect(
    pages[2].getByRole("switch", { name: "Use pointer cursors", exact: true })
  ).toHaveAttribute("aria-checked", "false")
  await pages[0].goto(`${base}/settings/calls-and-transcripts`)
  await expect(
    pages[0].getByText("Preferences saved to your account", { exact: true })
  ).toBeVisible()
  await pages[0]
    .getByRole("switch", { name: "Timestamps", exact: true })
    .click()
  await expect(
    pages[0].getByText("Preferences saved to your account", { exact: true })
  ).toBeVisible()
  await pages[1].goto(`${base}/settings/calls-and-transcripts`)
  await expect(
    pages[1].getByRole("switch", { name: "Timestamps", exact: true })
  ).toHaveAttribute("aria-checked", "false", { timeout: 30000 })
  await pages[0].goto(`${base}/inbox`)
  await pages[0]
    .getByRole("button", { name: "Display options", exact: true })
    .click()
  await pages[0]
    .getByRole("switch", { name: "Enable priority inbox", exact: true })
    .click()
  await expect
    .poll(async () => {
      const row = (
        await pool.query(
          "SELECT values FROM workspace_preferences WHERE user_id=$1 AND workspace_id=$2",
          [users[0], marker]
        )
      ).rows[0]
      return row?.values?.["inbox.main.preferences.priorityEnabled"]
    })
    .toBe(true)
  await pages[1].goto(`${base}/inbox`)
  await pages[1]
    .getByRole("button", { name: "Display options", exact: true })
    .click()
  await expect(
    pages[1].getByRole("switch", { name: "Enable priority inbox", exact: true })
  ).toHaveAttribute("aria-checked", "true", { timeout: 30000 })
  await pages[0].goto(`${base}/settings`)
  await pages[1].goto(`${base}/settings`)
  await expect(
    pages[0].getByText("Preferences saved to your account", { exact: true })
  ).toBeVisible()
  await expect(
    pages[1].getByText("Preferences saved to your account", { exact: true })
  ).toBeVisible()
  await pages[0]
    .getByRole("switch", { name: "Use pointer cursors", exact: true })
    .click()
  await expect(
    pages[0].getByText("Preferences saved to your account", { exact: true })
  ).toBeVisible()
  await pages[1]
    .getByRole("switch", { name: "Use pointer cursors", exact: true })
    .click()
  await expect(pages[1].getByRole("alert")).toContainText(
    "changed in another session"
  )
  await pages[1]
    .getByRole("button", { name: "Discard changes and load saved" })
    .click()
  await expect(
    pages[1].getByRole("switch", { name: "Use pointer cursors", exact: true })
  ).toHaveAttribute("aria-checked", "false")
  await pages[0].goto(`${base}/settings/calls-and-transcripts`)
  await expect(
    pages[0].getByText("Preferences saved to your account", { exact: true })
  ).toBeVisible()
  await contexts[0].setOffline(true)
  await pages[0]
    .getByRole("switch", { name: "Timestamps", exact: true })
    .click()
  await expect(pages[0].getByRole("alert")).toContainText("not saved")
  await contexts[0].setOffline(false)
  await expect(
    pages[0].getByText("Preferences saved to your account", { exact: true })
  ).toBeVisible({ timeout: 30000 })
  await pages[1].goto(`${base}/settings/calls-and-transcripts`)
  await expect(
    pages[1].getByRole("switch", { name: "Timestamps", exact: true })
  ).toHaveAttribute("aria-checked", "true", { timeout: 30000 })

  console.log(
    JSON.stringify({
      status: "passed",
      checks: [
        "real Better Auth sign-in",
        "two independent owner browser sessions",
        "another account isolated",
        "general preference reload",
        "calls preference reload",
        "workspace Inbox preference persisted and reloaded",
        "visible stale-write conflict and explicit review",
        "offline save failure and automatic reconnect retry",
      ],
      environment: identity,
    })
  )
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.split("Call log:")[0].slice(0, 800)
      : "Browser verification failed"
  )
  process.exitCode = 1
} finally {
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM organization WHERE id=$1", [marker])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    console.log(
      JSON.stringify({
        cleanup: (
          await pool.query(
            'SELECT count(*)::int n FROM "user" WHERE id=ANY($1)',
            [users]
          )
        ).rows[0].n,
      })
    )
  }
  await pool.end()
}

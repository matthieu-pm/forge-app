import { writeFileSync } from "node:fs"
import { Pool } from "pg"
import { chromium, expect } from "@playwright/test"
import { hashPassword } from "better-auth/crypto"

const connection = process.env.FORGE_SLA_TEST_DATABASE_URL
const target = new URL(connection ?? "http://invalid")
if (
  target.hostname !== "127.0.0.1" ||
  target.port !== "56525" ||
  target.pathname !== "/for125_sla_test"
)
  throw new Error("Dedicated local FOR-125 database required")
const pool = new Pool({ connectionString: connection })
const base = "http://localhost:3125",
  workspaceId = "for125-browser-acceptance",
  teamId = crypto.randomUUID()
const users = ["for125-browser-alice", "for125-browser-bob"],
  password = crypto.randomUUID(),
  checks = []
let browser,
  owned = false
try {
  if (
    (await pool.query("SELECT current_database() name")).rows[0].name !==
    "for125_sla_test"
  )
    throw new Error("Wrong database")
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'SLA Acceptance',$1)",
    [workspaceId]
  )
  owned = true
  await pool.query(
    "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'enterprise','active')",
    [workspaceId]
  )
  for (const [index, id] of users.entries()) {
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [id, index ? "Bob Admin" : "Alice Admin", `${id}@example.test`]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,'admin')",
      [crypto.randomUUID(), id, workspaceId]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), id, await hashPassword(password)]
    )
  }
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Engineering','engineering','ENG','workspace','emoji','⚙️','#94a3b8','Europe/Paris',$3)",
    [teamId, workspaceId, users[0]]
  )
  browser = await chromium.launch({ headless: true })
  const contexts = await Promise.all([
    browser.newContext({ timezoneId: "Pacific/Honolulu" }),
    browser.newContext({ timezoneId: "Asia/Tokyo" }),
  ])
  for (const [index, context] of contexts.entries()) {
    const login = await context.request.post(`${base}/api/auth/sign-in/email`, {
      data: { email: `${users[index]}@example.test`, password },
      headers: { Origin: base },
    })
    if (!login.ok())
      throw new Error(`Sign-in failed: ${login.status()} ${await login.text()}`)
    const active = await context.request.post(
      `${base}/api/auth/organization/set-active`,
      { data: { organizationId: workspaceId }, headers: { Origin: base } }
    )
    if (!active.ok())
      throw new Error(`Workspace selection failed: ${active.status()}`)
    const session = await (
      await context.request.get(`${base}/api/auth/get-session`)
    ).json()
    console.log(
      JSON.stringify({
        account: index,
        cookieNames: (await context.cookies()).map((c) => c.name),
        session: Boolean(session?.session),
        workspace: session?.session?.activeOrganizationId,
      })
    )
    if (!session?.session) throw new Error("Browser session was not retained")
  }
  const [alice, bob] = await Promise.all(contexts.map((c) => c.newPage()))
  const errors = []
  for (const page of [alice, bob])
    page.on("console", (m) => {
      if (m.type() === "error") console.log("browser error", m.text())
    })
  for (const page of [alice, bob])
    page.on("pageerror", (e) => errors.push(e.message))
  await Promise.all([
    alice.goto(`${base}/settings/sla`),
    bob.goto(`${base}/settings/sla`),
  ])
  for (const page of [alice, bob]) {
    await expect(
      page.getByRole("switch", { name: "Enable shared SLAs", exact: true })
    ).toBeVisible({ timeout: 60000 })
    await expect(
      page.getByRole("switch", { name: "Enable shared SLAs", exact: true })
    ).not.toBeChecked()
    await page
      .getByRole("switch", { name: "Enable shared SLAs", exact: true })
      .click()
    await page.getByRole("button", { name: "Add rule", exact: true }).click()
  }
  await alice
    .getByRole("spinbutton", { name: "SLA target", exact: true })
    .fill("36")
  await alice
    .getByRole("button", { name: "Save SLA policy", exact: true })
    .click()
  await expect(alice.getByRole("status")).toHaveText("SLA policy saved.")
  checks.push(
    "Admin saves shared policy from an initially disabled, empty configuration"
  )
  await bob
    .getByRole("spinbutton", { name: "SLA target", exact: true })
    .fill("48")
  await bob
    .getByRole("button", { name: "Save SLA policy", exact: true })
    .click()
  await expect(
    bob.getByRole("region", { name: "Policy conflict" })
  ).toBeVisible({ timeout: 10000 })
  await expect(
    bob.getByRole("spinbutton", { name: "SLA target", exact: true })
  ).toHaveValue("48")
  await bob
    .getByRole("button", { name: "Keep draft with latest revision" })
    .click()
  await bob
    .getByRole("button", { name: "Save SLA policy", exact: true })
    .click()
  await expect(bob.getByRole("status")).toHaveText("SLA policy saved.")
  expect(
    (
      await pool.query(
        "SELECT revision,values->'rules'->0->'duration'->>'value' target FROM sla_policies WHERE workspace_id=$1",
        [workspaceId]
      )
    ).rows[0]
  ).toEqual({ revision: 2, target: "48" })
  checks.push(
    "Two admins resolve a visible revision conflict without losing the local draft"
  )
  await alice.reload()
  const targetInput = alice.getByRole("spinbutton", {
    name: "SLA target",
    exact: true,
  })
  await expect(targetInput).toHaveValue("48")
  await targetInput.fill("72")
  await alice
    .getByRole("listbox", { name: "Teams", exact: true })
    .selectOption(teamId)
  await bob
    .getByRole("combobox", { name: "Work week", exact: true })
    .selectOption("sun-thu")
  await bob
    .getByRole("button", { name: "Save SLA policy", exact: true })
    .click()
  await expect(bob.getByRole("status")).toHaveText("SLA policy saved.")
  await pool.query(
    "UPDATE teams SET deleted_at=clock_timestamp() WHERE id=$1",
    [teamId]
  )
  await alice
    .getByRole("button", { name: "Save SLA policy", exact: true })
    .click()
  await expect(alice.getByRole("alert")).toContainText(
    "condition is unavailable"
  )
  await expect(
    alice.getByRole("region", { name: "Policy conflict" })
  ).toBeVisible()
  await expect(targetInput).toBeEnabled()
  await expect(targetInput).toHaveValue("72")
  await alice
    .getByRole("listbox", { name: "Teams", exact: true })
    .selectOption([])
  await pool.query("UPDATE teams SET deleted_at=NULL WHERE id=$1", [teamId])
  await alice
    .getByRole("button", { name: "Keep draft with latest revision" })
    .click()
  await targetInput.fill("48")
  await alice
    .getByRole("button", { name: "Save SLA policy", exact: true })
    .click()
  await expect(alice.getByRole("status")).toHaveText("SLA policy saved.")
  checks.push(
    "Definitive stale-reference rejection leaves an editable draft that can be corrected and saved"
  )
  const beforeRetry = (
    await pool.query(
      "SELECT revision FROM sla_policies WHERE workspace_id=$1",
      [workspaceId]
    )
  ).rows[0].revision
  let interrupted = false
  await alice.route("**/_serverFn/**", async (route) => {
    if (
      !interrupted &&
      route.request().method() === "POST" &&
      (route.request().postData() ?? "").includes("expectedRevision")
    ) {
      interrupted = true
      await route.fetch()
      await route.abort("failed")
    } else await route.continue()
  })
  await targetInput.fill("48")
  // Changing the work week supplies a distinct valid save while keeping the 48h target.
  await alice
    .getByRole("combobox", { name: "Work week", exact: true })
    .selectOption("sun-thu")
  await alice
    .getByRole("button", { name: "Save SLA policy", exact: true })
    .click()
  await expect(
    alice.getByRole("button", { name: "Retry save", exact: true })
  ).toBeEnabled()
  await expect(targetInput).toBeDisabled()
  await alice.getByRole("button", { name: "Retry save", exact: true }).click()
  await expect(alice.getByRole("status")).toHaveText("SLA policy saved.")
  expect(interrupted).toBe(true)
  expect(
    (
      await pool.query(
        "SELECT revision FROM sla_policies WHERE workspace_id=$1",
        [workspaceId]
      )
    ).rows[0].revision
  ).toBe(beforeRetry + 1)
  checks.push(
    "Lost response after a committed policy save retries the same receipt exactly once"
  )
  await pool.query(
    "UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2",
    [workspaceId, users[1]]
  )
  await bob.reload()
  await expect(bob.getByRole("alert")).toContainText(
    "Workspace admin access is required",
    { timeout: 30000 }
  )
  await expect(bob.getByRole("spinbutton", { name: "SLA target" })).toHaveCount(
    0
  )
  checks.push(
    "Revoked admin loses policy data and editor after live authorization refresh"
  )
  await bob.goto(`${base}/teams/engineering/issues?view=all`)
  await bob.getByRole("button", { name: "New issue", exact: true }).click()
  await bob
    .getByRole("textbox", { name: "Issue title", exact: true })
    .fill("Browser SLA commitment")
  await bob
    .getByRole("button", { name: "Change priority", exact: true })
    .click()
  await bob.getByRole("option", { name: "Urgent", exact: true }).click()
  await bob.getByRole("button", { name: "Create issue", exact: true }).click()
  await bob
    .getByRole("button", { name: /Open ENG-1 Browser SLA commitment/ })
    .click()
  const section = bob.getByRole("region", { name: "Issue SLA" })
  await expect(section).toContainText("Europe/Paris", { timeout: 15000 })
  await expect(section).toContainText("Setting a due date removes this SLA")
  const stored = (
    await pool.query(
      "SELECT g.deadline_at,g.anchor_at FROM issue_slas g WHERE workspace_id=$1",
      [workspaceId]
    )
  ).rows[0]
  expect(stored.deadline_at.getTime() - stored.anchor_at.getTime()).toBe(
    48 * 3600000
  )
  expect(await section.locator("time").getAttribute("datetime")).toBe(
    stored.deadline_at.toISOString()
  )
  const displayed = await bob.evaluate(
    (deadline) =>
      new Date(deadline).toLocaleString(undefined, {
        timeZone: "Europe/Paris",
      }),
    stored.deadline_at.toISOString()
  )
  await expect(section.locator("time")).toHaveText(displayed)
  await bob.reload()
  await expect(bob.getByRole("region", { name: "Issue SLA" })).toContainText(
    "Europe/Paris",
    { timeout: 30000 }
  )
  await expect(bob.getByText("Forge SLA", { exact: true })).toBeVisible()
  checks.push(
    "Member canonical creation produces and reloads a server deadline and honest system history, independent of browser timezone"
  )
  await bob.screenshot({ path: "/tmp/for125-sla-browser.png", fullPage: true })
  expect(errors).toEqual([])
  writeFileSync(
    "/tmp/for125-browser-evidence.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        environment:
          "built app, local disposable PostgreSQL 17, real Better Auth sessions, Chromium",
        checks,
        pageErrors: errors,
      },
      null,
      2
    )
  )
  console.log(JSON.stringify({ checks, pageErrors: errors }, null, 2))
} catch (error) {
  if (browser)
    for (const [n, c] of browser.contexts().entries()) {
      const p = c.pages()[0]
      if (p) {
        await p.screenshot({ path: `/tmp/for125-browser-failure-${n}.png` })
        console.log((await p.locator("body").innerText()).slice(-9000))
      }
    }
  throw error
} finally {
  await browser?.close()
  if (owned) {
    await pool.query("DELETE FROM organization WHERE id=$1", [workspaceId])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
  }
  await pool.end()
}

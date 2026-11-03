import { execFileSync } from "node:child_process"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { Pool } from "pg"
import { chromium, expect } from "@playwright/test"
import { hashPassword } from "better-auth/crypto"

const mode = process.env.FORGE_SLA_ACCEPTANCE_ENVIRONMENT ?? "local"
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim()
if (!["local", "sla-rehearsal", "production"].includes(mode))
  throw new Error("Unknown SLA acceptance environment")
const approved = process.env.FORGE_SLA_ACCEPTANCE_AUTHORIZED_REVISION
if (
  mode !== "local" &&
  (approved !== revision ||
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
)
  throw new Error(
    "SLA release acceptance requires the exact clean approved source"
  )
const config =
  mode === "local"
    ? {}
    : JSON.parse(
        readFileSync(process.env.FORGE_SLA_ACCEPTANCE_DATABASE_FILE, "utf8")
      )
const connection =
  mode === "local" ? process.env.FORGE_SLA_TEST_DATABASE_URL : config.connection
const target = new URL(connection ?? "http://invalid")
const expected =
  mode === "production"
    ? {
        host: "ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech",
        database: "neondb",
        branch: "br-muddy-queen-zaeeysjt",
      }
    : mode === "sla-rehearsal"
      ? {
          host: "ep-lingering-lab-za3xohqt.c-2.eu-west-2.aws.neon.tech",
          database: "neondb",
          branch: "br-small-darkness-zahmr2fc",
        }
      : { host: "127.0.0.1", database: "for125_sla_test", branch: null }
if (
  target.hostname !== expected.host ||
  target.pathname !== `/${expected.database}` ||
  (mode === "local"
    ? target.port !== "56525"
    : target.searchParams.get("sslmode") !== "require")
)
  throw new Error("Wrong dedicated SLA acceptance database")
const pool = new Pool({ connectionString: connection })
const base =
    mode === "production"
      ? "https://app.forgenow.tech"
      : "http://localhost:3125",
  workspaceId = "for125-browser-acceptance",
  teamId = crypto.randomUUID()
const artifactDir =
  process.env.FORGE_SLA_ACCEPTANCE_ARTIFACT_DIR ?? "/tmp/for125-release-browser"
mkdirSync(artifactDir, { recursive: true })
const users = ["for125-browser-alice", "for125-browser-bob"],
  password = crypto.randomUUID(),
  checks = []
let browser,
  owned = false
try {
  const identity = (
    await pool.query(
      "SELECT current_database() database,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  if (
    identity.database !== expected.database ||
    (expected.branch && identity.branch !== expected.branch)
  )
    throw new Error("Wrong database identity")
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
  await bob.clock.setSystemTime(new Date("2040-01-01T12:00:00Z"))
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
  expect(
    (
      await pool.query(
        "SELECT abs(extract(epoch FROM (clock_timestamp()-anchor_at)))::float8 age FROM issue_slas WHERE workspace_id=$1",
        [workspaceId]
      )
    ).rows[0].age
  ).toBeLessThan(60)
  await expect(section).toContainText("moderate risk")
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
  if (mode === "production") {
    const scheduledIssue = crypto.randomUUID(),
      commitment = crypto.randomUUID()
    const c = await pool.connect()
    try {
      await c.query("BEGIN")
      await c.query(
        "INSERT INTO issues(id,workspace_id,team_id,number,title,status_id,properties) SELECT $1,workspace_id,team_id,2,'Scheduled SLA breach',status_id,properties FROM issues WHERE workspace_id=$2 AND title='Browser SLA commitment'",
        [scheduledIssue, workspaceId]
      )
      await c.query(
        `INSERT INTO issue_slas(id,workspace_id,issue_id,generation,rule_id,policy_revision,snapshot,anchor_at,deadline_at,high_risk_at,moderate_risk_at,gate_identity)
        SELECT $1,workspace_id,$2,1,rule_id,policy_revision,snapshot,clock_timestamp()-interval '49 hours',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '25 hours',clock_timestamp()-interval '169 hours',gate_identity FROM issue_slas WHERE workspace_id=$3 LIMIT 1`,
        [commitment, scheduledIssue, workspaceId]
      )
      await c.query("INSERT INTO issue_sla_windows(commitment_id) VALUES($1)", [
        commitment,
      ])
      await c.query("INSERT INTO issue_sla_intents(commitment_id) VALUES($1)", [
        commitment,
      ])
      await c.query("COMMIT")
    } catch (error) {
      await c.query("ROLLBACK")
      throw error
    } finally {
      c.release()
    }
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              "SELECT j.state FROM issue_sla_intents i JOIN background_jobs j ON j.id=i.job_id WHERE i.commitment_id=$1",
              [commitment]
            )
          ).rows[0]?.state,
        { timeout: 180000, intervals: [5000] }
      )
      .toBe("completed")
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issue_sla_events WHERE commitment_id=$1 AND kind='breached'",
          [commitment]
        )
      ).rows[0].n
    ).toBe(1)
    const events = (
      await pool.query(
        "SELECT deadline_at::text deadline,created_at::text processed FROM issue_sla_events WHERE commitment_id=$1 AND kind='breached'",
        [commitment]
      )
    ).rows[0]
    if (new Date(events.deadline) >= new Date(events.processed))
      throw new Error("Late worker shifted deadline")
    // The next platform tick must not repeat the same visible effect.
    await new Promise((resolve) => setTimeout(resolve, 65000))
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM issue_sla_events WHERE commitment_id=$1 AND kind='breached'",
          [commitment]
        )
      ).rows[0].n
    ).toBe(1)
    checks.push(
      "Real Vercel Cron dispatches and completes a past-deadline fixture exactly once across two ticks; original deadline retained"
    )
  }
  await bob.screenshot({ path: `${artifactDir}/issue-sla.png`, fullPage: true })
  expect(errors).toEqual([])
  writeFileSync(
    `${artifactDir}/browser.json`,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        revision,
        environment: mode,
        database: expected.database,
        branch: expected.branch,
        browser:
          "Chromium, real Better Auth sessions, Honolulu/Tokyo zones, clock set to2040",
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
        await p.screenshot({ path: `${artifactDir}/failure-${n}.png` })
        console.log((await p.locator("body").innerText()).slice(-9000))
      }
    }
  throw error
} finally {
  await browser?.close()
  if (owned) {
    const jobs = (
      await pool.query(
        "SELECT id FROM background_jobs WHERE kind='sla-breach-v1' AND input->>'workspaceId'=$1",
        [workspaceId]
      )
    ).rows.map((r) => r.id)
    await pool.query(
      "DELETE FROM background_job_steps WHERE job_id=ANY($1::uuid[])",
      [jobs]
    )
    await pool.query(
      "DELETE FROM background_job_recoveries WHERE job_id=ANY($1::uuid[])",
      [jobs]
    )
    await pool.query("DELETE FROM background_jobs WHERE id=ANY($1::uuid[])", [
      jobs,
    ])
    await pool.query("DELETE FROM organization WHERE id=$1", [workspaceId])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
  }
  await pool.end()
}

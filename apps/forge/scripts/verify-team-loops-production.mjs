import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"

const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim()
if (
  process.env.FORGE_LOOP_PRODUCTION_AUTHORIZED_REVISION !== revision ||
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
)
  throw new Error(
    "Production acceptance requires a clean exact authorized source revision."
  )
const file = process.env.FORGE_LOOP_PRODUCTION_DATABASE_FILE
const cronFile = process.env.FORGE_LOOP_PRODUCTION_CRON_SECRET_FILE
if (!file || !cronFile)
  throw new Error(
    "Explicit private production connection and Cron secret files are required."
  )
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech" ||
  url.pathname !== "/neondb" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Wrong production target")
const base = "https://app.forgenow.tech",
  cronSecret = readFileSync(cronFile, "utf8").trim()
if (cronSecret.length < 32) throw new Error("Invalid private Cron secret file")
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection })
const marker = `for62-production-loops-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  loopName = "FOR62 production release verification",
  password = `for62-${crypto.randomUUID()}`
const users = [marker + "-alice", marker + "-bob"],
  checks = []
let browser,
  verified = false,
  loopId,
  runId
const checked = (text) => {
  checks.push(text)
  console.log(JSON.stringify({ check: text }))
}
try {
  const identity = (
    await pool.query(
      "SELECT current_database() db,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  if (identity.db !== "neondb" || identity.branch !== "br-muddy-queen-zaeeysjt")
    throw new Error("Wrong production branch")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR62 production acceptance',$1)",
    [marker]
  )
  await pool.query(
    "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'enterprise','active')",
    [marker]
  )
  await pool.query(
    "INSERT INTO workspace_security_settings(workspace_id,loops_policy,external_loop_sources_enabled) VALUES($1,'all-members',true)",
    [marker]
  )
  for (let i = 0; i < users.length; i++) {
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [
        users[i],
        i ? "Bob Acceptance" : "Alice Acceptance",
        users[i] + "@example.test",
      ]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)",
      [crypto.randomUUID(), users[i], marker, i ? "member" : "admin"]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), users[i], await hashPassword(password)]
    )
  }
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Release acceptance','for62-release','R62','private','emoji','⚙️','#94a3b8','Europe/Paris',$3)",
    [teamId, marker, users[0]]
  )
  for (const user of users)
    await pool.query(
      "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member')",
      [crypto.randomUUID(), marker, teamId, user]
    )
  browser = await chromium.launch({ headless: true })
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 900 } }),
    browser.newContext({ viewport: { width: 1280, height: 900 } }),
  ])
  for (let i = 0; i < users.length; i++) {
    expect(
      (
        await contexts[i].request.post(`${base}/api/auth/sign-in/email`, {
          data: { email: users[i] + "@example.test", password },
          headers: { Origin: base },
        })
      ).ok()
    ).toBe(true)
    expect(
      (
        await contexts[i].request.post(
          `${base}/api/auth/organization/set-active`,
          { data: { organizationId: marker }, headers: { Origin: base } }
        )
      ).ok()
    ).toBe(true)
  }
  const [alice, bob] = await Promise.all(contexts.map((c) => c.newPage()))
  for (const page of [alice, bob])
    await page.goto(`${base}/teams/for62-release/loops`)
  await expect(
    bob.getByRole("button", { name: "New loop", exact: true })
  ).toBeEnabled({ timeout: 60000 })
  checked("two production sessions open shared team Loops")
  await bob.getByRole("button", { name: "New loop", exact: true }).click()
  await bob.getByLabel("Loop name", { exact: true }).fill(loopName)
  await bob
    .getByLabel("Loop instructions", { exact: true })
    .fill(
      "Respond with exactly FOR62_RELEASE_OK. Do not call tools or change any data."
    )
  await bob
    .getByRole("combobox", { name: "Loop trigger type", exact: true })
    .click()
  await bob
    .getByRole("option", { name: "Authenticated webhook", exact: true })
    .click()
  await bob.getByRole("button", { name: "Publish loop", exact: true }).click()
  await expect(bob.getByRole("dialog")).toHaveCount(0, { timeout: 60000 })
  loopId = (
    await pool.query(
      "SELECT id FROM team_loops WHERE workspace_id=$1 AND fields->>'name'=$2",
      [marker, loopName]
    )
  ).rows[0].id
  await alice.reload()
  await expect(
    alice.getByRole("heading", { name: loopName, exact: true })
  ).toBeVisible({ timeout: 60000 })
  checked("ordinary member publishes and peer sees canonical configuration")
  await bob
    .getByRole("button", { name: "Rotate webhook secret", exact: true })
    .click()
  const secretInput = bob.getByLabel("Webhook secret", { exact: true })
  await expect(secretInput).toBeVisible({ timeout: 30000 })
  const secret = await secretInput.inputValue()
  await bob.getByRole("button", { name: "Dismiss secret", exact: true }).click()
  await bob.getByRole("button", { name: "Enable", exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          await pool.query("SELECT enabled FROM team_loops WHERE id=$1", [
            loopId,
          ])
        ).rows[0].enabled,
      { timeout: 60000 }
    )
    .toBe(true)
  checked(
    "explicit production enablement accepts workspace cloud runtime/model access"
  )
  expect(
    (await contexts[0].request.get(`${base}/api/internal/loops`)).status()
  ).toBe(401)
  const eventId = `for62-release-${crypto.randomUUID()}`
  const post = () =>
    contexts[0].request.post(`${base}/api/loops/webhooks/${loopId}`, {
      headers: { Authorization: `Bearer ${secret}`, "Webhook-Id": eventId },
      data: { event: "release.verification" },
    })
  const receipt = await post()
  expect(receipt.status()).toBe(202)
  runId = (await receipt.json()).runId
  expect((await post()).status()).toBe(202)
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM loop_runs WHERE loop_id=$1",
        [loopId]
      )
    ).rows[0].n
  ).toBe(1)
  checked("authenticated webhook exact retry queues one durable run")
  const scheduled = await contexts[0].request.get(
    `${base}/api/internal/loops`,
    { headers: { Authorization: `Bearer ${cronSecret}` }, timeout: 295000 }
  )
  expect(scheduled.status()).toBe(200)
  await expect
    .poll(
      async () =>
        (await pool.query("SELECT state FROM loop_runs WHERE id=$1", [runId]))
          .rows[0].state,
      { timeout: 300000, intervals: [1000, 3000, 5000] }
    )
    .toMatch(/^(completed|failed|blocked|uncertain|cancelled)$/)
  const result = (
    await pool.query(
      "SELECT state,result,error_code FROM loop_runs WHERE id=$1",
      [runId]
    )
  ).rows[0]
  if (result.state !== "completed")
    throw new Error(
      `Live Loop did not complete: ${result.state}/${result.error_code}`
    )
  expect(result.result).toContain("FOR62_RELEASE_OK")
  checked("production web scheduler completes a real hosted provider run")
  await alice.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(
    alice.getByText("FOR62_RELEASE_OK", { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await bob.getByRole("button", { name: "Disable", exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          await pool.query("SELECT enabled FROM team_loops WHERE id=$1", [
            loopId,
          ])
        ).rows[0].enabled
    )
    .toBe(false)
  expect((await post()).status()).toBe(404)
  checked("peer sees confirmed result and disablement rejects further webhooks")
  await alice.screenshot({
    path: "/private/tmp/for62-production-loops-shared.png",
    fullPage: true,
  })
  await alice.setViewportSize({ width: 390, height: 844 })
  expect(
    await alice.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await alice.screenshot({
    path: "/private/tmp/for62-production-loops-mobile.png",
    fullPage: true,
  })
  await pool.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [
    teamId,
    users[1],
  ])
  await bob.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(
    bob.getByRole("heading", { name: loopName, exact: true })
  ).toHaveCount(0, { timeout: 60000 })
  checked("mobile overflow and current team revocation")
  console.log(
    JSON.stringify({
      issue: "FOR-62",
      target: "production",
      revision,
      passed: true,
      checks,
      liveModelCalls: true,
      runtime: "hosted",
      outputMarkerVerified: true,
    })
  )
} catch (error) {
  if (verified && runId) {
    const diagnostic = (
      await pool.query(
        "SELECT lr.state,lr.error_code,ar.state agent_state,ar.error_code agent_error FROM loop_runs lr LEFT JOIN agent_runs ar ON ar.id=lr.agent_run_id WHERE lr.id=$1 AND lr.workspace_id=$2",
        [runId, marker]
      )
    ).rows
    writeFileSync(
      "/private/tmp/for62-production-loop-diagnostic.json",
      JSON.stringify(diagnostic),
      { mode: 0o600 }
    )
  }
  throw error
} finally {
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM organization WHERE id=$1", [marker])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    const cleanup = (
      await pool.query(
        'SELECT (SELECT count(*)::int FROM organization WHERE id=$1) workspaces,(SELECT count(*)::int FROM "user" WHERE id=ANY($2)) users,(SELECT count(*)::int FROM command_receipts WHERE workspace_id=$1) receipts,(SELECT count(*)::int FROM "user" WHERE id=$3) principals',
        [marker, users, loopId ? `forge-loop:${loopId}` : ""]
      )
    ).rows[0]
    expect(cleanup).toEqual({
      workspaces: 0,
      users: 0,
      receipts: 0,
      principals: 0,
    })
    console.log(JSON.stringify({ cleanup }))
  }
  await pool.end()
}

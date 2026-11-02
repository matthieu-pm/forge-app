import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"

const file = process.env.FORGE_LOOP_TEST_DATABASE_FILE
if (!file)
  throw new Error("An explicit Loop acceptance database file is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
const expectedHost = "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech",
  expectedDatabase = "forge_resources_loops_acceptance",
  expectedBranch = "br-autumn-union-za0opf1e"
if (
  url.hostname !== expectedHost ||
  decodeURIComponent(url.pathname) !== `/${expectedDatabase}` ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Wrong Loop acceptance database")
const base = process.env.FORGE_LOOP_BROWSER_URL ?? "http://localhost:3162",
  baseUrl = new URL(base)
if (
  baseUrl.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(baseUrl.hostname) ||
  baseUrl.username ||
  baseUrl.password
)
  throw new Error("A local Loop acceptance server is required")
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection }),
  marker = `for62-loops-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for62-${crypto.randomUUID()}`,
  users = [marker + "-alice", marker + "-bob"]
let browser,
  verified = false
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim()
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
    throw new Error("Wrong Loop database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR62 Loops Acceptance',$1)",
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
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,visibility,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Product','product','PRD','workspace','emoji','⚙️','#94a3b8','Europe/Paris',$3)",
    [crypto.randomUUID(), marker, users[0]]
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
  const checks = []
  const checked = (message) => {
    checks.push(message)
    console.log(JSON.stringify({ check: message }))
  }
  const loops = async (page, slug = "engineering") => {
    await page.goto(`${base}/teams/${slug}/loops`)
    await expect(
      page.getByRole("button", { name: "New loop", exact: true })
    ).toBeEnabled({ timeout: 60000 })
  }
  const choose = async (page, label, name) => {
    await page.getByRole("combobox", { name: label, exact: true }).click()
    await page.getByRole("option", { name, exact: true }).click()
  }
  const card = (page, name) =>
    page
      .locator("article")
      .filter({ has: page.getByRole("heading", { name, exact: true }) })
  const row = async (name) =>
    (
      await pool.query(
        "SELECT * FROM team_loops WHERE workspace_id=$1 AND fields->>'name'=$2 AND deleted_at IS NULL",
        [marker, name]
      )
    ).rows[0]
  const create = async (page, name, instructions) => {
    await page.getByRole("button", { name: "New loop", exact: true }).click()
    await page.getByLabel("Loop name", { exact: true }).fill(name)
    await page
      .getByLabel("Loop instructions", { exact: true })
      .fill(instructions)
  }
  const publish = async (page) => {
    await page
      .getByRole("button", { name: "Publish loop", exact: true })
      .click()
    try {
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30000 })
    } catch {
      throw new Error(
        "Loop publish not confirmed: " +
          (await page.getByRole("dialog").innerText())
      )
    }
  }
  await loops(alice, "product")
  await create(alice, "Public scope review", "Review public product work.")
  await expect(
    alice.getByRole("combobox", { name: "Loop team access", exact: true })
  ).toContainText("All public teams")
  await publish(alice)
  expect((await row("Public scope review")).fields.teamAccess).toBe(
    "all-public-teams"
  )
  checked("public-team default scope is all public teams")

  await loops(alice)
  await create(
    alice,
    "Incoming review",
    "Review incoming bug comments and suggest next steps."
  )
  await expect(
    alice.getByRole("combobox", { name: "Loop team access", exact: true })
  ).toContainText("This team")
  await choose(alice, "Trigger event", "comment")
  await choose(alice, "Comment matching", "Contains text")
  await alice.getByLabel("Comment text to match", { exact: true }).fill("bug")
  await alice.getByRole("button", { name: "Add group", exact: true }).click()
  await choose(alice, "Condition 1 values", "High")
  await publish(alice)
  let first = await row("Incoming review")
  expect(first.fields.trigger).toMatchObject({
    event: "comment",
    commentMode: "contains",
    commentText: "bug",
  })
  expect(first.fields.conditions[0].operator).toBe("or")
  checked("native comment submode and grouped conditions persist")
  await loops(bob)
  await expect(card(bob, "Incoming review")).toBeVisible()
  await card(bob, "Incoming review")
    .getByRole("button", { name: "Edit", exact: true })
    .click()
  await expect(
    bob.getByLabel("Loop instructions", { exact: true })
  ).toHaveValue("Review incoming bug comments and suggest next steps.")
  await bob
    .getByLabel("Loop instructions", { exact: true })
    .fill("Bob's preserved stale draft")
  await card(alice, "Incoming review")
    .getByRole("button", { name: "Edit", exact: true })
    .click()
  await alice
    .getByLabel("Loop instructions", { exact: true })
    .fill("Alice's latest published instructions")
  await publish(alice)
  await bob.getByRole("button", { name: "Publish loop", exact: true }).click()
  await expect(bob.getByRole("dialog").getByRole("alert")).toContainText(
    "This Loop changed",
    { timeout: 30000 }
  )
  await expect(
    bob.getByLabel("Loop instructions", { exact: true })
  ).toHaveValue("Bob's preserved stale draft")
  await expect(
    bob.getByText("Alice's latest published instructions", { exact: true })
  ).toBeVisible()
  await bob.screenshot({
    path: "/private/tmp/for62-loops-conflict.png",
    fullPage: true,
  })
  await bob
    .getByRole("button", {
      name: "Use latest revision with my draft",
      exact: true,
    })
    .click()
  await publish(bob)
  first = await row("Incoming review")
  expect(first.revision).toBe(3)
  expect(first.fields.instructions).toBe("Bob's preserved stale draft")
  checked("two sessions share configuration and ordinary member publishes")
  checked("stale publisher preserves draft and explicitly rebases")
  await card(bob, "Incoming review")
    .getByRole("button", { name: "Published versions", exact: true })
    .click()
  await bob.getByRole("button", { name: /Version 1/ }).click()
  await bob
    .getByRole("button", {
      name: "Review this version for restoration",
      exact: true,
    })
    .click()
  await publish(bob)
  expect((await row("Incoming review")).revision).toBe(4)
  expect((await row("Incoming review")).fields.instructions).toBe(
    "Review incoming bug comments and suggest next steps."
  )
  checked("published history restores as a new revision")
  await card(bob, "Incoming review")
    .getByRole("button", { name: "Enable", exact: true })
    .click()
  await expect
    .poll(async () => Boolean((await row("Incoming review"))?.enabled), {
      timeout: 30000,
    })
    .toBe(true)
  checked("explicit enable uses configured fake cloud readiness")

  await create(
    bob,
    "Webhook review",
    "Summarize the authenticated event. Do not write to other work."
  )
  await choose(bob, "Loop trigger type", "Authenticated webhook")
  await publish(bob)
  let webhook = await row("Webhook review")
  await card(bob, "Webhook review")
    .getByRole("button", { name: "Rotate webhook secret", exact: true })
    .click()
  await expect(bob.getByLabel("Webhook secret", { exact: true })).toBeVisible({
    timeout: 30000,
  })
  const secret = await bob
    .getByLabel("Webhook secret", { exact: true })
    .inputValue()
  expect(secret.length).toBeGreaterThan(30)
  await bob.getByRole("button", { name: "Dismiss secret", exact: true }).click()
  await card(bob, "Webhook review")
    .getByRole("button", { name: "Enable", exact: true })
    .click()
  await expect
    .poll(async () => Boolean((await row("Webhook review"))?.enabled), {
      timeout: 30000,
    })
    .toBe(true)
  const webhookId = `browser-${crypto.randomUUID()}`
  const post = () =>
    contexts[0].request.post(`${base}/api/loops/webhooks/${webhook.id}`, {
      headers: { Authorization: `Bearer ${secret}`, "Webhook-Id": webhookId },
      data: {
        event: "acceptance.signal",
        summary: "Browser acceptance fixture",
      },
    })
  expect((await post()).status()).toBe(202)
  expect((await post()).status()).toBe(202)
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM loop_runs WHERE workspace_id=$1 AND loop_id=$2",
            [marker, webhook.id]
          )
        ).rows[0].n,
      { timeout: 30000 }
    )
    .toBe(1)
  await bob.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(
    bob.getByRole("button", { name: "Cancel run", exact: true })
  ).toBeVisible({ timeout: 30000 })
  await bob.getByRole("button", { name: "Cancel run", exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT state FROM loop_runs WHERE workspace_id=$1 AND loop_id=$2",
            [marker, webhook.id]
          )
        ).rows[0].state,
      { timeout: 30000 }
    )
    .toBe("cancelled")
  const modelConnection = crypto.randomUUID()
  await pool.query(
    "INSERT INTO model_connections(id,workspace_id,scope,provider,kind,execution_kind,locality,billing_mode,credential_owner,display_name,status,created_by_user_id) VALUES($1,$2,'workspace','openai','api-key','forge-native','server-capable','pay-as-you-go','forge-server-vault','Scheduler acceptance model','ready',$3)",
    [modelConnection, marker, users[0]]
  )
  await pool.query(
    `INSERT INTO model_catalog_entries(connection_id,selection_id,provider_model_id,display_name,provider_label,source_label,execution_kind,input_modalities,supports_tools,supports_code,supported_reasoning_efforts,status) VALUES($1,$2,'gpt-6-astra','Acceptance GPT','OpenAI','Acceptance','forge-native','["text"]',true,true,'["low","medium","high","xhigh"]','available')`,
    [modelConnection, `${modelConnection}:gpt-6-astra`]
  )
  const cronSecret = process.env.FORGE_LOOP_TEST_CRON_SECRET
  if (!cronSecret || cronSecret.length < 32)
    throw new Error("The local scheduler acceptance secret is required")
  expect(
    (await contexts[0].request.get(`${base}/api/internal/loops`)).status()
  ).toBe(401)
  const queuedForScheduler = await contexts[0].request.post(
    `${base}/api/loops/webhooks/${webhook.id}`,
    {
      headers: {
        Authorization: `Bearer ${secret}`,
        "Webhook-Id": `scheduler-${crypto.randomUUID()}`,
      },
      data: { event: "scheduler.acceptance" },
    }
  )
  expect(queuedForScheduler.status()).toBe(202)
  const scheduledRun = (await queuedForScheduler.json()).runId
  const scheduled = await contexts[0].request.get(
    `${base}/api/internal/loops`,
    {
      headers: { Authorization: `Bearer ${cronSecret}` },
    }
  )
  expect(scheduled.status()).toBe(200)
  expect(await scheduled.json()).toMatchObject({ enabled: true, executed: 1 })
  expect(
    (
      await pool.query(
        "SELECT state,result FROM loop_runs WHERE id=$1 AND workspace_id=$2",
        [scheduledRun, marker]
      )
    ).rows[0]
  ).toEqual({ state: "completed", result: "Done" })
  await bob.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(bob.getByText("Done", { exact: true })).toBeVisible({
    timeout: 30000,
  })
  checked(
    "authenticated web scheduler executes a queued Loop through the real coordinator and shares its confirmed result"
  )
  await card(bob, "Webhook review")
    .getByRole("button", { name: "Disable", exact: true })
    .click()
  await expect
    .poll(async () => Boolean((await row("Webhook review"))?.enabled), {
      timeout: 30000,
    })
    .toBe(false)
  checked("webhook secret appears only upon rotation")
  checked(
    "authenticated webhook receipt and duplicate event queue exactly once"
  )
  checked("shared run history supports cancellation and explicit disable")

  await bob.route("**/*", async (route) => {
    const request = route.request()
    if (
      request.method() === "POST" &&
      request.postData()?.includes("Network recovery Loop")
    )
      await route.abort("failed")
    else await route.continue()
  })
  await create(
    bob,
    "Network recovery Loop",
    "Retain this exact command across reload."
  )
  await bob.getByRole("button", { name: "Publish loop", exact: true }).click()
  await expect(bob.getByRole("dialog").getByRole("alert")).toBeVisible({
    timeout: 30000,
  })
  const commandKey = await bob.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith('["forge.loop-command",')
    )
    return key ? JSON.parse(localStorage.getItem(key)).key : null
  })
  expect(commandKey).toBeTruthy()
  await bob.unrouteAll({ behavior: "wait" })
  await bob.reload()
  await expect(
    bob.getByRole("button", { name: "Retry pending request", exact: true })
  ).toBeVisible({ timeout: 60000 })
  await bob
    .getByRole("button", { name: "Retry pending request", exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM team_loops WHERE workspace_id=$1 AND fields->>'name'='Network recovery Loop'",
            [marker]
          )
        ).rows[0].n,
      { timeout: 30000 }
    )
    .toBe(1)
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM command_receipts WHERE workspace_id=$1 AND operation='loops.write@1' AND command_key=$2",
            [marker, commandKey]
          )
        ).rows[0].n,
      { timeout: 30000 }
    )
    .toBe(1)
  await expect(
    bob.getByRole("button", { name: "Retry pending request", exact: true })
  ).toHaveCount(0, { timeout: 30000 })
  checked("network failure reload retries original command key exactly once")
  await expect(card(bob, "Network recovery Loop")).toBeVisible({
    timeout: 30000,
  })
  await expect(
    bob.getByRole("button", { name: "New loop", exact: true })
  ).toBeEnabled({ timeout: 30000 })
  await bob.screenshot({
    path: "/private/tmp/for62-loops-shared.png",
    fullPage: true,
  })
  await bob.setViewportSize({ width: 390, height: 844 })
  expect(
    await bob.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await bob.screenshot({
    path: "/private/tmp/for62-loops-mobile.png",
    fullPage: true,
  })
  checked("mobile layout has no horizontal overflow")
  await bob.setViewportSize({ width: 1280, height: 900 })
  await card(bob, "Incoming review")
    .getByRole("button", { name: "Edit", exact: true })
    .click()
  await pool.query(
    "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3",
    [marker, teamId, users[1]]
  )
  await bob.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(bob.getByRole("dialog")).toHaveCount(0, { timeout: 30000 })
  await expect(
    bob.getByRole("heading", { name: "Incoming review", exact: true })
  ).toHaveCount(0)
  checked("revocation clears open editor and protected run history")
  expect(
    errors.filter(
      (error) =>
        !error.includes("Failed to fetch") && !error.includes("path.endsWith")
    )
  ).toEqual([])
  console.log(
    JSON.stringify({
      issue: "FOR-62",
      slice: "Loops",
      revision,
      target: "local acceptance",
      passed: true,
      environment: identity,
      checks,
      liveModelCalls: false,
    })
  )
} catch (error) {
  for (const [index, page] of (
    browser?.contexts().flatMap((context) => context.pages()) ?? []
  ).entries())
    await page
      .screenshot({
        path: `/private/tmp/for62-loops-failure-${index}.png`,
        fullPage: true,
      })
      .catch(() => {})
  throw error
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

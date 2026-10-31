import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"

const file = process.env.FORGE_CACHE_SCOPE_TEST_DATABASE_FILE
if (!file) throw new Error("FORGE_CACHE_SCOPE_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_auto_assignment_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base =
  process.env.FORGE_CACHE_SCOPE_BROWSER_URL ?? "http://localhost:3152"
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base))
  throw new Error("A local acceptance server is required")
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection }),
  marker = `for52-${crypto.randomUUID()}`,
  password = `for52-${crypto.randomUUID()}`
const users = [marker + "-alice", marker + "-bob"],
  workspaces = [marker + "-a", marker + "-b", marker + "-c"],
  teams = workspaces.map(() => crypto.randomUUID())
let browser,
  verified = false
let release = () => {}
try {
  const identity = (
    await pool.query(
      "SELECT current_database() database,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  if (
    identity.database !== "forge_auto_assignment_acceptance" ||
    identity.branch !== "br-autumn-union-za0opf1e"
  )
    throw new Error("Wrong database")
  verified = true
  for (const user of users) {
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [
        user,
        user.endsWith("alice") ? "Alice Scope" : "Bob Scope",
        `${user}@example.test`,
      ]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), user, await hashPassword(password)]
    )
  }
  for (let i = 0; i < workspaces.length; i++) {
    const user = users[i === 1 ? 1 : 0],
      workspace = workspaces[i]
    await pool.query(
      "INSERT INTO organization(id,name,slug) VALUES($1,$2,$1)",
      [workspace, `Scope ${i}`]
    )
    await pool.query(
      "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'enterprise','active')",
      [workspace]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,'admin')",
      [crypto.randomUUID(), user, workspace]
    )
    await pool.query(
      "INSERT INTO teams(id,workspace_id,name,slug,identifier,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Engineering','engineering','ENG','emoji','⚙️','#94a3b8','Europe/Paris',$3)",
      [teams[i], workspace, user]
    )
    await pool.query(
      "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member')",
      [crypto.randomUUID(), workspace, teams[i], user]
    )
    await pool.query(
      "INSERT INTO issues(workspace_id,team_id,number,title,creator_id,properties) VALUES($1,$2,1,$3,$4,'{}'::jsonb)",
      [
        workspace,
        teams[i],
        [
          `Alice private ${marker}`,
          `Bob private ${marker}`,
          `Other workspace ${marker}`,
        ][i],
        user,
      ]
    )
    await pool.query(
      "INSERT INTO team_issue_numbers(team_id,last_number) VALUES($1,1) ON CONFLICT(team_id) DO UPDATE SET last_number=1",
      [teams[i]]
    )
  }
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    }),
    page = await context.newPage()
  await context.request.post(`${base}/api/auth/sign-in/email`, {
    data: { email: `${users[0]}@example.test`, password },
    headers: { Origin: base },
  })
  await context.request.post(`${base}/api/auth/organization/set-active`, {
    data: { organizationId: workspaces[0] },
    headers: { Origin: base },
  })
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${base}/teams/engineering/issues?view=all`)
  await expect(
    page.getByText(`Alice private ${marker}`, { exact: true })
  ).toBeVisible({ timeout: 60000 })
  console.log("Verified initial A scope")
  const sibling = await context.newPage()
  await sibling.goto(`${base}/teams/engineering/issues?view=all`)
  await expect(
    sibling.getByText(`Alice private ${marker}`, { exact: true })
  ).toBeVisible({ timeout: 60000 })
  // Capture A's actual server query before switching. The transport is held after
  // the server answered; release it only once B's protected UI is visible.
  let held
  const heldPromise = new Promise((resolve) => {
    held = resolve
  })
  const releasePromise = new Promise((resolve) => {
    release = resolve
  })
  let holdNext = true
  await page.route("**/_serverFn/**", async (route) => {
    const request = route.request()
    const payload =
      decodeURIComponent(request.url()) + (request.postData() ?? "")
    if (!holdNext || !payload.includes('"query"')) return route.continue()
    holdNext = false
    const response = await route.fetch()
    held()
    await releasePromise
    await route.fulfill({ response }).catch(() => {})
  })
  await page.evaluate(async () => {
    const { invalidateIssueQueries } =
      await import("/src/lib/issue-query-client.ts")
    invalidateIssueQueries()
  })
  await Promise.race([
    heldPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("A query was not captured")), 15000)
    ),
  ])
  await page.evaluate(
    async ({ email, password, workspace }) => {
      const { authClient } = await import("/src/lib/auth-client.ts")
      await authClient.signOut()
      const signIn = await authClient.signIn.email({ email, password })
      if (signIn.error) throw new Error(signIn.error.message)
      await authClient.organization.setActive({ organizationId: workspace })
    },
    { email: `${users[1]}@example.test`, password, workspace: workspaces[1] }
  )
  await expect(
    page.getByText(`Bob private ${marker}`, { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    page.getByText(`Alice private ${marker}`, { exact: true })
  ).toHaveCount(0)
  await expect(
    sibling.getByText(`Bob private ${marker}`, { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    sibling.getByText(`Alice private ${marker}`, { exact: true })
  ).toHaveCount(0)
  await sibling.close()
  console.log("Verified delayed-response and cross-tab isolation")
  release()
  await expect(
    page.getByText(`Alice private ${marker}`, { exact: true })
  ).toHaveCount(0)
  await page.unroute("**/_serverFn/**")
  // Offline input must remain uncommitted and survive reload once the same
  // account/workspace is verified again.
  await page.getByRole("button", { name: "New issue", exact: true }).click()
  await page.getByRole("button", { name: "Change assignee" }).click()
  await page.getByRole("option", { name: "No assignee", exact: true }).click()
  await context.setOffline(true)
  const draftTitle = `Offline recovered ${marker}`
  await page
    .getByRole("textbox", { name: "Issue title", exact: true })
    .fill(draftTitle)
  await expect(page.getByText(/Unpublished draft/)).toBeVisible()
  await page.getByRole("button", { name: "Create issue", exact: true }).click()
  await expect(page.getByText(/not confirmed by the server/)).toBeVisible()
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM issues WHERE workspace_id=$1 AND title=$2",
        [workspaces[1], draftTitle]
      )
    ).rows[0].n
  ).toBe(0)
  await context.setOffline(false)
  await page.reload()
  await expect(page.getByText(/Unsaved drafts recovered/)).toBeVisible({
    timeout: 60000,
  })
  expect(
    await page.evaluate((title) => {
      const key = Object.keys(localStorage).find((key) =>
        key.startsWith('["forge.unsaved-drafts"')
      )
      return key && localStorage.getItem(key).includes(title)
    }, draftTitle)
  ).toBe(true)
  console.log("Verified offline reload recovery")
  // A different account cannot receive B's draft journal or protected rows.
  await page.evaluate(
    async ({ email, password, workspace }) => {
      const { authClient } = await import("/src/lib/auth-client.ts")
      await authClient.signOut()
      await authClient.signIn.email({ email, password })
      await authClient.organization.setActive({ organizationId: workspace })
    },
    { email: `${users[0]}@example.test`, password, workspace: workspaces[0] }
  )
  await expect(
    page.getByText(`Alice private ${marker}`, { exact: true })
  ).toBeVisible({ timeout: 60000 })
  expect(
    await page.evaluate(async () => {
      const { productStorage } = await import("/src/lib/product-storage.ts")
      return Array.from({ length: productStorage.length }, (_, i) =>
        productStorage.getItem(productStorage.key(i))
      ).join("\n")
    })
  ).not.toContain(draftTitle)
  await page.evaluate(async (workspace) => {
    const { authClient } = await import("/src/lib/auth-client.ts")
    await authClient.organization.setActive({ organizationId: workspace })
  }, workspaces[2])
  await expect(
    page.getByText(`Other workspace ${marker}`, { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await expect(
    page.getByText(`Alice private ${marker}`, { exact: true })
  ).toHaveCount(0)
  // Return to B and explicitly publish its recovered creation. Replaying the
  // original intention must create exactly one issue, including across reload.
  await page.evaluate(
    async ({ email, password, workspace }) => {
      const { authClient } = await import("/src/lib/auth-client.ts")
      await authClient.signOut()
      await authClient.signIn.email({ email, password })
      await authClient.organization.setActive({ organizationId: workspace })
    },
    { email: `${users[1]}@example.test`, password, workspace: workspaces[1] }
  )
  await expect(
    page.getByText(`Bob private ${marker}`, { exact: true })
  ).toBeVisible({ timeout: 60000 })
  await page.getByRole("button", { name: /^Drafts/ }).click()
  await page.getByRole("button", { name: draftTitle, exact: true }).click()
  await expect(
    page.getByRole("textbox", { name: "Issue title", exact: true })
  ).toHaveValue(draftTitle)
  await page.getByRole("button", { name: "Create issue", exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM issues WHERE workspace_id=$1 AND title=$2",
            [workspaces[1], draftTitle]
          )
        ).rows[0].n
    )
    .toBe(1)
  await page.reload()
  await expect(page.getByText(draftTitle, { exact: true })).toBeVisible({
    timeout: 60000,
  })
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM issues WHERE workspace_id=$1 AND title=$2",
        [workspaces[1], draftTitle]
      )
    ).rows[0].n
  ).toBe(1)
  expect(errors).toEqual([])
  console.log("Verified explicit recovery creates exactly once")
} catch (error) {
  console.error("FOR-52 acceptance failed", error)
  throw error
} finally {
  release()
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM session WHERE user_id = ANY($1::text[])", [
      users,
    ])
    for (const workspace of workspaces)
      await pool.query("DELETE FROM organization WHERE id=$1", [workspace])
    for (const user of users)
      await pool.query('DELETE FROM "user" WHERE id=$1', [user])
  }
  await pool.end()
}

console.log(
  "FOR-52 browser acceptance passed: delayed A response, B isolation, offline reload recovery without commit, account draft isolation, same-account workspace switch, cross-tab invalidation and one explicit recovered creation."
)

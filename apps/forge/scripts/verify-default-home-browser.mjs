import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { chromium, expect as browserExpect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"

const expect = browserExpect.configure({ timeout: 60000 })
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim()
if (
  process.env.FORGE_HOME_VERIFY_REVISION !== revision ||
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
)
  throw new Error("Clean exact authorized source required")
const base = process.env.FORGE_HOME_VERIFY_BASE
if (base !== "https://app.forgenow.tech")
  throw new Error("Explicit public production origin required")
const connection = readFileSync(
  process.env.FORGE_HOME_VERIFY_DATABASE_FILE,
  "utf8"
).trim()
const databaseUrl = new URL(connection)
if (
  databaseUrl.hostname.replace("-pooler.", ".") !==
    "ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech" ||
  databaseUrl.pathname !== "/neondb"
)
  throw new Error("Wrong database target")
const scope = `for131-release-${crypto.randomUUID()}`
const users = [`${scope}-alice`, `${scope}-bob`]
const workspaces = [`${scope}-a`, `${scope}-b`]
const teamId = crypto.randomUUID(),
  issueId = crypto.randomUUID(),
  password = crypto.randomUUID()
const deepLink = `/teams/for131/issues?view=all&issue=${issueId}#comment-for131`
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: connection })
const checks = [],
  pageErrors = []
let browser,
  verified = false,
  identity,
  cleanup
async function preference(value, index = 0) {
  await pool.query(
    `INSERT INTO account_preferences(user_id,values) VALUES($1,jsonb_build_object('general.defaultHomeView',$2::text))
    ON CONFLICT(user_id) DO UPDATE SET values=jsonb_set(account_preferences.values,'{general.defaultHomeView}',to_jsonb($2::text)),revision=account_preferences.revision+1`,
    [users[index], value]
  )
}
async function login(context, index = 0) {
  const response = await context.request.post(
    `${base}/api/auth/sign-in/email`,
    {
      headers: { Origin: base },
      data: { email: `${users[index]}@example.test`, password },
    }
  )
  expect(response.status()).toBe(200)
  const active = await context.request.post(
    `${base}/api/auth/organization/set-active`,
    { headers: { Origin: base }, data: { organizationId: workspaces[index] } }
  )
  expect(active.status()).toBe(200)
}
async function destination(page, path) {
  await expect
    .poll(
      () =>
        new URL(page.url()).pathname +
        new URL(page.url()).search +
        new URL(page.url()).hash
    )
    .toBe(path)
}
function observe(page) {
  page.on("pageerror", (error) => pageErrors.push(error.message))
}
try {
  identity = (
    await pool.query(
      "SELECT current_database() database,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  expect(identity).toEqual({
    database: "neondb",
    branch: "br-muddy-queen-zaeeysjt",
  })
  verified = true
  for (let index = 0; index < users.length; index++) {
    await pool.query(
      "INSERT INTO organization(id,name,slug) VALUES($1,'FOR131 release acceptance',$1)",
      [workspaces[index]]
    )
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [
        users[index],
        index ? "FOR131 Bob" : "FOR131 Alice",
        `${users[index]}@example.test`,
      ]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,'owner')",
      [crypto.randomUUID(), users[index], workspaces[index]]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), users[index], await hashPassword(password)]
    )
  }
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'FOR131 Team','for131','FHOME','emoji','⚙️','#94a3b8','Europe/Paris',$3)",
    [teamId, workspaces[0], users[0]]
  )
  await pool.query(
    "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member')",
    [crypto.randomUUID(), workspaces[0], teamId, users[0]]
  )
  await pool.query(
    "INSERT INTO issues(id,workspace_id,team_id,number,title,creator_id,properties) VALUES($1,$2,$3,1,'FOR131 explicit destination',$4,'{}')",
    [issueId, workspaces[0], teamId, users[0]]
  )
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  await login(context)
  const page = await context.newPage()
  observe(page)
  for (const [choice, label, path] of [
    ["inbox", "Inbox", "/inbox"],
    ["my-issues", "My issues", "/my-issues"],
    ["agent", "Forge Agent (default)", "/forge"],
  ]) {
    await page.goto(`${base}/settings`)
    await expect(
      page.getByText("Preferences saved to your account", { exact: true })
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Default home view", exact: true })
      .click()
    await page.getByRole("menuitemradio", { name: label, exact: true }).click()
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              "SELECT values->>'general.defaultHomeView' home FROM account_preferences WHERE user_id=$1",
              [users[0]]
            )
          ).rows[0]?.home
      )
      .toBe(choice)
    await page.goto(`${base}/`)
    await destination(page, path)
    checks.push(
      `AC-01: saved ${choice} through production UI; default startup opened ${path}`
    )
  }
  await preference("deleted-choice")
  await page.goto(`${base}/`)
  await destination(page, "/forge")
  checks.push(
    "AC-02: invalid stored home value selected the available historical fallback without a loop"
  )
  await preference("inbox")
  await page.goto(`${base}${deepLink}`)
  await destination(page, deepLink)
  await expect(
    page.getByRole("textbox", { name: "Issue title", exact: true })
  ).toHaveValue("FOR131 explicit destination")
  checks.push(
    "AC-03: authorized issue deep link retained issue query and fragment instead of home"
  )
  await page.goto(`${base}/login?redirect=${encodeURIComponent(deepLink)}`)
  await destination(page, deepLink)
  checks.push("AC-03: signed-in auth return retained the exact issue URL")
  for (const looping of ["/LOGIN", "/login//", "/%6cogin"]) {
    await page.goto(`${base}/login?redirect=${encodeURIComponent(looping)}`)
    await destination(page, "/inbox")
  }
  checks.push(
    "AC-02: router-equivalent login return URLs safely resolve home without loops"
  )
  const anonymous = await browser.newContext()
  const signIn = await anonymous.newPage()
  observe(signIn)
  await signIn.goto(`${base}${deepLink}`)
  await expect(signIn.getByLabel("Email", { exact: true })).toBeVisible()
  await signIn
    .getByLabel("Email", { exact: true })
    .fill(`${users[0]}@example.test`)
  await signIn.getByLabel("Password", { exact: true }).fill(password)
  await signIn.getByRole("button", { name: "Sign in", exact: true }).click()
  await destination(signIn, deepLink)
  await expect(
    signIn.getByRole("textbox", { name: "Issue title", exact: true })
  ).toHaveValue("FOR131 explicit destination")
  checks.push(
    "AC-03: real unauthenticated HTTP redirect and email login retained the carried fragment and issue destination"
  )
  const desktop = await browser.newContext({
    storageState: await context.storageState(),
  })
  await desktop.addInitScript(() => {
    const listeners = new Set()
    window.__for131HostCommand = () => {
      for (const listener of listeners)
        listener({ type: "command", command: "new-tab" })
    }
    window.forgeDesktop = {
      getRuntime: () =>
        Promise.resolve({
          platform: "macos",
          hostVersion: "for131-fixture",
          capabilities: [],
        }),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      setThemeSource: () => Promise.resolve(),
      setUnreadCount: () => Promise.resolve(),
    }
  })
  const nativePage = await desktop.newPage()
  observe(nativePage)
  await nativePage.goto(`${base}${deepLink}`)
  await expect(nativePage.getByTestId("desktop-titlebar")).toBeAttached()
  await expect
    .poll(async () => {
      const row = (
        await pool.query(
          "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND owner_user_id=$2 AND key='forge:desktop-tabs'",
          [workspaces[0], users[0]]
        )
      ).rows[0]
      const state = row ? JSON.parse(JSON.parse(row.encoded_value)) : null
      return state?.tabs
        .find((tab) => tab.id === state.activeTabId)
        ?.history.at(-1)
    })
    .toBe(deepLink)
  await nativePage.goto(`${base}/`)
  await destination(nativePage, deepLink)
  checks.push(
    "AC-03: desktop renderer restored the saved active issue URL before default-home resolution"
  )
  for (const [choice, path] of [
    ["agent", "/forge"],
    ["inbox", "/inbox"],
    ["my-issues", "/my-issues"],
  ]) {
    await preference(choice)
    await nativePage
      .getByRole("button", { name: "New tab", exact: true })
      .click()
    await destination(nativePage, path)
    checks.push(
      `AC-01: production desktop renderer default tab opened ${choice} via current server preference`
    )
  }
  const before = await nativePage.getByRole("tab").count()
  await nativePage.evaluate(() => {
    window.__for131HostCommand()
    window.__for131HostCommand()
  })
  await expect(nativePage.getByRole("tab")).toHaveCount(before + 2)
  checks.push(
    "AC-01: two overlapping native commands create two independent tabs in the production renderer (fixture bridge)"
  )
  const other = await browser.newContext()
  await login(other, 1)
  await preference("my-issues", 1)
  const otherPage = await other.newPage()
  observe(otherPage)
  await otherPage.goto(`${base}/`)
  await destination(otherPage, "/my-issues")
  await otherPage.goto(`${base}${deepLink}`)
  await expect(
    otherPage.getByRole("textbox", { name: "Issue title", exact: true })
  ).toHaveCount(0)
  expect(new URL(otherPage.url()).pathname).not.toBe("/my-issues")
  checks.push(
    "AC-01/03: a second account uses its own preference and cannot access the first workspace's issue"
  )
  await pool.query(
    "DELETE FROM member WHERE user_id=$1 AND organization_id=$2",
    [users[1], workspaces[1]]
  )
  await otherPage.goto(`${base}/`)
  await expect
    .poll(() => new URL(otherPage.url()).pathname)
    .toBe("/onboarding/workspace")
  checks.push(
    "AC-02: revoked workspace membership prevents default destination access"
  )
  expect(pageErrors).toEqual([])
} finally {
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM organization WHERE id=ANY($1::text[])", [
      workspaces,
    ])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users])
    cleanup = (
      await pool.query(
        'SELECT (SELECT count(*) FROM organization WHERE id=ANY($1::text[])) workspaces,(SELECT count(*) FROM "user" WHERE id=ANY($2::text[])) users,(SELECT count(*) FROM session WHERE user_id=ANY($2::text[])) sessions',
        [workspaces, users]
      )
    ).rows[0]
    expect(cleanup).toEqual({ workspaces: "0", users: "0", sessions: "0" })
  }
  await pool.end()
  writeFileSync(
    process.env.FORGE_HOME_VERIFY_RESULT ??
      "/tmp/for131-production-browser.json",
    JSON.stringify(
      {
        revision,
        base,
        identity,
        scope,
        checks,
        pageErrors,
        cleanup,
        desktopIntegration:
          "Production web renderer with fixture host bridge; packaged macOS is separate.",
      },
      null,
      2
    ) + "\n"
  )
  console.log(JSON.stringify({ passed: checks.length, pageErrors, cleanup }))
}

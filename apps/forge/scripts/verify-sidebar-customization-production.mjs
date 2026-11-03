import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, expect as browserExpect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { defaultSidebarLayout } from "../src/lib/sidebar-preference-contract.ts"
import { hashPassword } from "better-auth/crypto"

const expect = browserExpect.configure({ timeout: 30000 })
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim()
if (
  process.env.FORGE_SIDEBAR_PRODUCTION_AUTHORIZED_REVISION !== revision ||
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
)
  throw Error("Clean exact authorized source required")
const base = "https://app.forgenow.tech",
  file = process.env.FORGE_SIDEBAR_PRODUCTION_DATABASE_FILE
if (!file) throw Error("Explicit private production database file required")
const connection = readFileSync(file, "utf8").trim(),
  url = new URL(connection)
if (
  url.hostname.replace("-pooler.", ".") !==
    "ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech" ||
  url.pathname !== "/neondb" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw Error("Wrong production database target")
const output = resolve("../../docs/qa/for134")
mkdirSync(output, { recursive: true })
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: connection, max: 3 }),
  marker = `for134-release-${crypto.randomUUID()}`
const users = [`${marker}-alice`, `${marker}-bob`],
  workspaces = [`${marker}-owner`, `${marker}-other`],
  password = crypto.randomUUID()
const checks = [],
  pageErrors = [],
  startedAt = new Date().toISOString()
let verified = false,
  browser,
  result
function checked(contract, message) {
  checks.push({ contract, message })
  console.log(JSON.stringify({ passed: message }))
}
async function snapshot(user = users[0]) {
  return (
    await pool.query(
      "SELECT revision,values,field_versions FROM account_preferences WHERE user_id=$1",
      [user]
    )
  ).rows[0]
}
const visible = (locator) => locator.filter({ visible: true })
async function saved(page) {
  await expect(
    page
      .getByRole("dialog")
      .getByText("Preferences saved to your account", { exact: true })
  ).toBeVisible()
}
async function editor(page) {
  const button = page.getByRole("button", { name: "Customize", exact: true })
  await expect(button).toBeEnabled({ timeout: 60000 })
  // A previous settings selector may leave this control under the sticky
  // Preferences heading. Scroll it clear using normal browser scrolling.
  await button.evaluate((element) =>
    element.scrollIntoView({ block: "center" })
  )
  await button.click()
  const dialog = page.getByRole("dialog", { name: "Customize sidebar" })
  await expect(dialog).toBeVisible()
  return dialog
}
async function settings(page) {
  await visible(
    page.locator('[data-sidebar="header"] button[aria-haspopup="menu"]')
  ).click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Customize", exact: true })
  ).toBeEnabled({ timeout: 60000 })
}
async function back(page) {
  await page.getByRole("link", { name: "Back to app", exact: true }).click()
  await expect(visible(page.locator('a[href="/inbox"]')).first()).toBeVisible()
  await expect(
    page.getByRole("main", { name: "Inbox", exact: true })
  ).toBeVisible()
}
async function tabTo(page, locator) {
  for (let n = 0; n < 160; n++) {
    if (await locator.evaluate((element) => element === document.activeElement))
      return
    await page.keyboard.press("Tab")
  }
  throw Error("Keyboard could not reach requested control")
}
const appLinks = (page) =>
  visible(page.locator('[data-sidebar="content"] a[href]'))
const paths = async (page) =>
  appLinks(page).evaluateAll((links) =>
    links.map((link) => link.getAttribute("href"))
  )
try {
  const identity = (
    await pool.query(
      "SELECT current_database() database,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  expect(identity).toEqual({
    database: "neondb",
    branch: "br-muddy-queen-zaeeysjt",
  })
  const source = JSON.parse(
      readFileSync(
        "src/application/operations/migrations.generated.json",
        "utf8"
      )
    ),
    applied = (
      await pool.query(
        "SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at"
      )
    ).rows
  expect(
    applied.map((row) => ({
      hash: row.hash,
      createdAt: Number(row.created_at),
    }))
  ).toEqual(source)
  verified = true
  for (let i = 0; i < 2; i++) {
    await pool.query(
      "INSERT INTO organization(id,name,slug) VALUES($1,'FOR134 release acceptance',$1)",
      [workspaces[i]]
    )
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [
        users[i],
        i ? "Other acceptance owner" : "Sidebar acceptance owner",
        `${users[i]}@example.test`,
      ]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,'owner')",
      [crypto.randomUUID(), users[i], workspaces[i]]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), users[i], await hashPassword(password)]
    )
  }
  // Saved fixture choices from a retired/previously enabled catalog, never customer data.
  await pool.query(
    "INSERT INTO account_preferences(user_id,revision,values,field_versions) VALUES($1,1,$2::jsonb,$3::jsonb)",
    [
      users[0],
      JSON.stringify({
        "general.sidebarLayout": [
          { id: "reviews", visible: true },
          { id: "signals", visible: true },
          { id: "retired-destination", visible: true },
          { id: "inbox", visible: false },
          { id: "forge", visible: true },
        ],
      }),
      JSON.stringify({ "general.sidebarLayout": 1 }),
    ]
  )
  browser = await chromium.launch({ headless: true })
  const contexts = await Promise.all(
      [0, 1, 2].map(() =>
        browser.newContext({ viewport: { width: 1280, height: 900 } })
      )
    ),
    pages = []
  for (let i = 0; i < 3; i++) {
    const owner = i === 2 ? 1 : 0,
      context = contexts[i]
    expect(
      (
        await context.request.post(`${base}/api/auth/sign-in/email`, {
          headers: { Origin: base },
          data: { email: `${users[owner]}@example.test`, password },
        })
      ).status()
    ).toBe(200)
    expect(
      (
        await context.request.post(`${base}/api/auth/organization/set-active`, {
          headers: { Origin: base },
          data: { organizationId: workspaces[owner] },
        })
      ).status()
    ).toBe(200)
    const page = await context.newPage()
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.goto(`${base}/inbox`)
    await expect(visible(page.locator('a[href="/inbox"]')).first()).toBeVisible(
      { timeout: 60000 }
    )
    pages.push(page)
  }
  const [a, b, other] = pages
  await expect(visible(a.locator('a[href="/reviews"]'))).toHaveCount(0)
  await expect(visible(a.locator('a[href="/workspace/signals"]'))).toHaveCount(
    0
  )
  await settings(a)
  let dialog = await editor(a)
  for (const name of ["Show Reviews", "Show Signals"])
    await expect(dialog.getByRole("switch", { name, exact: true })).toHaveCount(
      0
    )
  await expect(
    dialog.getByText("retired-destination", { exact: true })
  ).toHaveCount(0)
  await expect(
    dialog.getByRole("switch", { name: "Show Inbox", exact: true })
  ).toBeDisabled()
  await expect(
    dialog.getByRole("switch", { name: "Show Inbox", exact: true })
  ).toHaveAttribute("aria-checked", "true")
  checked(
    "AC-03/AT-03",
    "Production reconciliation excludes retired/gated saved IDs and forces Inbox reachable"
  )
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  await a
    .getByRole("button", { name: "App notification badge", exact: true })
    .click()
  await a.getByRole("menuitemradio", { name: "Off", exact: true }).click()
  await a.keyboard.press("Escape")
  await expect(a.getByRole("menu")).toHaveCount(0)
  dialog = await editor(a)
  await dialog.getByRole("switch", { name: "Show Forge", exact: true }).click()
  await dialog.getByRole("switch", { name: "Show Calls", exact: true }).click()
  const move = dialog.getByRole("button", {
    name: "Move My issues up",
    exact: true,
  })
  await tabTo(a, move)
  await a.keyboard.press("Alt+ArrowUp")
  await a.keyboard.press("Alt+ArrowUp")
  await expect(move).toBeFocused()
  await dialog
    .getByRole("button", { name: "Move Projects up", exact: true })
    .click()
  await dialog
    .getByRole("combobox", { name: "Sidebar badge style" })
    .selectOption("dot")
  await saved(a)
  const confirmed = await snapshot()
  expect(confirmed.values["general.sidebarBadgeStyle"]).toBe("dot")
  expect(confirmed.values["general.notificationBadge"]).toBe("off")
  for (const id of ["forge", "workspace-calls"])
    expect(
      confirmed.values["general.sidebarLayout"].find((item) => item.id === id)
        .visible
    ).toBe(false)
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  const sentinel = crypto.randomUUID()
  await a.evaluate((value) => {
    window.__for134Sentinel = value
  }, sentinel)
  await back(a)
  expect(await a.evaluate(() => window.__for134Sentinel)).toBe(sentinel)
  await expect(visible(a.locator('a[href="/forge"]'))).toHaveCount(0)
  expect((await paths(a)).slice(0, 2)).toEqual(["/my-issues", "/inbox"])
  await expect(visible(a.locator('[data-sidebar-badge="dot"]'))).toBeVisible()
  await expect(a.getByText("Saving changes…", { exact: true })).toBeHidden({
    timeout: 60000,
  })
  await a.screenshot({
    path: resolve(output, "production-sidebar-desktop.png"),
    fullPage: false,
  })
  checked(
    "AC-01/AT-01",
    "Real account commands persist order/visibility/dot badge independently of native mode and mounted navigation updates without reload"
  )
  await b.reload()
  await expect(visible(b.locator('[data-sidebar-badge="dot"]'))).toBeVisible({
    timeout: 60000,
  })
  await expect(visible(b.locator('a[href="/forge"]'))).toHaveCount(0)
  expect((await paths(b)).slice(0, 2)).toEqual(["/my-issues", "/inbox"])
  await expect(visible(other.locator('a[href="/forge"]'))).toBeVisible()
  expect(await snapshot(users[1])).toBeUndefined()
  checked(
    "AC-01/AT-01",
    "Second independent owner session reload reads saved layout; another authenticated account retains defaults"
  )
  await settings(a)
  dialog = await editor(a)
  await dialog
    .getByRole("combobox", { name: "Sidebar badge style" })
    .selectOption("off")
  await saved(a)
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  await back(a)
  await expect(visible(a.locator("[data-sidebar-badge]"))).toHaveCount(0)
  checked("AC-01/AT-01", "Off style removes the real scoped unread badge")
  await settings(a)
  dialog = await editor(a)
  await contexts[0].setOffline(true)
  await dialog.getByRole("switch", { name: "Show Forge", exact: true }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  expect(
    (await snapshot()).values["general.sidebarLayout"].find(
      (item) => item.id === "forge"
    ).visible
  ).toBe(false)
  await contexts[0].setOffline(false)
  const retry = dialog.getByRole("button", {
    name: "Retry preferences",
    exact: true,
  })
  if (await retry.isVisible()) await retry.click()
  await saved(a)
  expect(
    (await snapshot()).values["general.sidebarLayout"].find(
      (item) => item.id === "forge"
    ).visible
  ).toBe(true)
  checked(
    "AC-01/AT-01",
    "Offline failure stays visibly unsaved; reconnect/explicit retry persists the real change"
  )
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  await a.setViewportSize({ width: 320, height: 640 })
  await a.reload()
  const customize = a.getByRole("button", { name: "Customize", exact: true })
  await expect(customize).toBeEnabled({ timeout: 60000 })
  await tabTo(a, customize)
  await a.keyboard.press("Enter")
  dialog = a.getByRole("dialog", { name: "Customize sidebar" })
  const narrowMove = dialog.getByRole("button", {
    name: "Move Forge up",
    exact: true,
  })
  await tabTo(a, narrowMove)
  await a.keyboard.press("Alt+ArrowUp")
  await expect(narrowMove).toBeFocused()
  await expect(dialog.getByText(/Forge moved to position/)).toBeAttached()
  const reset = dialog.getByRole("button", {
    name: "Reset to defaults",
    exact: true,
  })
  await tabTo(a, reset)
  await a.keyboard.press("Enter")
  await expect(reset).toBeFocused()
  await expect(dialog.getByText(/Default sidebar restored/)).toBeAttached()
  await saved(a)
  const defaults = await snapshot()
  expect(defaults.values["general.sidebarLayout"]).toEqual(defaultSidebarLayout)
  expect(defaults.values["general.sidebarBadgeStyle"]).toBe("count")
  expect(defaults.values["general.notificationBadge"]).toBe("off")
  const dimensions = await dialog.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    top: element.getBoundingClientRect().top,
    bottom: element.getBoundingClientRect().bottom,
    viewportHeight: window.innerHeight,
    client: element.clientWidth,
    scroll: element.scrollWidth,
    controls: [
      ...element.querySelectorAll('button,select,[role="switch"]'),
    ].every((control) => {
      const a = control.getBoundingClientRect(),
        b = element.getBoundingClientRect()
      return a.left >= b.left && a.right <= b.right
    }),
  }))
  expect(dimensions.width).toBeLessThanOrEqual(320)
  expect(dimensions.top).toBeGreaterThanOrEqual(0)
  expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.viewportHeight)
  expect(dimensions.client).toBe(dimensions.scroll)
  expect(dimensions.controls).toBe(true)
  await expect(reset).toBeInViewport()
  await expect(a.getByText("Saving changes…", { exact: true })).toBeHidden({
    timeout: 60000,
  })
  await a.screenshot({
    path: resolve(output, "production-sidebar-320.png"),
    fullPage: false,
  })
  checked(
    "AC-02/AT-02",
    "Authenticated 320px keyboard reorder/reset preserve focus, announce changes and restore SQL-confirmed defaults without horizontal overflow"
  )
  await a.keyboard.press("Escape")
  await expect(customize).toBeFocused()
  await a.setViewportSize({ width: 1280, height: 900 })
  await back(a)
  await expect(visible(a.locator('[data-sidebar-badge="count"]'))).toBeVisible()
  await expect(visible(a.locator('a[href="/forge"]'))).toBeVisible()
  expect((await paths(a)).slice(0, 3)).toEqual([
    "/inbox",
    "/forge",
    "/my-issues",
  ])
  await settings(a)
  checked(
    "AC-02/AT-02",
    "Reset restores mounted default navigation/count badge; Escape returns focus and Settings stays reachable"
  )
  expect(pageErrors).toEqual([])
  result = {
    issue: "FOR-134",
    revision,
    base,
    startedAt,
    completedAt: new Date().toISOString(),
    identity,
    migrationsVerified: source.length,
    checks,
    dimensions,
    pageErrors,
    fixtureScope: marker,
  }
} catch (error) {
  const firstPage = browser?.contexts()[0]?.pages()[0]
  await firstPage?.screenshot({
    path: "/tmp/for134-live-failure.png",
    fullPage: true,
  })
  writeFileSync(
    resolve(output, "production-failure.json"),
    JSON.stringify(
      {
        revision,
        startedAt,
        checks,
        error: String(error?.message ?? error),
        pageErrors,
      },
      null,
      2
    ) + "\n"
  )
  throw error
} finally {
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM organization WHERE id=ANY($1::text[])", [
      workspaces,
    ])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users])
    const cleanup = (
      await pool.query(
        'SELECT (SELECT count(*) FROM organization WHERE id=ANY($1::text[])) workspaces,(SELECT count(*) FROM "user" WHERE id=ANY($2::text[])) users,(SELECT count(*) FROM session WHERE user_id=ANY($2::text[])) sessions,(SELECT count(*) FROM account_preferences WHERE user_id=ANY($2::text[])) preferences,(SELECT count(*) FROM command_receipts WHERE workspace_id=ANY($1::text[])) receipts',
        [workspaces, users]
      )
    ).rows[0]
    expect(cleanup).toEqual({
      workspaces: "0",
      users: "0",
      sessions: "0",
      preferences: "0",
      receipts: "0",
    })
    console.log(JSON.stringify({ cleanup }))
    if (result)
      writeFileSync(
        resolve(output, "production-browser.json"),
        JSON.stringify({ ...result, cleanup }, null, 2) + "\n"
      )
  }
  await pool.end()
}

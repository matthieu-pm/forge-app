import { mkdir, writeFile, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { chromium, expect } from "@playwright/test"

// Isolated UI acceptance: real editor, provider, preference client, styles and
// navigation projection. Only transport/auth/product-state and rollout discovery
// are fixtures. This never contacts a database or claims authenticated acceptance.
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const root = resolve(app, "node_modules/.cache/for134-browser")
const output = resolve(app, "../../docs/qa/for134")
await mkdir(root, { recursive: true })
await mkdir(output, { recursive: true })
await writeFile(
  resolve(root, "index.html"),
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>'
)
await writeFile(
  resolve(root, "fixture.css"),
  `@import "${resolve(app, "src/styles.css")}";\n@source "${resolve(app, "src")}";\n`
)
await writeFile(
  resolve(root, "fixture.tsx"),
  `
import * as React from "react"
import { createRoot } from "react-dom/client"
import { SidebarCustomization } from "@/components/sidebar-customization"
import { AccountPreferenceScope, usePreferenceGroup } from "@/components/account-preference-provider"
import { useFeatureNavigation } from "@/components/feature-availability"
import { AccountPreferenceClient } from "@/lib/account-preference-client"
import { accountPreferenceCommandSchema, emptyPreferenceSnapshot } from "@/lib/account-preference-contract"
import { appNav } from "@/lib/app-navigation"
import { customizeSidebarItems } from "@/lib/sidebar-preference-contract"
import "./fixture.css"
const read = () => JSON.parse(localStorage.getItem("fixture-snapshot") ?? "null") ?? emptyPreferenceSnapshot("fixture-owner")
const client = new AccountPreferenceClient({ userId: "fixture-owner", sessionId: "fixture-session", workspaceId: "fixture-workspace" }, {
  load: async () => ({status: "ready", snapshot: read()}),
  save: async (input) => {
    const command = accountPreferenceCommandSchema.parse(input), snapshot = read()
    const fields = Object.keys(command.patch).filter(key => (snapshot.fieldVersions[key] ?? 0) !== command.expectedVersions[key])
    if (fields.length) return {status: "conflict", fields, snapshot}
    const revision = snapshot.revision + 1
    const next = {...snapshot, revision, values: {...snapshot.values, ...command.patch}, fieldVersions: {...snapshot.fieldVersions, ...Object.fromEntries(Object.keys(command.patch).map(key => [key, revision]))}}
    localStorage.setItem("fixture-snapshot", JSON.stringify(next))
    return {status: "saved", snapshot: next}
  }
})
await client.refresh()
function Preview() {
 const {preferences} = usePreferenceGroup("general"), available = useFeatureNavigation()
 return <nav aria-label="Fixture navigation" className="mt-6 flex flex-col gap-2">{customizeSidebarItems(appNav.filter(item => available(item.to)), "primary", preferences.sidebarLayout).map(item => <a key={item.to} href={item.to}>{item.title}</a>)}</nav>
}
createRoot(document.getElementById("root")).render(<AccountPreferenceScope client={client}><main className="p-4"><h1 className="mb-4 text-sm">FOR-134 · isolated UI fixture</h1><SidebarCustomization/><Preview/></main></AccountPreferenceScope>)
`
)
const stubs = new Map([
  [
    "lib/auth-state",
    "export const getAuthState = async () => ({user:null,session:null,workspace:null})",
  ],
  [
    "lib/account-preference-state",
    'export const loadAccountPreferences = async () => ({status:"disabled"}); export const saveAccountPreferences = async () => {throw Error("unused fixture boundary")}',
  ],
  [
    "lib/product-storage",
    "export const productStorage = {getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)}; export const resetProductStorage = () => {}",
  ],
  [
    "components/product-state-provider",
    "export const ProductStateProvider = ({children}) => children",
  ],
  [
    "components/feature-availability",
    `import {useSyncExternalStore} from "react"; const subscribe = notify => {window.addEventListener("fixture-gate",notify);return()=>window.removeEventListener("fixture-gate",notify)};export function useFeatureNavigation(){const enabled=useSyncExternalStore(subscribe,()=>window.fixtureReviews!==false);return path=>path!=="/reviews"||enabled}`,
  ],
])
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, "vite-cache"),
  resolve: { alias: { "@": resolve(app, "src") } },
  server: {
    host: "127.0.0.1",
    port: 0,
    fs: { allow: [app, resolve(app, "../..")] },
  },
  plugins: [
    {
      name: "for134-fixture-boundaries",
      enforce: "pre",
      resolveId(source, importer) {
        const path = source.startsWith("@/")
          ? resolve(app, "src", source.slice(2))
          : source.startsWith(".") && importer
            ? resolve(dirname(importer), source)
            : source
        for (const key of stubs.keys())
          if (path.replace(/\.[jt]sx?$/, "") === resolve(app, "src", key))
            return `\0for134:${key}`
      },
      load(id) {
        if (id.startsWith("\0for134:")) return stubs.get(id.slice(8))
      },
    },
    react(),
    tailwindcss(),
  ],
})
let browser
const checks = []
try {
  await server.listen()
  const address = server.httpServer.address()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    viewport: { width: 320, height: 640 },
    reducedMotion: "reduce",
  })
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${address.port}`)
  await page.keyboard.press("Tab")
  await expect(
    page.getByRole("button", { name: "Customize", exact: true })
  ).toBeFocused()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog", { name: "Customize sidebar" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS("position", "fixed")
  async function tabTo(locator) {
    for (let i = 0; i < 80; i++) {
      if (
        await locator.evaluate((element) => element === document.activeElement)
      )
        return
      await page.keyboard.press("Tab")
    }
    throw Error("Keyboard could not reach requested control")
  }
  const up = page.getByRole("button", { name: "Move Forge up", exact: true })
  await tabTo(up)
  await page.keyboard.press("Enter")
  await expect(up).toBeFocused()
  await expect(
    dialog.getByText("Forge moved to position 1 of 5 in Main navigation.")
  ).toBeAttached()
  await page.keyboard.press("Alt+ArrowDown")
  await expect(up).toBeFocused()
  await expect(
    dialog.getByText("Forge moved to position 2 of 5 in Main navigation.")
  ).toBeAttached()
  checks.push(
    "320px keyboard reorder using Enter and Alt+ArrowDown; focus retained; live announcements"
  )
  const show = page.getByRole("switch", { name: "Show Forge", exact: true })
  await tabTo(show)
  await page.keyboard.press("Space")
  await expect(show).toHaveAttribute("aria-checked", "false")
  const badge = page.getByRole("combobox", { name: "Sidebar badge style" })
  await tabTo(badge)
  await badge.selectOption("dot")
  await page.keyboard.press("Tab")
  await expect(badge).toHaveValue("dot")
  await expect(
    dialog.getByText("Preferences saved to your account", { exact: true })
  ).toBeVisible()
  await page.screenshot({
    path: resolve(output, "sidebar-320.png"),
    fullPage: true,
  })
  const overflow = await dialog.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    scroll: element.scrollWidth,
    client: element.clientWidth,
    controls: [
      ...element.querySelectorAll("button,select,[role=switch]"),
    ].every((control) => {
      const a = control.getBoundingClientRect(),
        b = element.getBoundingClientRect()
      return a.left >= b.left && a.right <= b.right
    }),
  }))
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client)
  expect(overflow.width).toBeLessThanOrEqual(320)
  expect(overflow.controls).toBe(true)
  checks.push(
    "320px dialog and controls fit horizontally; vertical scrolling reaches badge and reset"
  )
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("button", { name: "Customize", exact: true })
  ).toBeFocused()
  await expect(
    page
      .getByRole("navigation")
      .getByRole("link", { name: "Forge", exact: true })
  ).toHaveCount(0)
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Customize", exact: true })
  ).toBeVisible()
  await tabTo(page.getByRole("button", { name: "Customize", exact: true }))
  await page.keyboard.press("Enter")
  await expect(show).toHaveAttribute("aria-checked", "false")
  await expect(badge).toHaveValue("dot")
  checks.push(
    "Fixture server snapshot reload retains layout/visibility/style; mounted navigation applies immediately"
  )
  const reorder = page.getByRole("button", {
    name: "Move My issues up",
    exact: true,
  })
  await tabTo(reorder)
  for (let i = 0; i < 4; i++) await page.keyboard.press("Alt+ArrowUp")
  const reviews = page.getByRole("button", {
    name: "Move Reviews up",
    exact: true,
  })
  await tabTo(reviews)
  await page.evaluate(() => {
    window.fixtureReviews = false
    window.dispatchEvent(new Event("fixture-gate"))
  })
  await expect(reviews).toHaveCount(0)
  const reset = page.getByRole("button", {
    name: "Reset to defaults",
    exact: true,
  })
  await expect(reset).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(reset).toBeFocused()
  await expect(reset).toBeInViewport()
  await expect(show).toHaveAttribute("aria-checked", "true")
  await expect(badge).toHaveValue("count")
  await expect(dialog.getByText(/Default sidebar restored/)).toBeAttached()
  await expect(
    page.getByRole("switch", { name: "Show Inbox", exact: true })
  ).toBeDisabled()
  checks.push(
    "Gate removal removes focused row and recovers focus; keyboard reset restores defaults without exposing disabled destination"
  )
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.screenshot({
    path: resolve(output, "sidebar-desktop.png"),
    fullPage: true,
  })
  expect(errors).toEqual([])
  await writeFile(
    resolve(output, "browser-fixture.json"),
    JSON.stringify(
      {
        issue: "FOR-134",
        environment:
          "Local Chromium fixture, real UI/provider/client; synthetic transport and gates; no database/authentication/deployment certification",
        sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: app,
          encoding: "utf8",
        }).trim(),
        checkedAt: new Date().toISOString(),
        checks,
        overflow,
        pageErrors: errors,
      },
      null,
      2
    ) + "\n"
  )
  console.log(
    JSON.stringify(
      { passed: checks.length, checks, pageErrors: errors, output },
      null,
      2
    )
  )
} finally {
  await browser?.close()
  await server.close()
  await rm(root, { recursive: true, force: true })
}

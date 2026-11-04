import { mkdir, writeFile, rm } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { chromium, expect } from "@playwright/test"

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const root = resolve(app, "node_modules/.cache/for140-browser")
const output = resolve(app, "../../docs/qa/for140")
const source = readFileSync(resolve(app, "src/lib/appearance.ts"), "utf8")
const bootstrap = source.match(/appearanceBootstrapScript = `([^`]+)`/)?.[1]
if (!bootstrap) throw new Error("Appearance bootstrap script was not found.")
await mkdir(root, { recursive: true })
await mkdir(output, { recursive: true })
await writeFile(
  resolve(root, "index.html"),
  `<!doctype html><html lang="en"><head><script>${bootstrap}</script></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>`
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
import { AccountPreferenceProvider } from "@/components/account-preference-provider"
import { PersonalPreferenceEffects } from "@/components/personal-preference-effects"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import "./fixture.css"

function Fixture() {
  return (
    <AccountPreferenceProvider>
      <PersonalPreferenceEffects />
      <Dialog open>
        <DialogContent>
          <DialogTitle>Appearance preview</DialogTitle>
          <div className="comment-editor">
            <div className="tiptap">Theme sample</div>
          </div>
          <Button>Save comment</Button>
        </DialogContent>
      </Dialog>
    </AccountPreferenceProvider>
  )
}
createRoot(document.getElementById("root")).render(<Fixture />)
`
)
const stubs = new Map([
  [
    "lib/auth-state",
    `export const getAuthState = async () => window.__appearanceAuth ?? { user: null, session: null, workspace: null }`,
  ],
  [
    "lib/account-preference-state",
    `export const loadAccountPreferences = async () => {
      const auth = window.__appearanceAuth
      const userId = auth?.user?.id ?? "anonymous"
      const snapshot = window.__appearanceSnapshots?.[userId] ?? { version: 1, userId, revision: 1, values: {}, fieldVersions: {} }
      return { status: "ready", snapshot }
    }
    export const saveAccountPreferences = async () => { throw new Error("unused fixture boundary") }`,
  ],
  [
    "lib/product-storage",
    `export const productStorage = { getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }
    export const resetProductStorage = () => {}`,
  ],
  [
    "components/product-state-provider",
    `import { useSyncExternalStore } from "react"
    const subscribe = (listener) => { window.addEventListener("appearance-product", listener); return () => window.removeEventListener("appearance-product", listener) }
    export function ProductStateProvider({ children }) {
      const ready = useSyncExternalStore(subscribe, () => window.__productReady === true, () => false)
      return ready ? children : null
    }`,
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
      name: "for140-fixture-boundaries",
      enforce: "pre",
      resolveId(sourceId, importer) {
        const path = sourceId.startsWith("@/")
          ? resolve(app, "src", sourceId.slice(2))
          : sourceId.startsWith(".") && importer
            ? resolve(dirname(importer), sourceId)
            : sourceId
        for (const key of stubs.keys())
          if (path.replace(/\.[jt]sx?$/, "") === resolve(app, "src", key))
            return `\0for140:${key}`
      },
      load(id) {
        if (id.startsWith("\0for140:")) return stubs.get(id.slice(8))
      },
    },
    react(),
    tailwindcss(),
  ],
})

function snapshot(userId, revision, values = {}) {
  return {
    version: 1,
    userId,
    revision,
    values,
    fieldVersions: Object.fromEntries(
      Object.keys(values).map((key) => [key, revision])
    ),
  }
}

let browser
const checks = []
try {
  await server.listen()
  const address = server.httpServer.address()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  })
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem(
      JSON.stringify(["forge.appearance", 1, "bob"]),
      JSON.stringify({
        interfaceTheme: "dark",
        lightTheme: "light",
        darkTheme: "midnight",
      })
    )
  })
  await page.goto(`http://127.0.0.1:${address.port}`)
  await expect(page.locator("html")).toHaveAttribute(
    "data-forge-appearance",
    "system"
  )
  await expect(page.locator("html")).toHaveAttribute("data-forge-theme", "dark")
  await expect(page.locator("html")).toHaveClass(/dark/)
  checks.push(
    "Fresh signed-out session follows the OS and ignores another account's cache"
  )

  await page.evaluate(() => {
    localStorage.setItem(
      JSON.stringify(["forge.appearance", 1, "alice"]),
      JSON.stringify({
        interfaceTheme: "dark",
        lightTheme: "paper",
        darkTheme: "midnight",
      })
    )
    window.__productReady = false
    window.__appearanceSnapshots = {}
    window.__appearanceAuth = {
      user: { id: "alice" },
      session: { id: "session-alice" },
      workspace: { id: "workspace" },
    }
    window.dispatchEvent(new Event("focus"))
  })
  await expect(page.locator("html")).toHaveAttribute(
    "data-forge-theme",
    "midnight"
  )
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).toHaveAttribute(
    "data-forge-theme",
    "midnight"
  )
  checks.push(
    "Saved dark choice paints before workspace data and ignores an OS change"
  )

  await page.evaluate(
    ({ next }) => {
      window.__appearanceSnapshots.alice = next
      window.__productReady = true
      window.dispatchEvent(new Event("appearance-product"))
    },
    {
      next: snapshot("alice", 1, {
        "general.interfaceTheme": "light",
        "general.lightTheme": "paper",
        "general.darkTheme": "midnight",
      }),
    }
  )
  await expect(page.locator("html")).toHaveAttribute(
    "data-forge-theme",
    "paper"
  )
  await expect(page.locator("html")).not.toHaveClass(/dark/)
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveAttribute(
    "data-forge-theme",
    "paper"
  )

  const dialog = page.getByRole("dialog", { name: "Appearance preview" })
  await expect(dialog).toBeVisible()
  const lightSurface = await dialog.evaluate((element) => {
    const editor = element.querySelector(".tiptap")
    const dialogStyle = getComputedStyle(element)
    const editorStyle = getComputedStyle(editor)
    return {
      dialogBackground: dialogStyle.backgroundColor,
      dialogColor: dialogStyle.color,
      editorColor: editorStyle.color,
      scheme: document.documentElement.style.colorScheme,
    }
  })
  expect(lightSurface.scheme).toBe("light")
  assertContrast(
    lightSurface.dialogColor,
    lightSurface.dialogBackground,
    "light dialog"
  )
  assertContrast(
    lightSurface.editorColor,
    lightSurface.dialogBackground,
    "light editor"
  )

  await page.evaluate(
    ({ next }) => {
      window.__appearanceSnapshots.alice = next
      window.dispatchEvent(new Event("focus"))
    },
    {
      next: snapshot("alice", 2, {
        "general.interfaceTheme": "system",
        "general.lightTheme": "paper",
        "general.darkTheme": "forest",
      }),
    }
  )
  await expect(page.locator("html")).toHaveAttribute(
    "data-forge-theme",
    "forest"
  )
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).toHaveAttribute(
    "data-forge-theme",
    "paper"
  )
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveAttribute(
    "data-forge-theme",
    "forest"
  )
  checks.push("Only System follows the operating system, including its palette")

  const darkSurface = await dialog.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      color: style.color,
      scheme: document.documentElement.style.colorScheme,
    }
  })
  expect(darkSurface.scheme).toBe("dark")
  expect(darkSurface.background).not.toBe(lightSurface.dialogBackground)
  assertContrast(darkSurface.color, darkSurface.background, "dark dialog")
  const save = page.getByRole("button", { name: "Save comment" })
  await save.evaluate((element) => element.focus({ focusVisible: true }))
  const focusShadow = await save.evaluate(
    (element) => getComputedStyle(element).boxShadow
  )
  expect(focusShadow).not.toBe("none")
  await page.screenshot({
    path: resolve(output, "appearance-dark.png"),
    fullPage: true,
  })
  checks.push(
    "Dialog and editor tokens follow the palette and the focused action keeps a visible ring"
  )

  await page.evaluate(() => {
    window.__appearanceSnapshots.bob = {
      version: 1,
      userId: "bob",
      revision: 1,
      values: {},
      fieldVersions: {},
    }
    window.__appearanceAuth = {
      user: { id: "bob" },
      session: { id: "session-bob" },
      workspace: { id: "workspace" },
    }
    window.dispatchEvent(new Event("focus"))
  })
  await expect(page.locator("html")).toHaveAttribute(
    "data-forge-appearance",
    "system"
  )
  await expect(page.locator("html")).toHaveAttribute("data-forge-theme", "dark")
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-forge-theme",
    "forest"
  )
  checks.push("An account switch drops the previous appearance")

  expect(errors).toEqual([])
  await writeFile(
    resolve(output, "browser-fixture.json"),
    JSON.stringify(
      {
        issue: "FOR-140",
        environment:
          "Local Chromium fixture, real appearance startup, preference provider, dialog and editor styles; synthetic auth and transport; no database or packaged desktop certification",
        sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: app,
          encoding: "utf8",
        }).trim(),
        checkedAt: new Date().toISOString(),
        checks,
        pageErrors: errors,
      },
      null,
      2
    ) + "\n"
  )
  console.log(
    JSON.stringify({ passed: checks.length, checks, output }, null, 2)
  )
} finally {
  await browser?.close()
  await server?.close()
  await rm(root, { recursive: true, force: true })
}

function parseCssColor(color) {
  const oklab = color.match(/oklab\(\s*([0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)/)
  if (oklab)
    return oklabToSrgb(Number(oklab[1]), Number(oklab[2]), Number(oklab[3]))
  const oklch = color.match(/oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+(-?[0-9.]+)/)
  if (oklch) {
    const hue = (Number(oklch[3]) * Math.PI) / 180
    const chroma = Number(oklch[2])
    return oklabToSrgb(
      Number(oklch[1]),
      chroma * Math.cos(hue),
      chroma * Math.sin(hue)
    )
  }
  const rgb = color.match(/rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const hex = color.match(/^#([0-9a-f]{6})$/i)
  if (hex)
    return [0, 2, 4].map((index) =>
      Number.parseInt(hex[1].slice(index, index + 2), 16)
    )
  throw new Error(`Unparsed color ${color}`)
}

function oklabToSrgb(lightness, a, b) {
  const l = lightness + 0.3963377774 * a + 0.2158037573 * b
  const m = lightness - 0.1055613458 * a - 0.0638541728 * b
  const s = lightness - 0.0894841775 * a - 1.291485548 * b
  const [red, green, blue] = [l ** 3, m ** 3, s ** 3]
  return [
    linearToSrgb(
      4.0767416621 * red - 3.3077115913 * green + 0.2309699292 * blue
    ),
    linearToSrgb(
      -1.2684380046 * red + 2.6097574011 * green - 0.3413193965 * blue
    ),
    linearToSrgb(
      -0.0041960863 * red - 0.7034186147 * green + 1.707614701 * blue
    ),
  ]
}

function linearToSrgb(channel) {
  const clamped = Math.min(1, Math.max(0, channel))
  const encoded =
    clamped <= 0.0031308
      ? 12.92 * clamped
      : 1.055 * clamped ** (1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}

function luminance([red, green, blue]) {
  const channel = (value) => {
    const scaled = value / 255
    return scaled <= 0.04045
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  )
}

function contrast(foreground, background) {
  const [lighter, darker] = [
    luminance(parseCssColor(foreground)),
    luminance(parseCssColor(background)),
  ].sort((left, right) => right - left)
  return (lighter + 0.05) / (darker + 0.05)
}

function assertContrast(foreground, background, label) {
  const ratio = contrast(foreground, background)
  if (ratio < 4.5)
    throw new Error(
      `${label} contrast ${ratio.toFixed(2)} for ${foreground} on ${background}`
    )
}

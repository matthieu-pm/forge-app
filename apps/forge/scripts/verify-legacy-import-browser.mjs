import { chromium, expect } from "@playwright/test"
import { createServer } from "vite"
import react from "@vitejs/plugin-react"
import tailwind from "@tailwindcss/vite"
import { readFile, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { realpathSync } from "node:fs"
import path from "node:path"

// Browser fixture: real source components, schemas, crypto, IndexedDB and downloads.
// The authenticated context endpoint is stubbed; no external service or DB is used.
const root = fileURLToPath(new URL("../", import.meta.url))
const output = process.env.FORGE_IMPORT_BROWSER_EVIDENCE ?? "/tmp/for53-browser"
const errors = []
const requests = []
let browser
const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/for53-vite-cache",
  optimizeDeps: {
    noDiscovery: true,
    include: [
      "react",
      "react-dom/client",
      "react/jsx-runtime",
      "@base-ui/react/button",
      "@base-ui/react > use-sync-external-store/shim/with-selector",
      "@base-ui/react > use-sync-external-store/shim",
    ],
  },
  root,
  resolve: {
    alias: { "@": path.join(root, "src") },
    dedupe: ["react", "react-dom"],
  },
  plugins: [
    {
      name: "for53-browser-fixture",
      enforce: "pre",
      resolveId(id) {
        if (id === "@tanstack/react-start")
          return "\0for53-unused-server-functions"
        if (id === "/__for53-entry.tsx") return "\0for53-entry"
        if (
          id === "@/lib/legacy-import-state" ||
          id === path.join(root, "src/lib/legacy-import-state") ||
          id === path.join(root, "src/lib/legacy-import-state.ts")
        )
          return "\0for53-context"
      },
      load(id) {
        if (id === "\0for53-unused-server-functions")
          return `export function createServerFn() { const builder = { validator: () => builder, handler: () => async () => { throw new Error("Unexpected server function in isolated browser fixture"); } }; return builder; }`
        if (id === "\0for53-context")
          return `
          import { defaultDefinitionValue } from "@/lib/issue-definition-contract";
          const context = {actorId:"alice",sessionId:"fixture-session",workspace:{id:"w",name:"Browser acceptance"},teams:[{id:"team",name:"Private destination",visibility:"private"}],definitions:[{workspaceId:"w",teamId:"team",revision:0,canManage:true,value:defaultDefinitionValue()}]};
          export async function loadLegacyPreviewContext() { return structuredClone(context); }
        `
        if (id === "\0for53-entry")
          return `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { LegacyImportPreview } from "@/components/legacy-import-preview";
          import { blankIssueDraft, initialIssueStore } from "@/lib/team-issues";
          import { initialTeamLabels } from "@/lib/team-labels";
          import "@/styles.css";
          if (!localStorage.getItem("fixture-ready")) {
            localStorage.setItem("forge:team-issues:v1:legacy-team", JSON.stringify({...initialIssueStore(),issues:[{...blankIssueDraft(),id:"legacy-id",number:7,title:"Recover my browser work",creator:"Unverified historical author",suggestedLabel:"",completedAt:null,createdAt:"2026-10-01T00:00:00Z",updatedAt:"2026-10-01T00:00:00Z",statusChangedAt:"2026-10-01T00:00:00Z"}]}));
            localStorage.setItem("forge:team-issue-labels:legacy-team:v1", JSON.stringify(initialTeamLabels("forge")));
            localStorage.setItem('forge:signal-documents:v1:["old","alice"]', "{malformed\\u0000\\ud800");
            localStorage.setItem("forge:profile:bob", "OTHER-ACCOUNT-SECRET");
            localStorage.setItem("fixture-ready", "1");
          }
          createRoot(document.getElementById("root")).render(React.createElement("main", {className:"mx-auto max-w-3xl p-6"}, React.createElement(LegacyImportPreview)));
        `
      },
      configureServer(dev) {
        dev.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__for53") return next()
          res.setHeader("Content-Type", "text/html")
          res.end(
            await dev.transformIndexHtml(
              "/__for53",
              '<html><head></head><body><div id="root"></div><script type="module" src="/__for53-entry.tsx"></script></body></html>'
            )
          )
        })
      },
    },
    react(),
    tailwind(),
  ],
  server: {
    host: "127.0.0.1",
    port: 0,
    fs: {
      allow: [
        root,
        fileURLToPath(new URL("../../../", import.meta.url)),
        realpathSync(path.join(root, "node_modules")),
        realpathSync(path.join(root, "../../node_modules")),
      ],
    },
  },
})
try {
  await server.listen()
  const address = server.httpServer.address()
  const origin = `http://127.0.0.1:${address.port}`
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("request", (request) =>
    requests.push({ method: request.method(), url: request.url() })
  )
  await page.goto(`${origin}/__for53`)
  const originals = await page.evaluate(() => ({ ...localStorage }))
  await page.getByRole("button", { name: "Preview browser data" }).click()
  await expect(page.getByText("Destination workspace:")).toBeVisible()
  await expect(page.getByText(/Version 1.*malformed/)).toBeVisible()
  await expect(page.getByText(/1 other-account sources excluded/)).toBeVisible()
  for (const input of await page.getByRole("checkbox").all())
    await expect(input).not.toBeChecked()
  await page
    .getByRole("combobox", { name: "Destination for Team issues" })
    .selectOption("team")
  const issues = page.getByRole("group", { name: "Team issues", exact: true })
  await issues.locator("summary").click()
  await page.getByRole("checkbox", { name: "Recover my browser work" }).check()
  await page
    .getByRole("checkbox", {
      name: /I am entitled to import the selected team issues/,
    })
    .check()
  await page
    .getByRole("checkbox", { name: "Back up this source: Team issues" })
    .check()
  await page
    .getByRole("checkbox", { name: "Back up this source: signal-documents" })
    .check()
  await page.getByRole("button", { name: "Save local backup" }).click()
  await expect(page.getByText(/Backup saved and verified/)).toBeVisible()
  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download verified backup" }).click()
  const download = await downloadPromise
  const backupPath = path.join(output, download.suggestedFilename())
  await download.saveAs(backupPath)
  const backup = JSON.parse(await readFile(backupPath, "utf8"))
  expect(backup.entries).toHaveLength(2)
  for (const entry of backup.entries)
    expect(entry.raw).toBe(originals[entry.key])
  expect(JSON.stringify(backup)).not.toContain("OTHER-ACCOUNT-SECRET")
  await page.getByRole("button", { name: "Confirm selected choices" }).click()
  await expect(
    page.getByText(/Choices confirmed for this snapshot/)
  ).toBeVisible()
  await page.screenshot({
    path: path.join(output, "desktop.png"),
    fullPage: true,
  })
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual(originals)
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("forge-legacy-backups-v1", 1)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction("backups", "readwrite")
        tx.objectStore("backups").add({
          id: "other-account-backup",
          actorId: "bob",
          entries: [{ raw: "OTHER-ACCOUNT-SECRET" }],
        })
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      request.onerror = () => reject(request.error)
    })
  })
  await page.reload()
  await page.getByRole("button", { name: "Preview browser data" }).click()
  await page.evaluate(() => {
    IDBObjectStore.prototype.getAll = () => {
      throw new Error("Account backup listing must use its actor index")
    }
  })
  await page
    .getByRole("button", { name: "Find saved backups for this account" })
    .click()
  await expect(
    page.getByRole("button", { name: /Download backup from/ })
  ).toBeVisible()
  const tab = await context.newPage()
  await tab.goto(`${origin}/__for53`)
  await tab.evaluate(() =>
    localStorage.setItem("forge:team-issues:v1:legacy-team", "{changed")
  )
  await expect(page.getByRole("alert")).toContainText("Browser data changed")
  await expect(
    page.getByRole("button", { name: "Confirm selected choices" })
  ).toBeDisabled()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: path.join(output, "mobile.png"),
    fullPage: true,
  })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  expect(errors).toEqual([])
  expect(requests.filter((request) => request.method !== "GET")).toEqual([])
  console.log(
    JSON.stringify(
      {
        environment: "local Chromium fixture; authenticated context stubbed",
        assertions: [
          "explicit discovery",
          "initially unselected",
          "malformed preservation",
          "other-account exclusion",
          "exact verified download",
          "source immutability",
          "specific confirmation",
          "IndexedDB retention after reload",
          "account-indexed backup listing without payload full scans",
          "cross-tab invalidation",
          "390px layout",
          "no page errors",
          "no non-GET requests",
        ],
        screenshots: [
          path.join(output, "desktop.png"),
          path.join(output, "mobile.png"),
        ],
      },
      null,
      2
    )
  )
} finally {
  await browser?.close()
  await server.close()
}

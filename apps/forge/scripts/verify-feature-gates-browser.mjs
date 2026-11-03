import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { chromium, expect as browserExpect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"

const expect = browserExpect.configure({ timeout: 30000 })
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim()
if (
  process.env.FORGE_FEATURE_GATES_AUTHORIZED_REVISION !== revision ||
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
)
  throw new Error("Clean exact authorized source required")
const base = process.env.FORGE_FEATURE_GATES_BASE ?? "https://app.forgenow.tech"
const origin = new URL(base)
if (
  origin.protocol !== "https:" ||
  origin.origin !== base ||
  (origin.hostname !== "app.forgenow.tech" &&
    !origin.hostname.endsWith("-matthieu-pm.vercel.app"))
)
  throw new Error("Unexpected release URL")
const scope = process.env.FORGE_FEATURE_GATES_SCOPE
if (!/^for103-release-[a-f0-9-]{36}$/.test(scope ?? ""))
  throw new Error("Explicit unique fixture scope required")
const connection = process.env.DATABASE_URL
const databaseUrl = new URL(connection)
if (
  databaseUrl.hostname.replace("-pooler.", ".") !==
    "ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech" ||
  databaseUrl.pathname !== "/neondb"
)
  throw new Error("Wrong database target")
const rpcOnly = process.env.FORGE_FEATURE_GATES_RPC_ONLY === "true"
const expectedPreview =
  process.env.FORGE_FEATURE_GATES_EXPECT_PREVIEW === "true"
const secretFile = process.env.FORGE_FEATURE_GATES_SHARE_FILE
const share = secretFile ? readFileSync(secretFile, "utf8").trim() : null
const require = createRequire(import.meta.url)
const startRoot = dirname(require.resolve("@tanstack/react-start/package.json"))
const coreRoot = realpathSync(resolve(startRoot, "../start-client-core"))
const rpcPath = resolve(coreRoot, "dist/esm/client-rpc/index.js")
const { runWithStartContext } = await import(
  pathToFileURL(resolve(coreRoot, "../start-storage-context/dist/esm/index.js"))
    .href
)
process.env.TSS_SERVER_FN_BASE = `${base}/_serverFn/`
const { createClientRpc } = await import(pathToFileURL(rpcPath).href)
const ids = {}
for (const file of readdirSync(".output/server/_ssr")) {
  if (!file.endsWith(".mjs")) continue
  const content = readFileSync(resolve(".output/server/_ssr", file), "utf8")
  for (const match of content.matchAll(
    /id:\s*"([a-f0-9]+)",\s*name:\s*"([^"]+)"/g
  ))
    ids[match[2]] = match[1]
}
for (const name of [
  "loadFeatureAvailability",
  "persistProductState",
  "loadAccountPreferences",
  "saveAccountPreferences",
])
  if (!ids[name]) throw new Error(`Missing built function ${name}`)
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: connection })
const workspaces = [`${scope}-allowed`, `${scope}-other`]
const users = [`${scope}-alice`, `${scope}-bob`]
const password = crypto.randomUUID()
let browser,
  verified = false
const checks = [],
  pageErrors = []
async function rpc(context, name, method = "GET", data, forged = false) {
  const result = await runWithStartContext({ startOptions: {} }, () =>
    createClientRpc(ids[name])({
      method,
      data,
      fetch: async (url, init) => {
        const headers = {
          ...Object.fromEntries(new Headers(init.headers)),
          Origin: base,
          ...(forged
            ? { "x-workspace-id": workspaces[0], "x-feature-enabled": "true" }
            : {}),
        }
        const response = await context.request.fetch(url, {
          method: init.method,
          headers,
          data: init.body,
          maxRedirects: 0,
        })
        return new Response(await response.body(), {
          status: response.status(),
          headers: response.headers(),
        })
      },
    })
  )
  if (result?.error) throw result.error
  return result?.result ?? result
}
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
  verified = true
  for (let i = 0; i < 2; i++) {
    await pool.query(
      "INSERT INTO organization(id,name,slug) VALUES($1,'FOR103 release acceptance',$1)",
      [workspaces[i]]
    )
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [
        users[i],
        i ? "Other workspace owner" : "Test workspace owner",
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
    await pool.query(
      "INSERT INTO product_state(id,workspace_id,owner_id,owner_user_id,key,encoded_value,revision) VALUES($1,$2,$3,$4,$5,$6,1)",
      [
        crypto.randomUUID(),
        workspaces[i],
        `user:${users[i]}`,
        users[i],
        `forge:signals:v1:${users[i]}:${workspaces[i]}`,
        JSON.stringify(JSON.stringify({ fixture: scope, preserved: true })),
      ]
    )
  }
  browser = await chromium.launch({ headless: true })
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ])
  const pages = []
  for (let i = 0; i < 2; i++) {
    const context = contexts[i]
    if (share) {
      const response = await context.request.get(
        `${base}/?_vercel_share=${encodeURIComponent(share)}`
      )
      if (!response.ok()) throw new Error("Candidate access failed")
    }
    const login = await context.request.post(`${base}/api/auth/sign-in/email`, {
      headers: { Origin: "https://app.forgenow.tech" },
      data: { email: `${users[i]}@example.test`, password },
    })
    expect(login.status()).toBe(200)
    expect(
      (
        await context.request.post(`${base}/api/auth/organization/set-active`, {
          headers: { Origin: "https://app.forgenow.tech" },
          data: { organizationId: workspaces[i] },
        })
      ).status()
    ).toBe(200)
    const state = await rpc(
      context,
      "loadFeatureAvailability",
      "GET",
      { workspaceId: workspaces[0], enabled: true },
      true
    )
    expect(state.workspaceId).toBe(workspaces[i])
    expect(state.userId).toBe(users[i])
    expect(state.features.signals).toBe(
      expectedPreview && i === 0 ? "preview" : "disabled"
    )
    expect(state.features.reviews).toBe(
      expectedPreview && i === 0 ? "preview" : "disabled"
    )
    expect(state.features.billing).toBe("disabled")
    checks.push(
      `workspace ${i + 1}: authenticated feature discovery ignores forged flags`
    )
    const before = (
      await pool.query(
        "SELECT count(*)::integer n FROM product_state WHERE workspace_id=$1 AND key LIKE 'forge:signals:%'",
        [workspaces[i]]
      )
    ).rows[0].n
    let denied = false
    try {
      await rpc(
        context,
        "persistProductState",
        "POST",
        {
          workspaceId: workspaces[i],
          sessionId: state.sessionId,
          commandKey: crypto.randomUUID(),
          key: `forge:signals:v1:${users[i]}:${workspaces[i]}`,
          value: JSON.stringify({ enabled: true }),
          expectedRevision: 1,
        },
        true
      )
    } catch {
      denied = true
    }
    expect(denied).toBe(true)
    expect(
      (
        await pool.query(
          "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key LIKE 'forge:signals:%'",
          [workspaces[i]]
        )
      ).rows[0].encoded_value
    ).toContain("preserved")
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM product_state WHERE workspace_id=$1 AND key LIKE 'forge:signals:%'",
          [workspaces[i]]
        )
      ).rows[0].n
    ).toBe(before)
    checks.push(
      `workspace ${i + 1}: direct deferred write denied and source bytes retained`
    )
    if (rpcOnly) continue
    const prefs = await rpc(context, "loadAccountPreferences", "GET", {
      scope: "account",
    })
    if (prefs.status === "ready") {
      const patch = {
        "agent.guidance": "FOR103 private recovered draft",
        "general.interfaceTheme": "dark",
      }
      const command = {
        sessionId: state.sessionId,
        expectedWorkspaceId: workspaces[i],
        commandKey: crypto.randomUUID(),
        version: 1,
        patch,
        expectedVersions: { "agent.guidance": 0, "general.interfaceTheme": 0 },
      }
      const key = `forge:preference-draft:v1:account:${encodeURIComponent(users[i])}:${encodeURIComponent(workspaces[i])}`
      const value = JSON.stringify({
        userId: users[i],
        workspaceId: workspaces[i],
        pending: patch,
        expected: command.expectedVersions,
        command,
        conflict: false,
      })
      await pool.query(
        "INSERT INTO product_state(id,workspace_id,owner_id,owner_user_id,key,encoded_value,revision) VALUES($1,$2,$3,$4,$5,$6,1)",
        [
          crypto.randomUUID(),
          workspaces[i],
          `user:${users[i]}`,
          users[i],
          key,
          JSON.stringify(value),
        ]
      )
    }
    const page = await context.newPage()
    pages.push(page)
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.goto(`${base}/workspace/signals?preview=true`)
    await expect(
      page.getByRole("heading", { name: "Signals", exact: true })
    ).toBeVisible({ timeout: 60000 })
    await expect(page.getByRole("main").last()).toContainText(
      expectedPreview && i === 0
        ? "Fictional preview"
        : "This feature is unavailable"
    )
    expect(
      await page.getByRole("main").last().getByRole("button").count()
    ).toBe(0)
    await expect
      .poll(() =>
        page.getByRole("link", { name: "Signals", exact: true }).count()
      )
      .toBe(expectedPreview && i === 0 ? 1 : 0)
    checks.push(
      `workspace ${i + 1}: navigation and deep link agree without a sample write action`
    )
    if (prefs.status === "ready") {
      await page
        .getByRole("button", { name: "Retry preferences", exact: true })
        .click({ timeout: 60000 })
      await expect(
        page.getByRole("button", {
          name: "Download preserved draft",
          exact: true,
        })
      ).toBeVisible()
      await expect(
        page.getByRole("button", { name: "Retry preferences", exact: true })
      ).toHaveCount(0)
      const normal = await rpc(context, "saveAccountPreferences", "POST", {
        sessionId: state.sessionId,
        expectedWorkspaceId: workspaces[i],
        commandKey: crypto.randomUUID(),
        version: 1,
        patch: { "calls.language": "fr" },
        expectedVersions: { "calls.language": 0 },
      })
      expect(normal.status).toBe("saved")
      const values = (
        await pool.query(
          'SELECT "values" FROM account_preferences WHERE user_id=$1',
          [users[i]]
        )
      ).rows[0].values
      expect(values["calls.language"]).toBe("fr")
      expect(values["agent.guidance"]).toBeUndefined()
      expect(values["general.interfaceTheme"]).toBeUndefined()
      checks.push(
        `workspace ${i + 1}: recovered mixed guidance draft preserved, unapplied, normal preference save allowed`
      )
    } else
      checks.push(
        `workspace ${i + 1}: personal preference sync disabled by serving configuration`
      )
    for (const path of [
      "/reviews/created",
      "/workspace/insights",
      "/settings/signals",
      "/settings/billing",
      "/settings/applications",
      "/settings/account/agents",
      "/settings/project-updates",
      "/settings/sla",
    ]) {
      await page.goto(`${base}${path}`)
      await expect(page.getByRole("main").last()).toContainText(
        path === "/reviews/created" && expectedPreview && i === 0
          ? "Fictional preview"
          : "This feature is unavailable",
        { timeout: 60000 }
      )
      expect(new URL(page.url()).pathname).toBe(path)
    }
    checks.push(
      `workspace ${i + 1}: settings and Reviews/Insights direct URLs are honest`
    )
    await page.goto(`${base}/settings/import-export`)
    await expect(
      page.getByRole("button", { name: "Export unavailable", exact: true })
    ).toBeDisabled({ timeout: 60000 })
    await expect(
      page.getByText(
        "Issue export is unavailable. No export can be requested and no download email will be sent."
      )
    ).toBeVisible()
    checks.push(`workspace ${i + 1}: export has no false job/email success`)
  }
  expect(pageErrors).toEqual([])
  writeFileSync(
    process.env.FORGE_FEATURE_GATES_RESULT ??
      "/tmp/for103-browser-evidence.json",
    JSON.stringify(
      { revision, base, identity, scope, expectedPreview, checks, pageErrors },
      null,
      2
    ) + "\n"
  )
  console.log(
    JSON.stringify({
      passed: checks.length,
      pageErrors: pageErrors.length,
      expectedPreview,
    })
  )
} catch (error) {
  console.error(
    "Acceptance failed:",
    String(error?.message ?? error).replace(
      /(_vercel_share=)[A-Za-z0-9_-]+/g,
      "$1[redacted]"
    )
  )
  throw error
} finally {
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM organization WHERE id=ANY($1::text[])", [
      workspaces,
    ])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users])
    const left = (
      await pool.query(
        'SELECT (SELECT count(*) FROM organization WHERE id=ANY($1::text[])) workspaces,(SELECT count(*) FROM "user" WHERE id=ANY($2::text[])) users,(SELECT count(*) FROM session WHERE user_id=ANY($2::text[])) sessions',
        [workspaces, users]
      )
    ).rows[0]
    expect(left).toEqual({ workspaces: "0", users: "0", sessions: "0" })
    console.log(JSON.stringify({ cleanup: left }))
  }
  await pool.end()
}

import { readFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"
const file = process.env.FORGE_DOCUMENT_TEST_DATABASE_FILE
if (!file) throw new Error("FORGE_DOCUMENT_TEST_DATABASE_FILE is required")
const config = JSON.parse(readFileSync(file, "utf8")),
  url = new URL(config.connection)
if (
  url.hostname !== "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/forge_documents_acceptance" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the dedicated acceptance database is allowed")
const base = process.env.FORGE_DOCUMENT_BROWSER_URL ?? "http://localhost:3161",
  baseUrl = new URL(base)
if (
  baseUrl.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(baseUrl.hostname) ||
  baseUrl.username ||
  baseUrl.password
)
  throw new Error("A local acceptance server is required")
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection }),
  marker = `for61-browser-${crypto.randomUUID()}`,
  teamId = crypto.randomUUID(),
  password = `for61-${crypto.randomUUID()}`,
  users = [`${marker}-admin`, `${marker}-member`]
let browser,
  verified = false
try {
  const identity = (
    await pool.query(
      "SELECT current_database() database,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  if (
    identity.database !== "forge_documents_acceptance" ||
    identity.branch !== "br-autumn-union-za0opf1e"
  )
    throw new Error("Wrong database")
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR61 Acceptance',$1)",
    [marker]
  )
  await pool.query(
    "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'enterprise','active')",
    [marker]
  )
  for (let i = 0; i < users.length; i++) {
    const id = users[i]
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [id, i === 0 ? "Alice Admin" : "Bob Member", `${id}@example.test`]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)",
      [crypto.randomUUID(), id, marker, i === 0 ? "admin" : "member"]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), id, await hashPassword(password)]
    )
  }
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Engineering','engineering','ENG','emoji','⚙️','#94a3b8','Europe/Paris',$3)",
    [teamId, marker, users[0]]
  )
  await pool.query(
    "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member'),($5,$2,$3,$6,'member')",
    [
      crypto.randomUUID(),
      marker,
      teamId,
      users[0],
      crypto.randomUUID(),
      users[1],
    ]
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
        data: { email: `${users[i]}@example.test`, password },
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
  const [admin, member] = await Promise.all(contexts.map((c) => c.newPage()))
  const errors = []
  for (const page of [admin, member])
    page.on("pageerror", (e) => errors.push(e.message))

  await admin.goto(`${base}/teams/engineering/documents`)
  await expect(admin.getByRole("button", { name: "New document", exact: true })).toBeEnabled({ timeout: 60000 })
  await admin.getByRole("button", { name: "New document", exact: true }).click()
  const title = admin.getByRole("textbox", { name: "Document title", exact: true })
  await expect(title).toBeVisible({ timeout: 30000 })
  await title.fill("FOR61 durable writing")
  await admin.getByRole("textbox", { name: "Document content", exact: true }).fill("Alice original rich text")
  const row = async () => (await pool.query("SELECT id,revision,title,content FROM documents WHERE workspace_id=$1 AND deleted_at IS NULL", [marker])).rows[0]
  await expect.poll(async () => (await row())?.content, { timeout: 30000 }).toBe("Alice original rich text")
  const doc = await row()
  await expect(admin.getByRole("status").filter({hasText:/Saved · Revision/})).toBeVisible({ timeout: 30000 })
  await member.goto(`${base}/teams/engineering/documents?document=${doc.id}`)
  await expect(member.getByRole("textbox", { name: "Document title", exact: true })).toHaveValue("FOR61 durable writing", { timeout: 60000 })
  await expect(member.getByRole("textbox", { name: "Document content", exact: true })).toHaveText("Alice original rich text")
  expect(await member.getByRole("button", { name: "Delete", exact: true }).count()).toBe(0)
  // Hold Bob's outgoing save, then commit Alice's newer text before releasing it.
  let release, held=false
  const barrier=new Promise(resolve => {release=resolve})
  await member.route("**/*", async route => {
    const req=route.request()
    if(req.method()==="POST" && req.postData()?.includes("save") && !held){held=true;await barrier}
    await route.continue()
  })
  await member.getByRole("textbox", { name: "Document content", exact: true }).fill("Bob preserved conflict draft")
  await expect.poll(() => held, {timeout:10000}).toBe(true)
  await admin.getByRole("textbox", { name: "Document content", exact: true }).fill("Alice newer version")
  await expect.poll(async () => (await row()).content, { timeout:30000 }).toBe("Alice newer version")
  release()
  await expect(member.getByRole("button", { name:"Save reviewed draft",exact:true })).toBeVisible({timeout:30000})
  await expect(member.getByLabel("Latest saved document")).toContainText("Alice newer version")
  await expect(member.getByRole("textbox",{name:"Document content",exact:true})).toHaveText("Bob preserved conflict draft")
  await member.screenshot({path:"/tmp/for61-conflict.png",fullPage:true})
  await member.reload()
  await expect(member.getByText("Unsaved draft recovered. Review it, then retry saving.", {exact:true})).toBeVisible({timeout:30000})
  await expect(member.getByRole("textbox",{name:"Document content",exact:true})).toHaveText("Bob preserved conflict draft")
  await member.getByRole("button",{name:"Try again",exact:true}).click()
  await expect(member.getByRole("button",{name:"Save reviewed draft",exact:true})).toBeVisible({timeout:30000})
  await member.getByRole("button",{name:"Save reviewed draft",exact:true}).click()
  await expect.poll(async () => (await row()).content,{timeout:30000}).toBe("Bob preserved conflict draft")
  await expect(member.getByRole("status").filter({hasText:/Saved · Revision/})).toBeVisible({timeout:30000})
  await member.getByLabel("Document editor").getByRole("button",{name:"History",exact:true}).click()
  const old=(await pool.query("SELECT revision FROM document_revisions WHERE document_id=$1 AND snapshot->'body'->'content'->0->'content'->0->>'text'='Alice original rich text' ORDER BY revision DESC LIMIT 1",[doc.id])).rows[0]
  await member.getByRole("button",{name:new RegExp(`^Revision ${old.revision} ·`)}).click()
  await member.getByRole("button",{name:`Restore revision ${old.revision}`,exact:true}).click()
  await expect.poll(async () => (await row()).content,{timeout:30000}).toBe("Alice original rich text")
  await member.reload()
  await expect(member.getByRole("textbox",{name:"Document content",exact:true})).toHaveText("Alice original rich text",{timeout:30000})
  await expect(member.getByText("Unsaved draft recovered. Review it, then retry saving.",{exact:true})).toHaveCount(0)
  // Actual failed transport keeps a journal; retries must not discard the draft.
  await member.route("**/*", async route => {
    const req=route.request()
    if(req.method()==="POST" && req.postData()?.includes("save")) await route.abort("failed")
    else await route.continue()
  })
  await member.getByRole("textbox",{name:"Document content",exact:true}).fill("Network failure draft")
  await expect(member.getByRole("button",{name:"Try again",exact:true})).toBeVisible({timeout:30000})
  await member.unrouteAll({behavior:"wait"})
  await member.reload()
  await expect(member.getByRole("textbox",{name:"Document content",exact:true})).toHaveText("Network failure draft",{timeout:30000})
  await member.getByRole("button",{name:"Try again",exact:true}).click()
  await expect.poll(async () => (await row()).content,{timeout:30000}).toBe("Network failure draft")
  await member.setViewportSize({width:390,height:844})
  await member.screenshot({path:"/tmp/for61-mobile.png",fullPage:true})
  expect(await member.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  await admin.goto(`${base}/workspace/documents?document=${doc.id}`)
  await expect(admin.getByRole("textbox",{name:"Document content",exact:true})).toHaveText("Network failure draft",{timeout:30000})
  await admin.screenshot({path:"/tmp/for61-editor.png",fullPage:true})
  const unexpected=errors.filter(e=>!e.includes("Failed to fetch") && !e.includes("path.endsWith"))
  expect(unexpected).toEqual([])
  console.log(JSON.stringify({issue:"FOR-61",passed:true,environment:identity,checks:["two signed-in sessions","shared content and metadata","stale save conflict with draft and latest view","reload recovers conflict draft","explicit reviewed save","history restore appends revision","failed network recovery and retry","global authorized document link","mobile no horizontal overflow"]}))
} finally {
  await browser?.close()
  if (verified) {
    // Closing the browser does not cancel already-running server transactions.
    // Retry only serialization/deadlock rollbacks of this exact owned fixture.
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

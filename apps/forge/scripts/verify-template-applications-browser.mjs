import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { hashPassword } from "better-auth/crypto"

const config = JSON.parse(
  readFileSync(process.env.FORGE_TEMPLATE_TEST_DATABASE_FILE, "utf8")
)
const base = process.env.FORGE_TEMPLATE_BROWSER_URL ?? "http://localhost:3163"
const database = new URL(config.connection),
  host = new URL(base)
if (
  database.hostname.replace("-pooler.", ".") !==
    "ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech" ||
  database.pathname !== "/forge_templates_acceptance" ||
  host.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(host.hostname)
)
  throw Error("Use the isolated template acceptance database and local server")
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: config.connection }),
  marker = `for63-browser-${crypto.randomUUID()}`,
  userId = `${marker}-member`,
  teamId = crypto.randomUUID(),
  password = crypto.randomUUID()
const icon = { kind: "icon", value: "CubeIcon", color: "#94a3b8" }
const properties = () => ({
  teamIds: [teamId],
  status: "Backlog",
  priority: "High",
  assignee: null,
  lead: null,
  members: [],
  project: null,
  initiatives: [],
  labels: [],
  dependencies: [],
})
const payload = (kind) => ({
  name: kind === "issue" ? "Request form" : "Launch setup",
  kind,
  icon,
  title: kind === "issue" ? "New request" : "Launch project",
  description: "",
  summary: "Launch summary",
  content: null,
  properties: properties(),
  visibility: "",
  milestones: [],
  issues: [],
  subIssues: [],
  issueType: "standard",
  fields: [],
})
let browser,
  page,
  verified = false
try {
  const identity = (
    await pool.query(
      "SELECT current_database() db,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  expect(identity).toEqual({
    db: "forge_templates_acceptance",
    branch: "br-autumn-union-za0opf1e",
  })
  verified = true
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR63 Browser',$1)",
    [marker]
  )
  await pool.query(
    "INSERT INTO \"user\"(id,name,email,email_verified) VALUES($1,'Template Member',$2,true)",
    [userId, `${userId}@example.test`]
  )
  await pool.query(
    "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'member')",
    [crypto.randomUUID(), marker, userId]
  )
  await pool.query(
    "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
    [crypto.randomUUID(), userId, await hashPassword(password)]
  )
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Engineering','engineering','ENG','emoji','🔥','#94a3b8','Europe/Paris',$3)",
    [teamId, marker, userId]
  )
  const issueTemplate = {
    ...payload("issue"),
    issueType: "form",
    fields: [
      {
        id: "impact",
        label: "Impact",
        type: "select",
        required: true,
        options: ["High", "Low"],
      },
    ],
    subIssues: [
      {
        id: "child",
        title: "Investigate request",
        content: null,
        properties: properties(),
      },
    ],
  }
  const projectTemplate = {
    ...payload("project"),
    milestones: [{ id: "milestone", title: "Ship", content: null }],
    issues: [
      {
        id: "work",
        title: "Prepare release",
        content: null,
        properties: { ...properties(), status: "In Review" },
      },
    ],
  }
  const templateIds = []
  for (const p of [issueTemplate, projectTemplate])
    templateIds.push(
      (
        await pool.query(
          "INSERT INTO team_templates(workspace_id,payload,created_by_user_id) VALUES($1,$2,$3) RETURNING id",
          [marker, p, userId]
        )
      ).rows[0].id
    )
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  })
  const login = await context.request.post(`${base}/api/auth/sign-in/email`, {
    data: { email: `${userId}@example.test`, password },
    headers: { Origin: base },
    timeout: 120000,
  })
  expect(login.ok()).toBe(true)
  expect(
    (
      await context.request.post(`${base}/api/auth/organization/set-active`, {
        data: { organizationId: marker },
        headers: { Origin: base },
      })
    ).ok()
  ).toBe(true)
  page = await context.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`${base}/settings/issue-templates`)
  await page
    .getByRole("button", { name: "Create from template", exact: true })
    .click({ timeout: 60000 })
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByLabel("Template issue title")).toHaveValue(
    "New request"
  )
  await dialog
    .getByRole("button", { name: "Create issue", exact: true })
    .click()
  await expect(dialog.getByRole("alert")).toContainText("Impact", {
    timeout: 30000,
  })
  expect(
    (await pool.query("SELECT 1 FROM issues WHERE workspace_id=$1", [marker]))
      .rowCount
  ).toBe(0)
  await dialog.getByLabel("Impact").selectOption("High")
  // Let the mutation commit, then discard its response. The UI must retry its original journal.
  let dropped = false
  await page.route("**/*", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postData()?.includes(templateIds[0]) &&
      !route
        .request()
        .postData()
        ?.includes("forge:template-application-intent") &&
      !dropped
    ) {
      dropped = true
      await route.fetch()
      await route.abort("failed")
    } else await route.continue()
  })
  await dialog
    .getByRole("button", { name: "Create issue", exact: true })
    .click()
  await expect(
    dialog.getByRole("button", { name: "Retry creation", exact: true })
  ).toBeVisible({ timeout: 30000 })
  expect(dropped).toBe(true)
  await page.unroute("**/*")
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
            [marker]
          )
        ).rows[0].n
    )
    .toBe(2)
  await page.reload()
  await page
    .getByRole("button", { name: "Create from template", exact: true })
    .click({ timeout: 30000 })
  await dialog
    .getByRole("button", { name: "Retry creation", exact: true })
    .click()
  await expect(dialog).toHaveCount(0, { timeout: 30000 })
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
        [marker]
      )
    ).rows[0].n
  ).toBe(2)
  await page
    .getByRole("button", { name: "Create from template", exact: true })
    .click()
  await dialog.getByLabel("Impact").selectOption("Low")
  await dialog
    .getByRole("button", { name: "Create issue", exact: true })
    .click()
  await expect(dialog).toHaveCount(0, { timeout: 30000 })
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM issues WHERE workspace_id=$1",
        [marker]
      )
    ).rows[0].n
  ).toBe(4)
  await page.goto(`${base}/settings/project-templates`)
  await page
    .getByRole("button", { name: "Create from template", exact: true })
    .click({ timeout: 30000 })
  // Delete a referenced status after selection: no partial project may commit.
  const removedStatus = (
    await pool.query(
      "SELECT * FROM issue_statuses WHERE team_id=$1 AND id='in-review'",
      [teamId]
    )
  ).rows[0]
  await pool.query(
    "DELETE FROM issue_statuses WHERE team_id=$1 AND id='in-review'",
    [teamId]
  )
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click()
  await expect(dialog.getByRole("alert")).toContainText("status", {
    timeout: 30000,
  })
  expect(
    (await pool.query("SELECT 1 FROM projects WHERE workspace_id=$1", [marker]))
      .rowCount
  ).toBe(0)
  // Repair the intentionally corrupted catalog before an independent full-app read.
  await pool.query(
    "INSERT INTO issue_statuses(row_id,id,workspace_id,team_id,name,status_group,description,color,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      removedStatus.row_id,
      removedStatus.id,
      marker,
      teamId,
      removedStatus.name,
      removedStatus.status_group,
      removedStatus.description,
      removedStatus.color,
      removedStatus.position,
    ]
  )
  await pool.query(
    "UPDATE team_templates SET payload=jsonb_set(jsonb_set(payload,'{issues,0,properties,status}','\"Backlog\"'),'{summary}','\"Updated summary\"') WHERE id=$1",
    [templateIds[1]]
  )
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click()
  await expect(dialog.getByRole("alert")).toContainText("changed", {
    timeout: 30000,
  })
  expect(
    (await pool.query("SELECT 1 FROM projects WHERE workspace_id=$1", [marker]))
      .rowCount
  ).toBe(0)
  await dialog.getByRole("button", { name: "Reload templates" }).click()
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click()
  await expect(dialog).toHaveCount(0, { timeout: 30000 })
  const project = (
    await pool.query(
      "SELECT id,properties FROM projects WHERE workspace_id=$1",
      [marker]
    )
  ).rows[0]
  expect(project.properties.summary).toBe("Updated summary")
  expect(project.properties.milestones[0].name).toBe("Ship")
  expect(
    (await pool.query("SELECT 1 FROM issues WHERE project_id=$1", [project.id]))
      .rowCount
  ).toBe(1)
  await page.goto(`${base}/projects/${project.id}`)
  await expect(
    page.getByText("Launch project", { exact: true }).first()
  ).toBeVisible({ timeout: 30000 })
  await page.screenshot({
    path: "/tmp/for63-browser-project.png",
    fullPage: true,
  })
  expect(errors).toEqual([])
  console.log(
    JSON.stringify({
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      environment: "isolated template acceptance",
      result: "passed",
      assertions: [
        "required form validation",
        "lost response plus reload retains exact retry",
        "distinct creates",
        "stale revision repair",
        "canonical project milestones and issue membership",
        "independent authorized project read",
      ],
    })
  )
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: "/tmp/for63-browser-failure.png", fullPage: true })
      .catch(() => {})
    writeFileSync(
      "/tmp/for63-browser-failure.txt",
      await page
        .locator("body")
        .innerText()
        .catch(() => "Unavailable")
    )
  }
  throw error
} finally {
  await browser?.close()
  if (verified) {
    await pool.query("DELETE FROM organization WHERE id=$1", [marker])
    await pool.query('DELETE FROM "user" WHERE id=$1', [userId])
  }
  await pool.end()
}

import assert from "node:assert/strict"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium, expect as sharedExpect } from "@playwright/test"
import { Pool } from "pg"
import { hashPassword } from "better-auth/crypto"

const expect = sharedExpect.configure({ timeout: 30000 })
const file = process.env.FORGE_EMOTICON_RELEASE_DATABASE_FILE
const commit = process.env.FORGE_EMOTICON_RELEASE_COMMIT
if (!file || !/^[a-f0-9]{40}$/.test(commit ?? ""))
  throw new Error(
    "A private production database file and release commit are required."
  )
const config = JSON.parse(await readFile(file, "utf8"))
const url = new URL(config.connection)
if (
  url.hostname !== "ep-lingering-bread-zazpwrxp.c-2.eu-west-2.aws.neon.tech" ||
  decodeURIComponent(url.pathname) !== "/neondb" ||
  url.searchParams.get("sslmode") !== "require"
)
  throw new Error("Only the established Forge production database is allowed.")
const base = "https://app.forgenow.tech"
const output = resolve(
  process.env.FORGE_EMOTICON_RELEASE_OUTPUT ?? "../../docs/qa/for132"
)
await mkdir(output, { recursive: true })
const pool = new Pool({ connectionString: config.connection })
const marker = `for132-release-${crypto.randomUUID()}`
const users = [`${marker}-writer`, `${marker}-other`]
const teamId = crypto.randomUUID(),
  issueId = crypto.randomUUID()
const password = `for132-${crypto.randomUUID()}`
const result = {
  issue: "FOR-132",
  sourceCommit: commit,
  origin: base,
  startedAt: new Date().toISOString(),
  checks: [],
  pageErrors: [],
  passed: false,
}
let browser,
  verified = false,
  journalBefore
async function check(name, action) {
  await action()
  result.checks.push({ name, status: "passed" })
}
async function savedComments() {
  return (
    (
      await pool.query(
        "SELECT properties->'comments' comments FROM issues WHERE id=$1",
        [issueId]
      )
    ).rows[0]?.comments ?? []
  )
}
async function clear(editor) {
  await editor.click()
  await editor.press("ControlOrMeta+a")
  await editor.press("Backspace")
  await editor.evaluate((element) => {
    element.editor.commands.unsetAllMarks()
    element.editor.commands.setParagraph()
  })
}
async function enabled(editor, value) {
  await expect
    .poll(() =>
      editor.evaluate((element) =>
        element.editor.extensionManager.extensions
          .find((extension) => extension.name === "editorEmoticons")
          ?.options.enabled()
      )
    )
    .toBe(value)
}
try {
  const identity = (
    await pool.query(
      "SELECT current_database() database,current_setting('neon.branch_id',true) branch"
    )
  ).rows[0]
  assert.deepEqual(identity, {
    database: "neondb",
    branch: "br-muddy-queen-zaeeysjt",
  })
  verified = true
  result.database = identity
  journalBefore = (
    await pool.query(
      "SELECT count(*)::int count,max(id) latest FROM drizzle.__drizzle_migrations"
    )
  ).rows[0]
  await pool.query(
    "INSERT INTO organization(id,name,slug) VALUES($1,'FOR132 Release Verification',$1)",
    [marker]
  )
  await pool.query(
    "INSERT INTO workspace_entitlements(workspace_id,plan,status) VALUES($1,'enterprise','active')",
    [marker]
  )
  for (const user of users) {
    await pool.query(
      'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [
        user,
        user === users[0] ? "FOR132 Writer" : "FOR132 Other",
        `${user}@example.test`,
      ]
    )
    await pool.query(
      "INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,'owner')",
      [crypto.randomUUID(), user, marker]
    )
    await pool.query(
      "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
      [crypto.randomUUID(), user, await hashPassword(password)]
    )
  }
  await pool.query(
    "INSERT INTO teams(id,workspace_id,name,slug,identifier,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Emoticon acceptance','emoticons','EMO','emoji','🙂','#94a3b8','Europe/Paris',$3)",
    [teamId, marker, users[0]]
  )
  for (const user of users)
    await pool.query(
      "INSERT INTO team_members(id,workspace_id,team_id,user_id,role) VALUES($1,$2,$3,$4,'member')",
      [crypto.randomUUID(), marker, teamId, user]
    )
  await pool.query(
    "INSERT INTO issues(id,workspace_id,team_id,number,title,creator_id,properties) VALUES($1,$2,$3,1,'FOR132 acceptance',$4,'{}')",
    [issueId, marker, teamId, users[0]]
  )
  browser = await chromium.launch({ headless: true })
  result.browser = `Chromium ${browser.version()}`
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ])
  for (let i = 0; i < contexts.length; i++) {
    const user = users[i === 2 ? 1 : 0]
    const login = await contexts[i].request.post(
      `${base}/api/auth/sign-in/email`,
      {
        data: { email: `${user}@example.test`, password },
        headers: { Origin: base },
      }
    )
    assert.equal(login.status(), 200, "Real Better Auth sign-in")
    const active = await contexts[i].request.post(
      `${base}/api/auth/organization/set-active`,
      { data: { organizationId: marker }, headers: { Origin: base } }
    )
    assert.equal(active.status(), 200, "Active workspace")
  }
  const [main, second, other] = await Promise.all(
    contexts.map((context) => context.newPage())
  )
  const settings = await contexts[0].newPage()
  for (const page of [main, settings, second, other])
    page.on("pageerror", (error) => result.pageErrors.push(error.message))
  const saved = (page) =>
    page.getByText("Preferences saved to your account", { exact: true })
  const control = (page) =>
    page.getByRole("switch", {
      name: "Convert text emoticons into emojis",
      exact: true,
    })
  const editor = main.getByRole("textbox", { name: "Comment", exact: true })
  await main.goto(`${base}/teams/emoticons/issues?view=all&issue=${issueId}`)
  await expect(
    main.getByRole("textbox", { name: "Issue title", exact: true })
  ).toHaveValue("FOR132 acceptance", { timeout: 60000 })
  await enabled(editor, false)
  const mounted = await editor.elementHandle()
  for (const page of [settings, second, other]) {
    await page.goto(`${base}/settings`)
    await expect(saved(page)).toBeVisible({ timeout: 60000 })
  }
  await check(
    "AT-01 opt-in default, persisted setting, independent owner session and account isolation",
    async () => {
      await expect(control(settings)).toHaveAttribute("aria-checked", "false")
      await expect(control(other)).toHaveAttribute("aria-checked", "false")
      await editor.pressSequentially(":) ")
      await expect(editor).toHaveText(":) ")
      await control(settings).click()
      await expect(saved(settings)).toBeVisible()
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT values->'general.convertEmoticons' enabled FROM account_preferences WHERE user_id=$1",
                [users[0]]
              )
            ).rows[0]?.enabled
        )
        .toBe(true)
      await second.reload()
      await expect(control(second)).toHaveAttribute("aria-checked", "true")
      await other.reload()
      await expect(control(other)).toHaveAttribute("aria-checked", "false")
      await main.evaluate(() => window.dispatchEvent(new Event("focus")))
      await enabled(editor, true)
      assert.equal(
        await mounted.evaluate((element) => element.isConnected),
        true,
        "Preference refresh retains mounted editor"
      )
    }
  )
  await check(
    "AT-01 approved tokens, caret and native keyboard undo/redo in the actual composer",
    async () => {
      for (const [token, emoji] of [
        [":)", "🙂"],
        [":-)", "🙂"],
        [":(", "🙁"],
        [":-(", "🙁"],
        [";)", "😉"],
        [";-)", "😉"],
        [":D", "😃"],
        [":-D", "😃"],
      ]) {
        await clear(editor)
        await editor.pressSequentially(token)
        await expect(editor).toHaveText(token)
        await editor.press("Space")
        await expect(editor).toHaveText(`${emoji} `)
        await editor.press("ControlOrMeta+z")
        await expect(editor).toHaveText(`${token} `)
        await editor.press("ControlOrMeta+Shift+z")
        await expect(editor).toHaveText(`${emoji} `)
        await editor.pressSequentially("next")
        await expect(editor).toHaveText(`${emoji} next`)
      }
    }
  )
  await check(
    "AT-02 code marks, code blocks, links and URL fragments",
    async () => {
      for (const name of ["setCode", "setCodeBlock", "setLink"]) {
        await clear(editor)
        await editor.evaluate(
          (element, command) =>
            element.editor.commands[command]({ href: "https://example.test" }),
          name
        )
        await editor.pressSequentially(":-) ")
        await expect(editor).toHaveText(":-) ")
      }
      await clear(editor)
      await editor.pressSequentially("https://example.test/:) ")
      await expect(editor).toHaveText("https://example.test/:) ")
    }
  )
  await check(
    "AT-02 structured paste and selection replacement remain literal",
    async () => {
      await clear(editor)
      await editor.evaluate((element) => {
        const clipboardData = new DataTransfer()
        clipboardData.setData(
          "text/html",
          "<p><strong>:-)</strong> <code>:D</code></p>"
        )
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          })
        )
      })
      await editor.press("Space")
      await expect(editor).toHaveText(":-) :D ")
      await expect(editor.locator("strong")).toHaveText(":-)")
      await clear(editor)
      await editor.pressSequentially("replace")
      await editor.press("ControlOrMeta+a")
      await editor.pressSequentially(":) ")
      await expect(editor).toHaveText(":) ")
    }
  )
  await check(
    "AT-02 Chromium IME composition and completion remain literal",
    async () => {
      await clear(editor)
      const cdp = await contexts[0].newCDPSession(main)
      await cdp.send("Input.imeSetComposition", {
        text: ":)",
        selectionStart: 2,
        selectionEnd: 2,
      })
      await expect(editor).toHaveText(":)")
      await cdp.send("Input.imeSetComposition", {
        text: ":) ",
        selectionStart: 3,
        selectionEnd: 3,
      })
      await expect(editor).toHaveText(":) ")
      await cdp.send("Input.insertText", { text: ":) " })
      await expect(editor).toHaveText(":) ")
      await editor.pressSequentially(";-) ")
      await expect(editor).toHaveText(":) 😉 ")
      await cdp.detach()
    }
  )
  let commentId
  await check(
    "Converted comment and structured document persist through real command, database and reload",
    async () => {
      await clear(editor)
      await editor.pressSequentially("FOR132 converted :) ")
      await expect(editor).toHaveText("FOR132 converted 🙂 ")
      await main
        .getByRole("button", { name: "Submit comment", exact: true })
        .click()
      await expect(editor).toHaveText("")
      await expect.poll(async () => (await savedComments()).length).toBe(1)
      const comment = (await savedComments())[0]
      assert.equal(comment.body, "FOR132 converted 🙂 ")
      assert.ok(
        JSON.stringify(comment.document).includes("FOR132 converted 🙂 ")
      )
      commentId = comment.id
      await main.reload()
      await expect(
        main
          .locator(`[id="comment-${commentId}"]`)
          .getByText("FOR132 converted 🙂", { exact: true })
      ).toBeVisible({ timeout: 60000 })
      await enabled(editor, true)
    }
  )
  await check(
    "New reply and edit composers use the persisted choice and save canonical content",
    async () => {
      const root = main.locator(`[id="comment-${commentId}"]`)
      const reply = root.getByRole("textbox", { name: "Reply", exact: true })
      await enabled(reply, true)
      await reply.pressSequentially("Reply ;) ")
      await expect(reply).toHaveText("Reply 😉 ")
      await root
        .getByRole("button", { name: "Submit reply", exact: true })
        .click()
      await expect(reply).toHaveText("")
      await root
        .getByRole("button", { name: "Comment options", exact: true })
        .first()
        .click()
      await main
        .getByRole("menuitem", { name: "Edit comment", exact: true })
        .click()
      const edit = main.getByRole("textbox", {
        name: "Edit comment",
        exact: true,
      })
      await enabled(edit, true)
      await clear(edit)
      await edit.pressSequentially("Edited :D ")
      await expect(edit).toHaveText("Edited 😃 ")
      await main
        .getByRole("button", { name: "Save comment", exact: true })
        .click()
      await expect(edit).toHaveCount(0)
      const comments = await savedComments()
      assert.equal(
        comments.find((comment) => comment.id === commentId).body,
        "Edited 😃 "
      )
      assert.ok(
        comments.some(
          (comment) =>
            comment.parentId === commentId && comment.body === "Reply 😉 "
        )
      )
      await main.reload()
      await expect(main.getByText("Edited 😃", { exact: true })).toBeVisible({
        timeout: 60000,
      })
      await expect(main.getByText("Reply 😉", { exact: true })).toBeVisible()
    }
  )
  await check(
    "AT-01 disabling reaches an existing composer and saves/reloads literal prose",
    async () => {
      await control(settings).click()
      await expect(saved(settings)).toBeVisible()
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT values->'general.convertEmoticons' enabled FROM account_preferences WHERE user_id=$1",
                [users[0]]
              )
            ).rows[0]?.enabled
        )
        .toBe(false)
      await main.evaluate(() => window.dispatchEvent(new Event("focus")))
      await enabled(editor, false)
      await editor.pressSequentially("FOR132 literal :) ")
      await expect(editor).toHaveText("FOR132 literal :) ")
      await main
        .getByRole("button", { name: "Submit comment", exact: true })
        .click()
      await expect(editor).toHaveText("")
      assert.ok(
        (await savedComments()).some(
          (comment) => comment.body === "FOR132 literal :) "
        )
      )
      await main.reload()
      await expect(
        main.getByText("FOR132 literal :)", { exact: true })
      ).toBeVisible({ timeout: 60000 })
      await second.reload()
      await expect(control(second)).toHaveAttribute("aria-checked", "false")
    }
  )
  assert.deepEqual(result.pageErrors, [])
  await main.screenshot({
    path: resolve(output, "production-comments.png"),
    fullPage: true,
  })
  result.passed = true
} catch (error) {
  result.failure =
    error instanceof Error ? error.message : "Verification failed"
  process.exitCode = 1
} finally {
  await browser?.close()
  if (verified) {
    for (let attempt = 0; ; attempt++) {
      try {
        await pool.query("DELETE FROM organization WHERE id=$1", [marker])
        break
      } catch (error) {
        if (attempt >= 4 || !["40P01", "40001"].includes(error.code))
          throw error
        await new Promise((done) => setTimeout(done, 200 * (attempt + 1)))
      }
    }
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    result.cleanup = (
      await pool.query(
        'SELECT (SELECT count(*)::int FROM organization WHERE id=$1) workspaces,(SELECT count(*)::int FROM "user" WHERE id=ANY($2)) users,(SELECT count(*)::int FROM command_receipts WHERE workspace_id=$1) receipts,(SELECT count(*)::int FROM issues WHERE workspace_id=$1) issues,(SELECT count(*)::int FROM account_preferences WHERE user_id=ANY($2)) preferences',
        [marker, users]
      )
    ).rows[0]
    result.migrations = {
      before: journalBefore,
      after: (
        await pool.query(
          "SELECT count(*)::int count,max(id) latest FROM drizzle.__drizzle_migrations"
        )
      ).rows[0],
    }
    assert.deepEqual(result.cleanup, {
      workspaces: 0,
      users: 0,
      receipts: 0,
      issues: 0,
      preferences: 0,
    })
    assert.deepEqual(result.migrations.after, journalBefore)
  }
  await pool.end()
  result.finishedAt = new Date().toISOString()
  result.limitation =
    "Chromium's IME protocol exercises browser composition; native OS IME and packaged macOS are not certified."
  await writeFile(
    resolve(output, "production-browser.json"),
    `${JSON.stringify(result, null, 2)}\n`
  )
  console.log(JSON.stringify(result, null, 2))
}

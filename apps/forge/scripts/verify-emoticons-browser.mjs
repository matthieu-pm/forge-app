import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "@playwright/test"

// No server, database, account or provider credentials: this exercises the exact
// shared extension with real Chromium text input, selection and keyboard history.
const bundle = resolve("node_modules/.cache/for132-browser.js")
execFileSync("bun", [
  "build",
  "src/test/emoticons-browser-fixture.ts",
  "--target",
  "browser",
  "--outfile",
  bundle,
])
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const checks = []
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const text = () => page.evaluate(() => window.emoticonsFixture.editor.getText())
const reset = async (content = "<p></p>") => {
  await page.evaluate((value) => {
    const editor = window.emoticonsFixture.editor
    editor.commands.setContent(value)
    editor.commands.focus("end")
  }, content)
}
async function check(name, run) {
  await run()
  checks.push({ name, status: "passed" })
}
try {
  await page.setContent(
    '<!doctype html><html><body><h1>FOR-132 comment input</h1><div id="editor"></div></body></html>'
  )
  await page.addScriptTag({ path: bundle })
  const textbox = page.getByRole("textbox", { name: "Comment" })
  await textbox.click()

  await check("AT-01 opt-in default and live setting", async () => {
    await page.keyboard.type(":) ")
    assert.equal(await text(), ":) ")
    await page.evaluate(() => window.emoticonsFixture.enable(true))
    await page.keyboard.type(";-) ")
    assert.equal(await text(), ":) 😉 ")
    await page.evaluate(() => window.emoticonsFixture.enable(false))
    await page.keyboard.type(":D ")
    assert.equal(await text(), ":) 😉 :D ")
    await page.evaluate(() => window.emoticonsFixture.enable(true))
  })

  await check(
    "AT-01 every documented token, caret, native keyboard undo and redo",
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
        await reset()
        await page.keyboard.type(token)
        assert.equal(await text(), token)
        await page.keyboard.press("Space")
        assert.equal(await text(), `${emoji} `)
        await page.keyboard.press("ControlOrMeta+z")
        assert.equal(await text(), `${token} `)
        await page.keyboard.press("ControlOrMeta+Shift+z")
        assert.equal(await text(), `${emoji} `)
        await page.keyboard.type("next")
        assert.equal(await text(), `${emoji} next`)
      }
    }
  )

  await check("AT-02 code, links and URLs", async () => {
    for (const command of ["setCode", "setCodeBlock", "setLink"]) {
      await reset()
      await page.evaluate(
        (name) =>
          window.emoticonsFixture.editor.commands[name]({
            href: "https://example.test",
          }),
        command
      )
      await page.keyboard.type(":-) ")
      assert.equal(await text(), ":-) ")
    }
    for (const url of ["https://example.test/:)", "www.example.test/:)"]) {
      await reset()
      await page.keyboard.type(`${url} `)
      assert.equal(await text(), `${url} `)
    }
  })

  await check(
    "AT-02 structured HTML and plain paste remain literal after Space",
    async () => {
      for (const [mime, value] of [
        ["text/html", "<p><strong>:)</strong> <code>:D</code></p>"],
        ["text/plain", ":-)"],
      ]) {
        await reset()
        await textbox.evaluate(
          (element, { mime, value }) => {
            const clipboardData = new DataTransfer()
            clipboardData.setData(mime, value)
            element.dispatchEvent(
              new ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                clipboardData,
              })
            )
          },
          { mime, value }
        )
        const original = await text()
        await page.keyboard.press("Space")
        assert.equal(await text(), `${original} `)
        assert.ok(!/[🙂😃]/u.test(await text()))
        if (mime === "text/html") {
          assert.equal(await textbox.locator("strong").innerText(), ":)")
          assert.ok(
            (await textbox.locator("code").innerText()).startsWith(":D")
          )
        }
      }
    }
  )

  await check(
    "AT-02 selection replacement preserves literal input",
    async () => {
      await reset("<p>keep this</p>")
      await page.evaluate(() =>
        window.emoticonsFixture.editor.commands.setTextSelection({
          from: 1,
          to: 5,
        })
      )
      await page.keyboard.type(":) ")
      assert.equal(await text(), ":)  this")
    }
  )

  await check(
    "AT-02 synthetic composition lifecycle stays literal",
    async () => {
      await reset()
      await textbox.dispatchEvent("compositionstart", { data: "" })
      await page.keyboard.insertText(":) ")
      await textbox.dispatchEvent("compositionend", { data: ":) " })
      await page.waitForTimeout(50)
      assert.equal(await text(), ":) ")
      await page.keyboard.type(";-) ")
      assert.equal(await text(), ":) 😉 ")
    }
  )
  assert.deepEqual(errors, [])
  const output = process.env.FORGE_EMOTICON_EVIDENCE_FILE
  const evidence = {
    issue: "FOR-132",
    testedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    workingTree: execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim()
      ? "modified"
      : "clean",
    environment: `local Chromium ${browser.version()}; shared editor fixture`,
    limitations:
      "Composition events are synthetic; native OS IME and packaged macOS are not certified. Authenticated preference persistence remains covered by FOR-127; composer refresh is covered by component tests.",
    checks,
    errors,
  }
  if (output) {
    await mkdir(resolve(output, ".."), { recursive: true })
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`)
  }
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await browser.close()
}

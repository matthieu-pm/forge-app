// @vitest-environment node
import { createServer } from "node:http"
import { chromium, firefox } from "@playwright/test"
import { describe, expect, it, vi } from "vitest"
import { previewFileResponse } from "./file-response.server"

vi.mock("@tanstack/react-start/server-only", () => ({}))

describe.skipIf(process.env.FORGE_FILE_BROWSER_TESTS !== "1")(
  "FOR-36 real-browser preview isolation",
  () => {
    it.each([chromium, firefox])(
      "blocks active HTML/SVG in $name, including direct navigation without an iframe",
      async (engine) => {
        const attempts: Array<string> = []
        const malicious = `<h1>Safe visible content</h1><script>parent.__compromised=1;fetch('/leak?secret='+document.cookie)</script><img src="/leak?image" onerror="parent.__compromised=2"><meta http-equiv="refresh" content="0;url=/leak?refresh"><a href="/leak?link" target="_top">navigate</a><form action="/leak?form" target="_top"><input name="secret" value="sensitive"><button>submit</button></form><iframe src="/leak?frame"></iframe><svg onload="parent.__compromised=3"><foreignObject><iframe srcdoc="<script>parent.__compromised=4</script>"></iframe></foreignObject></svg>`
        const server = createServer(async (req, res) => {
          attempts.push(req.url!)
          if (req.url === "/") {
            res.setHeader("content-type", "text/html")
            res.setHeader("set-cookie", "private=sentinel; SameSite=Strict")
            res.end(
              `<script>window.__compromised=0</script><h1>Forge fixture</h1><iframe sandbox="" src="/preview" title="Preview"></iframe>`
            )
          } else if (req.url === "/preview" || req.url === "/svg") {
            const response = previewFileResponse(
              {
                name: req.url === "/svg" ? "attack.svg" : "attack.html",
                contentType: req.url === "/svg" ? "image/svg+xml" : "text/html",
              },
              new TextEncoder().encode(
                req.url === "/svg"
                  ? `<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('/leak?svg')"><script>alert(1)</script><image href="/leak?svg-image"/><rect width="50" height="50" fill="red"/></svg>`
                  : malicious
              )
            )
            response.headers.forEach((v, k) => res.setHeader(k, v))
            res.end(await response.text())
          } else {
            res.statusCode = 404
            res.end()
          }
        })
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve)
        )
        const address = server.address() as { port: number }
        const origin = `http://127.0.0.1:${address.port}`
        const browser = await engine.launch({ headless: true })
        try {
          const page = await browser.newPage()
          const dialogs: Array<string> = []
          page.on("dialog", async (dialog) => {
            dialogs.push(dialog.message())
            await dialog.dismiss()
          })
          await page.goto(origin)
          await page
            .frameLocator("iframe")
            .getByText("Safe visible content")
            .waitFor()
          expect(
            await page.evaluate(
              () =>
                (window as unknown as { __compromised: number }).__compromised
            )
          ).toBe(0)
          const frame = page.frames().find((f) => f.url().endsWith("/preview"))!
          expect(
            await frame.evaluate(() => {
              try {
                void parent.document
                return false
              } catch {
                return true
              }
            })
          ).toBe(true)
          expect(
            await frame
              .locator("a,form,input,script,iframe,meta[http-equiv]")
              .count()
          ).toBe(0)
          await page.goto(`${origin}/preview`)
          expect(
            await page.evaluate(() => {
              try {
                void document.cookie
                return false
              } catch {
                return true
              }
            })
          ).toBe(true)
          await page.goto(`${origin}/svg`)
          await page.locator("img").waitFor()
          expect(
            await page
              .locator("img")
              .evaluate(
                (img: HTMLImageElement) => img.complete && img.naturalWidth > 0
              )
          ).toBe(true)
          expect(attempts.filter((path) => path.startsWith("/leak"))).toEqual(
            []
          )
          expect(dialogs).toEqual([])
        } finally {
          await browser.close()
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
        }
      },
      30_000
    )
  }
)

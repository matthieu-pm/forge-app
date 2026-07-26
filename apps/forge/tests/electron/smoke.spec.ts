import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"

test("runs the shared Forge renderer in the hardened desktop shell", async () => {
  const electronApp = await electron.launch({
    args: [
      ".",
      `--user-data-dir=${join(tmpdir(), `forge-playwright-${process.pid}`)}`,
    ],
    env: {
      ...process.env,
      FORGE_DESKTOP_DEV_ORIGIN: "http://localhost:3000",
    },
  })

  try {
    const window = await electronApp.firstWindow()
    await window.waitForURL("http://localhost:3000/login**")

    await electronApp.evaluate(({ shell }) => {
      shell.openExternal = (url) => {
        Reflect.set(globalThis, "__forgeLastExternalUrl", url)
        return Promise.resolve()
      }
    })

    await expect(window).toHaveTitle("Forge")
    await expect(
      window.getByRole("heading", { name: "Sign in to Forge" })
    ).toBeVisible()
    await expect(window.getByTestId("desktop-titlebar")).toHaveCount(0)
    await expect(window.getByRole("tab")).toHaveCount(0)
    await expect(
      window.getByRole("button", { name: "Continue in browser" })
    ).toBeVisible()
    await expect(window.getByLabel("Email")).toHaveCount(0)
    await expect(window.getByLabel("Password")).toHaveCount(0)

    await window.getByRole("button", { name: "Continue in browser" }).click()
    const browserAuthUrl = await electronApp.evaluate(() =>
      Reflect.get(globalThis, "__forgeLastExternalUrl")
    )
    const parsedBrowserAuthUrl = new URL(String(browserAuthUrl))
    expect(parsedBrowserAuthUrl.pathname).toBe("/auth/desktop")
    expect(parsedBrowserAuthUrl.searchParams.get("client_id")).toBe("electron")
    expect(parsedBrowserAuthUrl.searchParams.get("callback_protocol")).toBe(
      "com.forge.desktop.dev"
    )
    expect(parsedBrowserAuthUrl.searchParams.get("state")).toBeTruthy()
    expect(parsedBrowserAuthUrl.searchParams.get("code_challenge")).toBeTruthy()
    expect(parsedBrowserAuthUrl.searchParams.get("code_challenge_method")).toBe(
      "S256"
    )
    await window.getByRole("button", { name: "Use a connection code" }).click()
    await expect(window.getByLabel("Connection code")).toBeVisible()

    const runtime = await window.evaluate(() =>
      globalThis.window.forgeDesktop?.getRuntime()
    )
    expect(runtime).toMatchObject({
      platform: "macos",
      capabilities: [
        "browser-auth",
        "deep-links",
        "dock-badge",
        "multi-window",
        "local-agent-runtimes",
        "native-notifications",
        "updates",
      ],
    })

    const rendererGlobals = await window.evaluate(() => ({
      nodeRequire: typeof Reflect.get(globalThis, "require"),
      forgeBridge: typeof globalThis.window.forgeDesktop?.getRuntime,
    }))
    expect(rendererGlobals).toEqual({
      nodeRequire: "undefined",
      forgeBridge: "function",
    })

    const secondWindowPromise = electronApp.waitForEvent("window")
    await window.evaluate(() =>
      globalThis.window.forgeDesktop?.openWindow("/login")
    )
    const secondWindow = await secondWindowPromise
    await secondWindow.waitForURL("http://localhost:3000/login**")
    await expect(secondWindow).toHaveTitle("Forge")
  } finally {
    await electronApp.close()
  }
})

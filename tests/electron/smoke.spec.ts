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

    await expect(window).toHaveTitle("Forge")
    await expect(
      window.getByRole("heading", { name: "Sign in to Forge" })
    ).toBeVisible()
    await expect(window.getByTestId("desktop-titlebar")).toBeVisible()
    await expect(window.getByRole("tab")).toHaveCount(1)

    await window.getByRole("button", { name: "New tab" }).click()
    await expect(window.getByRole("tab")).toHaveCount(2)
    await window
      .getByRole("button", { name: /Close .* tab/ })
      .last()
      .click()
    await expect(window.getByRole("tab")).toHaveCount(1)

    const runtime = await window.evaluate(() =>
      globalThis.window.forgeDesktop?.getRuntime()
    )
    expect(runtime).toMatchObject({
      platform: "macos",
      capabilities: [
        "deep-links",
        "dock-badge",
        "multi-window",
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

import { describe, expect, it } from "vitest"

import { createWindowOptions, restoreVisibleBounds } from "./window-config"

describe("createWindowOptions", () => {
  it("isolates and sandboxes the shared Forge renderer", () => {
    const options = createWindowOptions(
      "/app/preload.js",
      {
        width: 1280,
        height: 800,
        x: 10,
        y: 20,
      },
      false,
      "darwin"
    )

    expect(options.webPreferences).toMatchObject({
      preload: "/app/preload.js",
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
    })
    expect(options).toMatchObject({
      backgroundColor: "#00000000",
      transparent: true,
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
      titleBarStyle: "hidden",
      width: 1280,
      height: 800,
      x: 10,
      y: 20,
      minWidth: 720,
      minHeight: 520,
      show: false,
    })
  })

  it("allows developer tools only in development builds", () => {
    const options = createWindowOptions("/app/preload.js", undefined, true)

    expect(options.webPreferences?.devTools).toBe(true)
  })

  it("keeps non-macOS windows opaque", () => {
    const options = createWindowOptions(
      "/app/preload.js",
      undefined,
      false,
      "linux"
    )

    expect(options.backgroundColor).toBe("#ffffff")
    expect(options.transparent).toBeUndefined()
    expect(options.vibrancy).toBeUndefined()
  })
})

describe("restoreVisibleBounds", () => {
  const display = { x: 0, y: 0, width: 1512, height: 982 }

  it("restores a saved window that still intersects a display", () => {
    const bounds = { x: 100, y: 80, width: 1280, height: 800 }
    expect(restoreVisibleBounds(bounds, [display])).toEqual(bounds)
  })

  it("drops invalid or off-screen bounds", () => {
    expect(
      restoreVisibleBounds({ x: 4000, y: 2000, width: 1280, height: 800 }, [
        display,
      ])
    ).toBeUndefined()
    expect(
      restoreVisibleBounds({ x: 0, y: 0, width: -1, height: 800 }, [display])
    ).toBeUndefined()
  })
})

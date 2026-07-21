import { describe, expect, it } from "vitest"

import { resolveHostPlatform } from "./host-platform"

describe("resolveHostPlatform", () => {
  it("keeps macOS chrome enabled when the desktop bridge falls back to web", () => {
    expect(
      resolveHostPlatform(
        "web",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/43.2.0"
      )
    ).toBe("macos")
  })

  it("keeps the real desktop runtime when the bridge is available", () => {
    expect(resolveHostPlatform("windows", "Electron/43.2.0")).toBe("windows")
  })

  it("leaves ordinary browsers on the web host", () => {
    expect(resolveHostPlatform("web", "Mozilla/5.0 Chrome/140.0.0.0")).toBe(
      "web"
    )
  })
})

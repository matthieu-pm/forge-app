import { describe, expect, it } from "vitest"

import { configureAppAppearance, hostWindowBackground } from "./appearance"

describe("configureAppAppearance", () => {
  it("follows the operating system before renderer preferences load", () => {
    const theme = { themeSource: "light" }

    configureAppAppearance(theme)

    expect(theme.themeSource).toBe("system")
  })

  it("keeps transparent native chrome aligned with the selected theme", () => {
    const theme = { themeSource: "light" }

    configureAppAppearance(theme, "dark")

    expect(theme.themeSource).toBe("dark")
  })

  it("keeps explicit light and dark window chrome independent of the OS", () => {
    expect(hostWindowBackground("light", true, "linux")).toBe("#ffffff")
    expect(hostWindowBackground("dark", false, "win32")).toBe("#111111")
    expect(hostWindowBackground("system", true, "linux")).toBe("#111111")
    expect(hostWindowBackground("system", false, "linux")).toBe("#ffffff")
    expect(hostWindowBackground("dark", true, "darwin")).toBeNull()
  })
})

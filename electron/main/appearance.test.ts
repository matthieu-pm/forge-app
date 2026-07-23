import { describe, expect, it } from "vitest"

import { configureAppAppearance } from "./appearance"

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
})

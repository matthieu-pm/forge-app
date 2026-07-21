import { describe, expect, it } from "vitest"

import { configureAppAppearance } from "./appearance"

describe("configureAppAppearance", () => {
  it("keeps the native title bar aligned with Forge's light app theme", () => {
    const theme = { themeSource: "system" }

    configureAppAppearance(theme)

    expect(theme.themeSource).toBe("light")
  })
})

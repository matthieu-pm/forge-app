import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { TabIcon } from "./desktop-title-bar"

describe("TabIcon", () => {
  it("renders the settings icon for the Preferences tab", () => {
    const { container } = render(<TabIcon path="/settings" />)

    const icon = container.querySelector(".forge-desktop-tab-icon")
    expect(icon).not.toBeNull()
    if (!icon) return
    expect(icon.tagName.toLowerCase()).toBe("svg")
    expect(icon.classList.contains("forge-desktop-tab-icon")).toBe(true)
  })
})

import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  TabIcon,
  getTabTeamSlug,
  isDesktopTitleBarHidden,
} from "./desktop-title-bar"

describe("TabIcon", () => {
  it("renders the settings icon for the Preferences tab", () => {
    const { container } = render(<TabIcon path="/settings" />)

    const icon = container.querySelector(".forge-desktop-tab-icon")
    expect(icon).not.toBeNull()
    if (!icon) return
    expect(icon.tagName.toLowerCase()).toBe("svg")
    expect(icon.classList.contains("forge-desktop-tab-icon")).toBe(true)
  })

  it("renders the profile settings icon for the Profile tab", () => {
    const { container } = render(<TabIcon path="/settings/profile" />)

    expect(container.querySelector(".forge-desktop-tab-icon")).not.toBeNull()
  })

  it("renders the security settings icon for the Security tab", () => {
    const { container } = render(<TabIcon path="/settings/security" />)

    expect(container.querySelector(".forge-desktop-tab-icon")).not.toBeNull()
  })

  it("renders a team's configured emoji for a team tab", () => {
    const { container } = render(
      <TabIcon
        path="/teams/product/issues"
        team={{
          name: "Product",
          icon: { kind: "emoji", value: "🍎", color: "#fb7185" },
        }}
      />
    )

    const icon = container.querySelector(".forge-desktop-tab-icon")
    expect(icon).not.toBeNull()
    expect(icon?.textContent).toBe("🍎")
  })
})

describe("isDesktopTitleBarHidden", () => {
  it.each(["/login", "/signup", "/onboarding/workspace"])(
    "hides the desktop chrome on %s",
    (path) => {
      expect(isDesktopTitleBarHidden(path)).toBe(true)
    }
  )

  it("keeps the desktop chrome on authenticated routes", () => {
    expect(isDesktopTitleBarHidden("/forge")).toBe(false)
  })
})

describe("getTabTeamSlug", () => {
  it.each([
    ["/teams/product/issues", "product"],
    ["/settings/teams/platform-api", "platform-api"],
    ["/settings/teams/platform-api/general", "platform-api"],
    ["/settings/teams/platform-api/members?filter=active", "platform-api"],
  ])("resolves the team for %s", (path, teamSlug) => {
    expect(getTabTeamSlug(path)).toBe(teamSlug)
  })

  it("does not treat the create-team page as a team", () => {
    expect(getTabTeamSlug("/settings/teams/new")).toBeUndefined()
  })
})

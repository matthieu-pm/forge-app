import { describe, expect, it } from "vitest"

import { getSidebarDisclosureKey } from "./sidebar-disclosure"

describe("getSidebarDisclosureKey", () => {
  it("stays stable when navigation changes a section's active state", () => {
    expect(getSidebarDisclosureKey("Workspace", true)).toBe(
      getSidebarDisclosureKey("Workspace", false)
    )
    expect(getSidebarDisclosureKey("Your teams", true)).toBe(
      getSidebarDisclosureKey("Your teams", false)
    )
    expect(getSidebarDisclosureKey("Product", true)).toBe(
      getSidebarDisclosureKey("Product", false)
    )
  })
})

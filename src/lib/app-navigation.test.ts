import { describe, expect, it } from "vitest"

import { getBreadcrumbItems } from "./app-navigation"

describe("getBreadcrumbItems", () => {
  it("labels the settings landing page as preferences", () => {
    expect(getBreadcrumbItems("/settings")).toEqual([
      { label: "Preferences" },
    ])
  })

  it("labels the create-team settings page", () => {
    expect(getBreadcrumbItems("/settings/teams/new")).toEqual([
      { label: "Create a new team" },
    ])
  })

  it("omits the workspace wrapper from workspace pages", () => {
    expect(getBreadcrumbItems("/workspace/initiatives")).toEqual([
      { label: "Initiatives" },
    ])
  })

  it("omits the teams wrapper from team pages", () => {
    expect(getBreadcrumbItems("/teams/product/insights")).toEqual([
      { label: "Product", to: "/teams/product/projects" },
      { label: "Insights" },
    ])
  })

  it("keeps the collection link on initiative detail pages", () => {
    expect(getBreadcrumbItems("/workspace/initiatives/initiative-1")).toEqual([
      { label: "Initiatives", to: "/workspace/initiatives" },
      { label: "Initiative" },
    ])
  })
})

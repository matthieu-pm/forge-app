import { describe, expect, it } from "vitest"

import { buildYourTeamsNav, getBreadcrumbItems } from "./app-navigation"

describe("getBreadcrumbItems", () => {
  it("labels the settings landing page as preferences", () => {
    expect(getBreadcrumbItems("/settings")).toEqual([{ label: "Preferences" }])
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

  it("supports teams loaded from the active workspace", () => {
    expect(
      buildYourTeamsNav([{ name: "Platform API", slug: "platform-api" }])
    ).toMatchObject([
      {
        title: "Platform API",
        to: "/teams/platform-api/projects",
        items: [
          { title: "Issues", to: "/teams/platform-api/issues" },
          { title: "Projects", to: "/teams/platform-api/projects" },
          { title: "Views", to: "/teams/platform-api/views" },
        ],
      },
    ])
  })

  it("creates breadcrumbs for dynamic team slugs", () => {
    expect(getBreadcrumbItems("/teams/platform-api/issues")).toEqual([
      { label: "Platform Api", to: "/teams/platform-api/projects" },
      { label: "Issues" },
    ])
  })

  it("keeps the collection link on initiative detail pages", () => {
    expect(getBreadcrumbItems("/workspace/initiatives/initiative-1")).toEqual([
      { label: "Initiatives", to: "/workspace/initiatives" },
      { label: "Initiative" },
    ])
  })
})

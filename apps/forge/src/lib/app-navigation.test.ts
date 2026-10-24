import { describe, expect, it } from "vitest"

import {
  buildYourTeamsNav,
  getBreadcrumbItems,
  isNavItemActive,
} from "./app-navigation"

describe("getBreadcrumbItems", () => {
  it("places enabled cycles between issues and projects for that team only", () => {
    const nav = buildYourTeamsNav([
      { name: "Product", slug: "product", cyclesEnabled: true },
      { name: "Design", slug: "design", cyclesEnabled: false },
    ])
    expect(nav[0].items?.map((item) => item.title)).toEqual([
      "Home",
      "Issues",
      "Cycles",
      "Projects",
      "Views",
      "Calls",
    ])
    expect(nav[1].items?.map((item) => item.title)).toEqual([
      "Home",
      "Issues",
      "Projects",
      "Views",
      "Calls",
    ])
    expect(
      nav[0].items?.find((item) => item.title === "Cycles")?.items
    ).toEqual([{ title: "Upcoming", to: "/teams/product/cycle/upcoming" }])
    expect(getBreadcrumbItems("/teams/product/cycle/upcoming")).toEqual([
      { label: "Product", to: "/teams/product/projects" },
      { label: "Cycles", to: "/teams/product/cycles" },
      { label: "Cycle 1" },
    ])
    expect(getBreadcrumbItems("/teams/product/cycles")).toEqual([
      { label: "Product", to: "/teams/product/projects" },
      { label: "Cycles" },
    ])
  })
  it("labels the settings landing page as preferences", () => {
    expect(getBreadcrumbItems("/settings")).toEqual([{ label: "Preferences" }])
  })

  it("labels code review settings", () => {
    expect(getBreadcrumbItems("/settings/code-and-reviews")).toEqual([
      { label: "Code & reviews" },
    ])
  })

  it("labels profile settings", () => {
    expect(getBreadcrumbItems("/settings/profile")).toEqual([
      { label: "Profile" },
    ])
  })

  it("labels public API settings", () => {
    expect(getBreadcrumbItems("/settings/api")).toEqual([{ label: "API" }])
  })

  it("labels AI settings", () => {
    expect(getBreadcrumbItems("/settings/ai")).toEqual([
      { label: "AI & Agents" },
    ])
  })

  it("labels security settings", () => {
    expect(getBreadcrumbItems("/settings/security")).toEqual([
      { label: "Security" },
    ])
  })

  it("labels workspace settings", () => {
    expect(getBreadcrumbItems("/settings/workspace")).toEqual([
      { label: "Workspace" },
    ])
  })

  it("labels billing settings", () => {
    expect(getBreadcrumbItems("/settings/billing")).toEqual([
      { label: "Billing" },
    ])
  })

  it("labels application settings", () => {
    expect(getBreadcrumbItems("/settings/applications")).toEqual([
      { label: "Applications" },
    ])
  })

  it("labels teams settings", () => {
    expect(getBreadcrumbItems("/settings/teams")).toEqual([{ label: "Teams" }])
  })

  it("labels the create-team settings page", () => {
    expect(getBreadcrumbItems("/settings/teams/new")).toEqual([
      { label: "Create a new team" },
    ])
  })

  it("labels a team settings overview", () => {
    expect(getBreadcrumbItems("/settings/teams/platform-api")).toEqual([
      { label: "Overview" },
    ])
  })

  it("labels team general settings", () => {
    expect(getBreadcrumbItems("/settings/teams/platform-api/general")).toEqual([
      { label: "General" },
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
        to: "/teams/platform-api/overview",
        items: [
          { title: "Home", to: "/teams/platform-api/overview" },
          { title: "Issues", to: "/teams/platform-api/issues" },
          { title: "Projects", to: "/teams/platform-api/projects" },
          { title: "Views", to: "/teams/platform-api/views" },
          { title: "Calls", to: "/teams/platform-api/calls" },
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

it("keeps Home selected across its tabs only for the same team", () => {
  const nav = buildYourTeamsNav([{ name: "Product", slug: "product" }])[0]
  const home = nav.items![0]
  for (const tab of ["overview", "documents", "loops", "members"]) {
    expect(isNavItemActive(`/teams/product/${tab}`, home)).toBe(true)
    expect(isNavItemActive(`/teams/product/${tab}`, nav)).toBe(true)
    expect(isNavItemActive(`/teams/other/${tab}`, home)).toBe(false)
  }
  expect(isNavItemActive("/teams/product/issues", home)).toBe(false)
})

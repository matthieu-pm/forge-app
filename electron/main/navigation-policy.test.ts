import { describe, expect, it } from "vitest"

import { classifyNavigation, routeFromDeepLink } from "./navigation-policy"

const appOrigin = "https://app.forge.com"

describe("classifyNavigation", () => {
  it("keeps only the exact Forge origin inside the application", () => {
    expect(
      classifyNavigation("https://app.forge.com/workspace/projects", appOrigin)
    ).toEqual({ action: "allow" })

    expect(
      classifyNavigation("https://app.forge.com.evil.test/steal", appOrigin)
    ).toEqual({
      action: "open-external",
      url: "https://app.forge.com.evil.test/steal",
    })
  })

  it("opens safe public links outside and rejects executable schemes", () => {
    expect(classifyNavigation("https://linear.app", appOrigin)).toEqual({
      action: "open-external",
      url: "https://linear.app/",
    })
    expect(classifyNavigation("mailto:hello@forge.com", appOrigin)).toEqual({
      action: "open-external",
      url: "mailto:hello@forge.com",
    })
    expect(classifyNavigation("javascript:alert(1)", appOrigin)).toEqual({
      action: "deny",
    })
    expect(classifyNavigation("file:///etc/passwd", appOrigin)).toEqual({
      action: "deny",
    })
  })
})

describe("routeFromDeepLink", () => {
  it("maps Forge deep links onto canonical application routes", () => {
    expect(routeFromDeepLink("forge://inbox")).toBe("/inbox")
    expect(
      routeFromDeepLink("forge://workspace/projects?view=active#top")
    ).toBe("/workspace/projects?view=active#top")
  })

  it("rejects malformed, unknown, and traversal links", () => {
    expect(routeFromDeepLink("https://app.forge.com/inbox")).toBeNull()
    expect(routeFromDeepLink("forge://unknown/path")).toBeNull()
    expect(routeFromDeepLink("forge://workspace/%2e%2e/login")).toBeNull()
  })
})

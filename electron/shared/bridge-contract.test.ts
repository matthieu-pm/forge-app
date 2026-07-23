import { describe, expect, it } from "vitest"

import {
  beginAuthSchema,
  completeAuthSchema,
  externalUrlSchema,
  notificationSchema,
  routePathSchema,
  themeSourceSchema,
  unreadCountSchema,
} from "./bridge-contract"

describe("desktop bridge input validation", () => {
  it("accepts bounded unread counts", () => {
    expect(unreadCountSchema.parse(0)).toBe(0)
    expect(unreadCountSchema.parse(42)).toBe(42)
    expect(unreadCountSchema.safeParse(-1).success).toBe(false)
    expect(unreadCountSchema.safeParse(1.5).success).toBe(false)
    expect(unreadCountSchema.safeParse(10_000).success).toBe(false)
  })

  it("accepts only supported native theme sources", () => {
    expect(themeSourceSchema.parse("system")).toBe("system")
    expect(themeSourceSchema.parse("light")).toBe("light")
    expect(themeSourceSchema.parse("dark")).toBe("dark")
    expect(themeSourceSchema.safeParse("midnight").success).toBe(false)
  })

  it("accepts safe external URLs and rejects executable protocols", () => {
    expect(externalUrlSchema.parse("https://linear.app")).toBe(
      "https://linear.app"
    )
    expect(externalUrlSchema.parse("mailto:hello@forge.com")).toBe(
      "mailto:hello@forge.com"
    )
    expect(externalUrlSchema.safeParse("javascript:alert(1)").success).toBe(
      false
    )
    expect(externalUrlSchema.safeParse("file:///etc/passwd").success).toBe(
      false
    )
  })

  it("accepts canonical Forge paths and rejects traversal or external paths", () => {
    expect(routePathSchema.parse("/workspace/projects?view=active")).toBe(
      "/workspace/projects?view=active"
    )
    expect(routePathSchema.parse("/settings")).toBe("/settings")
    expect(routePathSchema.safeParse("https://evil.test").success).toBe(false)
    expect(routePathSchema.safeParse("//evil.test/path").success).toBe(false)
    expect(routePathSchema.safeParse("/workspace/../login").success).toBe(false)
    expect(routePathSchema.safeParse("/unknown").success).toBe(false)
  })

  it("accepts only safe desktop authentication return routes", () => {
    expect(beginAuthSchema.parse({ returnTo: "/inbox?view=assigned" })).toEqual(
      {
        returnTo: "/inbox?view=assigned",
      }
    )
    expect(beginAuthSchema.parse({})).toEqual({})
    expect(
      beginAuthSchema.safeParse({ returnTo: "https://evil.test" }).success
    ).toBe(false)
    expect(
      beginAuthSchema.safeParse({ returnTo: "/workspace/../login" }).success
    ).toBe(false)
  })

  it("accepts bounded manual authentication codes", () => {
    expect(completeAuthSchema.parse({ token: "connection-code" })).toEqual({
      token: "connection-code",
    })
    expect(completeAuthSchema.safeParse({ token: "" }).success).toBe(false)
    expect(
      completeAuthSchema.safeParse({ token: "x".repeat(2049) }).success
    ).toBe(false)
  })

  it("requires bounded notification content and an optional safe route", () => {
    expect(
      notificationSchema.parse({
        id: "notification-1",
        title: "Assigned to you",
        body: "FOR-123 needs your attention",
        path: "/inbox",
      })
    ).toEqual({
      id: "notification-1",
      title: "Assigned to you",
      body: "FOR-123 needs your attention",
      path: "/inbox",
    })
    expect(
      notificationSchema.safeParse({
        id: "notification-1",
        title: "Assigned to you",
        body: "FOR-123 needs your attention",
        path: "https://evil.test",
      }).success
    ).toBe(false)
  })
})

import { act } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import {
  customViewSchema,
  customViewsKey,
  newCustomView,
  parseCustomViews,
  visibleCustomViews,
} from "./custom-views"
import { useCustomViewDirectoryPreferences } from "./custom-views-state"
import { productStorage } from "@/lib/product-storage"
import {
  renderPreferenceHook as renderHook,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

beforeEach(async () => {
  productStorage.clear()
  await setupPreferenceFixture("user")
})

describe("Custom view definitions", () => {
  it("keeps issue and project filters and display settings in their own validated branches", () => {
    const issues = newCustomView("issues", "user")
    const projects = newCustomView("projects", "user")
    expect(customViewSchema.parse(issues)).toEqual(issues)
    expect(customViewSchema.parse(projects)).toEqual(projects)
    expect(
      customViewSchema.safeParse({ ...issues, filters: projects.filters })
        .success
    ).toBe(false)
    expect(
      customViewSchema.safeParse({ ...projects, display: issues.display })
        .success
    ).toBe(false)
    expect(customViewSchema.safeParse({ ...issues, name: "   " }).success).toBe(
      false
    )
    expect(
      customViewSchema.safeParse({ ...issues, visibility: "team" }).success
    ).toBe(false)
    expect(issues.name).toBe("All issues")
    expect(projects.name).toBe("All projects")
    expect(issues.filters.rules).toEqual([])
  })

  it("retains a team scope for personal views and separates directory types", () => {
    const personal = newCustomView("issues", "user", "team-a")
    const other = newCustomView("issues", "user", "team-b")
    const project = newCustomView("projects", "user", "team-a")
    const all = newCustomView("issues", "user")
    expect(personal.visibility).toBe("personal")
    const views = [personal, other, project, all]
    expect(visibleCustomViews(views, "issues", "team-a")).toEqual([personal])
    expect(visibleCustomViews(views, "projects", "team-a")).toEqual([project])
    expect(visibleCustomViews(views, "issues")).toEqual([personal, other, all])
    expect(customViewsKey("workspace", "user")).not.toBe(
      customViewsKey("workspace", "other")
    )
    expect(customViewsKey("workspace", "user")).not.toBe(
      customViewsKey("other", "user")
    )
  })

  it("rejects malformed or unsupported records instead of dropping saved entries", () => {
    expect(parseCustomViews(null)).toEqual({ version: 1, views: [] })
    const view = newCustomView("issues", "user")
    for (const raw of [
      "",
      "{invalid",
      JSON.stringify({ version: 2, views: [] }),
      JSON.stringify({ version: 1, views: [view, view] }),
    ]) {
      expect(() => parseCustomViews(raw)).toThrow()
    }
  })
})

describe("Custom view directory preferences", () => {
  it("persists ordering and columns across remounts without changing saved view definitions or another user's settings", () => {
    const view = newCustomView("issues", "user")
    const key = customViewsKey("workspace", "user")
    productStorage.setItem(key, JSON.stringify({ version: 1, views: [view] }))
    const hook = renderHook(() =>
      useCustomViewDirectoryPreferences("workspace", "user")
    )
    act(() => {
      expect(
        hook.result.current.save({
          ordering: "Updated",
          descending: true,
          properties: ["Created", "Updated"],
        })
      ).toBe(true)
    })
    hook.unmount()
    const reloaded = renderHook(() =>
      useCustomViewDirectoryPreferences("workspace", "user")
    )
    expect(reloaded.result.current).toMatchObject({
      ordering: "Updated",
      descending: true,
      properties: ["Created", "Updated"],
      error: "",
    })
    expect(parseCustomViews(productStorage.getItem(key)).views).toEqual([view])
    const other = renderHook(() =>
      useCustomViewDirectoryPreferences("workspace", "other")
    )
    expect(other.result.current).toMatchObject({
      ordering: "Name",
      descending: false,
      properties: ["Owner"],
    })
  })

  it("preserves malformed legacy settings while saving new account choices", () => {
    const key = `${customViewsKey("workspace", "user")}:directory`
    const { result } = renderHook(() =>
      useCustomViewDirectoryPreferences("workspace", "user")
    )
    productStorage.setItem(key, "{broken")
    expect(
      result.current.save({
        ordering: "Created",
        descending: false,
        properties: ["Owner"],
      })
    ).toBe(true)
    expect(productStorage.getItem(key)).toBe("{broken")
    act(() => window.dispatchEvent(new Event("storage")))
    expect(result.current.error).toBe("")
    expect(result.current.properties).toEqual(["Owner"])
    expect(productStorage.getItem(key)).toBe("{broken")
  })
})

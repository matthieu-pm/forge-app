import { act } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  customViewSchema,
  customViewsKey,
  newCustomView,
  parseCustomViews,
  visibleCustomViews,
} from "./custom-views"
import {
  useCustomViewDirectoryPreferences,
  useCustomViews,
} from "./custom-views-state"
import {
  renderPreferenceHook as renderHook,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

beforeEach(async () => {
  localStorage.clear()
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

describe("Custom view persistence", () => {
  it("creates, edits and removes views while retaining the original creation time", () => {
    const { result } = renderHook(() => useCustomViews("workspace", "user"))
    const view = newCustomView("issues", "user")
    act(() => {
      expect(result.current.save(view)).toBe(true)
    })
    expect(result.current.views).toHaveLength(1)
    const createdAt = result.current.views[0].createdAt
    act(() => {
      expect(
        result.current.save({
          ...view,
          name: "High priority",
          favorite: true,
          createdAt: "2020-01-01T00:00:00.000Z",
        })
      ).toBe(true)
    })
    expect(result.current.views[0]).toMatchObject({
      name: "High priority",
      favorite: true,
      createdAt,
    })
    const { result: reloaded } = renderHook(() =>
      useCustomViews("workspace", "user")
    )
    expect(reloaded.current.views).toEqual(result.current.views)
    act(() => {
      expect(result.current.remove(view.id)).toBe(true)
    })
    expect(result.current.views).toEqual([])
    expect(reloaded.current.views).toEqual([])
  })

  it("reads the latest stored definitions before writing so stale renders do not remove other views", () => {
    const { result } = renderHook(() => useCustomViews("workspace", "user"))
    const first = newCustomView("issues", "user")
    const second = newCustomView("projects", "user")
    localStorage.setItem(
      customViewsKey("workspace", "user"),
      JSON.stringify({ version: 1, views: [first] })
    )
    act(() => {
      expect(result.current.save(second)).toBe(true)
    })
    expect(result.current.views.map((view) => view.id)).toEqual([
      first.id,
      second.id,
    ])
    const third = newCustomView("issues", "user")
    localStorage.setItem(
      customViewsKey("workspace", "user"),
      JSON.stringify({ version: 1, views: [...result.current.views, third] })
    )
    act(() => {
      expect(result.current.remove(first.id)).toBe(true)
    })
    expect(result.current.views.map((view) => view.id)).toEqual([
      second.id,
      third.id,
    ])
  })

  it("preserves corrupt data on save and delete and reports the loading failure", () => {
    const key = customViewsKey("workspace", "user")
    localStorage.setItem(key, "{broken")
    const { result } = renderHook(() => useCustomViews("workspace", "user"))
    expect(result.current.error).toContain("preserved")
    expect(result.current.save(newCustomView("issues", "user"))).toBe(false)
    expect(result.current.remove("anything")).toBe(false)
    expect(localStorage.getItem(key)).toBe("{broken")
  })

  it("rejects invalid edits without altering the valid store and handles failed storage writes", () => {
    const { result } = renderHook(() => useCustomViews("workspace", "user"))
    const view = newCustomView("issues", "user")
    act(() => {
      result.current.save(view)
    })
    const before = localStorage.getItem(customViewsKey("workspace", "user"))
    expect(result.current.save({ ...view, name: "" })).toBe(false)
    expect(localStorage.getItem(customViewsKey("workspace", "user"))).toBe(
      before
    )
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("Quota exceeded")
    })
    expect(result.current.remove(view.id)).toBe(false)
    expect(localStorage.getItem(customViewsKey("workspace", "user"))).toBe(
      before
    )
  })
})

describe("Custom view directory preferences", () => {
  it("persists ordering and columns across remounts without changing saved view definitions or another user's settings", () => {
    const view = newCustomView("issues", "user")
    const key = customViewsKey("workspace", "user")
    localStorage.setItem(key, JSON.stringify({ version: 1, views: [view] }))
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
    expect(parseCustomViews(localStorage.getItem(key)).views).toEqual([view])
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
    localStorage.setItem(key, "{broken")
    expect(
      result.current.save({
        ordering: "Created",
        descending: false,
        properties: ["Owner"],
      })
    ).toBe(true)
    expect(localStorage.getItem(key)).toBe("{broken")
    act(() => window.dispatchEvent(new Event("storage")))
    expect(result.current.error).toBe("")
    expect(result.current.properties).toEqual(["Owner"])
    expect(localStorage.getItem(key)).toBe("{broken")
  })
})

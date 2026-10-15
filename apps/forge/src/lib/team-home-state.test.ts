import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  emptyTeamHome,
  removeHomeSection,
  safeResourceUrl,
  teamHomeKey,
  useTeamHome,
} from "./team-home-state"

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
describe("team home content", () => {
  it("persists independently per team and synchronizes other mounted tabs", async () => {
    const first = renderHook(() => useTeamHome("alpha"))
    const second = renderHook(() => useTeamHome("alpha"))
    const other = renderHook(() => useTeamHome("beta"))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    act(() => {
      expect(
        first.result.current.update((s) => ({
          ...s,
          sections: [{ id: "links", name: "Links", collapsed: false }],
        }))
      ).toBe(true)
    })
    expect(second.result.current.state.sections[0].name).toBe("Links")
    expect(other.result.current.state.sections).toEqual([])
    first.unmount()
    const reloaded = renderHook(() => useTeamHome("alpha"))
    await waitFor(() =>
      expect(reloaded.result.current.state.sections[0].name).toBe("Links")
    )
  })
  it("preserves corrupted data and refuses edits", async () => {
    localStorage.setItem(teamHomeKey("alpha"), "broken")
    const hook = renderHook(() => useTeamHome("alpha"))
    await waitFor(() => expect(hook.result.current.error).toBeTruthy())
    expect(hook.result.current.update(() => emptyTeamHome())).toBe(false)
    expect(localStorage.getItem(teamHomeKey("alpha"))).toBe("broken")
  })
  it("does not report a save or alter state when storage is full", async () => {
    const hook = renderHook(() => useTeamHome("alpha"))
    await waitFor(() => expect(hook.result.current.ready).toBe(true))
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    act(() => {
      expect(
        hook.result.current.update((s) => ({ ...s, favorite: true }))
      ).toBe(false)
    })
    expect(hook.result.current.state.favorite).toBe(false)
  })
  it("keeps documents when removing their section", () => {
    const resource = {
      id: "doc",
      kind: "document" as const,
      title: "Plan",
      content: "Keep this",
      sectionId: "links",
      updatedAt: "2026-10-12",
    }
    const result = removeHomeSection(
      {
        ...emptyTeamHome(),
        sections: [{ id: "links", name: "Links", collapsed: false }],
        resources: [resource],
      },
      "links"
    )
    expect(result.sections).toEqual([])
    expect(result.resources).toEqual([{ ...resource, sectionId: null }])
  })
  it("only accepts navigable web resource URLs", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,test",
      "file:///etc/passwd",
      "/relative",
      "not a url",
    ])
      expect(safeResourceUrl(value)).toBeNull()
    expect(safeResourceUrl("https://example.com/path")).toBe(
      "https://example.com/path"
    )
  })
})

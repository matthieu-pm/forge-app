import { act, cleanup, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  emptyTeamHome,
  removeHomeSection,
  safeResourceUrl,
  teamHomeKey,
  useTeamHome,
} from "./team-home-state"
import { productStorage } from "@/lib/product-storage"
import {
  renderPreferenceHook as renderHook,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

beforeEach(async () => {
  productStorage.clear()
  await setupPreferenceFixture("user")
})
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
    productStorage.setItem(teamHomeKey("alpha"), "broken")
    const hook = renderHook(() => useTeamHome("alpha"))
    await waitFor(() => expect(hook.result.current.error).toBeTruthy())
    expect(hook.result.current.update(() => emptyTeamHome())).toBe(false)
    expect(productStorage.getItem(teamHomeKey("alpha"))).toBe("broken")
  })
  it("saves personal favorites independently of browser storage quota", async () => {
    const hook = renderHook(() => useTeamHome("alpha"))
    await waitFor(() => expect(hook.result.current.ready).toBe(true))
    vi.spyOn(productStorage, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    act(() => {
      expect(
        hook.result.current.update((s) => ({ ...s, favorite: true }))
      ).toBe(true)
    })
    expect(hook.result.current.state.favorite).toBe(true)
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

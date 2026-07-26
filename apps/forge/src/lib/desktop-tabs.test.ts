import { describe, expect, it } from "vitest"

import {
  closeDesktopTab,
  createDesktopTabs,
  getActiveDesktopTab,
  getDesktopTabPath,
  moveDesktopTabHistory,
  openDesktopTab,
  recordDesktopTabRoute,
} from "./desktop-tabs"

describe("desktop tabs", () => {
  it("keeps an independent navigation history for every tab", () => {
    let state = createDesktopTabs("/inbox")
    state = recordDesktopTabRoute(state, "/my-issues")
    state = openDesktopTab(state, "/forge")
    state = recordDesktopTabRoute(state, "/workspace/projects")

    expect(state.tabs).toHaveLength(2)
    expect(state.tabs[0].history).toEqual(["/inbox", "/my-issues"])
    expect(getActiveDesktopTab(state).history).toEqual([
      "/forge",
      "/workspace/projects",
    ])

    state = moveDesktopTabHistory(state, -1)
    expect(getDesktopTabPath(getActiveDesktopTab(state))).toBe("/forge")
  })

  it("activates the neighboring tab when the active tab closes", () => {
    let state = createDesktopTabs("/inbox")
    state = openDesktopTab(state, "/forge")
    const closingId = state.activeTabId
    state = closeDesktopTab(state, closingId)

    expect(state.tabs).toHaveLength(1)
    expect(getDesktopTabPath(getActiveDesktopTab(state))).toBe("/inbox")
    expect(closeDesktopTab(state, state.activeTabId)).toBe(state)
  })

  it("truncates forward history after navigating from a previous entry", () => {
    let state = createDesktopTabs("/inbox")
    state = recordDesktopTabRoute(state, "/my-issues")
    state = moveDesktopTabHistory(state, -1)
    state = recordDesktopTabRoute(state, "/forge")

    expect(getActiveDesktopTab(state).history).toEqual(["/inbox", "/forge"])
  })
})

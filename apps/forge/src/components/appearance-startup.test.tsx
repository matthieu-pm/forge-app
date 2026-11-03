import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { AppearanceStartup } from "./appearance-startup"
import { writeAppearanceCache } from "@/lib/appearance"

describe("AppearanceStartup", () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    document.documentElement.className = ""
    document.documentElement.style.fontSize = ""
    delete document.documentElement.dataset.forgeTheme
    delete document.documentElement.dataset.forgeAppearance
  })

  it("follows the OS for a cached system choice without resetting other interface settings", () => {
    let matches = true
    const listeners = new Set<() => void>()
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        get matches() {
          return matches
        },
        addEventListener: (_event: string, listener: () => void) => {
          listeners.add(listener)
        },
        removeEventListener: (_event: string, listener: () => void) => {
          listeners.delete(listener)
        },
      }),
    })
    document.documentElement.style.fontSize = "17px"
    writeAppearanceCache(localStorage, "alice", {
      interfaceTheme: "system",
      lightTheme: "paper",
      darkTheme: "forest",
    })

    render(<AppearanceStartup userId="alice" />)

    expect(document.documentElement.dataset.forgeAppearance).toBe("system")
    expect(document.documentElement.dataset.forgeTheme).toBe("forest")
    expect(document.documentElement.style.fontSize).toBe("17px")
    matches = false
    for (const listener of listeners) listener()
    expect(document.documentElement.dataset.forgeTheme).toBe("paper")
    expect(document.documentElement.style.fontSize).toBe("17px")
  })
})

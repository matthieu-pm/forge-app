import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  PREFERENCES_STORAGE_KEY,
  applyPersonalInterfacePreferences,
  defaultPersonalPreferences,
  loadPersonalPreferences,
} from "./personal-preferences"

describe("personal preferences", () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.classList.remove("dark")
    delete document.documentElement.dataset.forgeTheme
    delete document.documentElement.dataset.forgePointerCursors
    delete document.documentElement.dataset.forgeUnderlineLinks
    document.documentElement.style.removeProperty("font-size")
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
  })

  it("merges stored values with the preference defaults", () => {
    window.localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({ firstDayOfWeek: "monday", pointerCursors: true })
    )

    expect(loadPersonalPreferences()).toEqual({
      ...defaultPersonalPreferences,
      firstDayOfWeek: "monday",
      pointerCursors: true,
    })
  })

  it("falls back to defaults when stored preferences are invalid", () => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, "{invalid")

    expect(loadPersonalPreferences()).toEqual(defaultPersonalPreferences)
  })

  it("applies system theme, font size, and interface flags", () => {
    applyPersonalInterfacePreferences({
      ...defaultPersonalPreferences,
      fontSize: "large",
      pointerCursors: true,
      underlineLinks: true,
    })

    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.dataset.forgeTheme).toBe("dark")
    expect(document.documentElement.style.fontSize).toBe("17px")
    expect(document.documentElement.dataset.forgePointerCursors).toBe("true")
    expect(document.documentElement.dataset.forgeUnderlineLinks).toBe("true")
  })

  it("allows an explicit light theme to override the system", () => {
    document.documentElement.classList.add("dark")

    applyPersonalInterfacePreferences({
      ...defaultPersonalPreferences,
      interfaceTheme: "light",
    })

    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.dataset.forgeTheme).toBe("light")
  })

  it("applies the selected palette for the active appearance", () => {
    applyPersonalInterfacePreferences({
      ...defaultPersonalPreferences,
      interfaceTheme: "dark",
      lightTheme: "paper",
      darkTheme: "midnight",
    })

    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.dataset.forgeTheme).toBe("midnight")
  })
})

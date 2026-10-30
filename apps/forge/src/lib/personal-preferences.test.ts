import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  PREFERENCES_STORAGE_KEY,
  applyPersonalInterfacePreferences,
  defaultPersonalPreferences,
  loadPersonalPreferences,
  savePersonalPreferences,
} from "./personal-preferences"
import { productStorage } from "@/lib/product-storage"

describe("personal preferences", () => {
  beforeEach(() => {
    productStorage.clear()
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
    productStorage.setItem(
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
    productStorage.setItem(PREFERENCES_STORAGE_KEY, "{invalid")

    expect(loadPersonalPreferences()).toEqual(defaultPersonalPreferences)
  })

  it("keeps safe values when a stored field is invalid without rewriting on read", () => {
    const raw = JSON.stringify({
      interfaceTheme: "dark",
      fontSize: "huge",
      checkSpelling: "false",
    })
    productStorage.setItem(PREFERENCES_STORAGE_KEY, raw)
    expect(loadPersonalPreferences()).toMatchObject({
      interfaceTheme: "dark",
      fontSize: "default",
      checkSpelling: true,
    })
    expect(productStorage.getItem(PREFERENCES_STORAGE_KEY)).toBe(raw)
  })

  it("preserves corrupt source before an explicit edit replaces it", () => {
    const raw = "{broken"
    productStorage.setItem(PREFERENCES_STORAGE_KEY, raw)
    savePersonalPreferences({
      ...defaultPersonalPreferences,
      firstDayOfWeek: "monday",
    })
    const backup = Array.from({ length: productStorage.length }, (_, i) =>
      productStorage.key(i)
    ).find((key) => key.startsWith(`${PREFERENCES_STORAGE_KEY}.recovery.`))
    expect(backup).toBeDefined()
    expect(productStorage.getItem(backup!)).toBe(raw)
    expect(loadPersonalPreferences().firstDayOfWeek).toBe("monday")
  })

  it("refuses to overwrite future versions", () => {
    const raw = '{"version":99,"values":{"fontSize":"future"}}'
    productStorage.setItem(PREFERENCES_STORAGE_KEY, raw)
    expect(loadPersonalPreferences()).toEqual(defaultPersonalPreferences)
    expect(() =>
      savePersonalPreferences({ ...defaultPersonalPreferences })
    ).toThrow("newer version")
    expect(productStorage.getItem(PREFERENCES_STORAGE_KEY)).toBe(raw)
  })

  it("preserves unknown fields and envelope metadata across explicit edits", () => {
    productStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        metadata: "retained",
        values: { interfaceTheme: "dark", future: { nested: true } },
      })
    )
    savePersonalPreferences({ ...loadPersonalPreferences(), fontSize: "large" })
    expect(
      JSON.parse(productStorage.getItem(PREFERENCES_STORAGE_KEY)!)
    ).toMatchObject({
      version: 1,
      metadata: "retained",
      values: {
        interfaceTheme: "dark",
        fontSize: "large",
        future: { nested: true },
      },
    })
  })

  it("does not overwrite damaged data when recovery storage fails", () => {
    const raw = "{broken"
    productStorage.setItem(PREFERENCES_STORAGE_KEY, raw)
    vi.spyOn(productStorage, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    expect(() =>
      savePersonalPreferences({ ...defaultPersonalPreferences })
    ).toThrow("quota")
    expect(productStorage.getItem(PREFERENCES_STORAGE_KEY)).toBe(raw)
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

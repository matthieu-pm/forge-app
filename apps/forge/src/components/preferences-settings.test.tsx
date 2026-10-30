import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { PreferencesSettings } from "./preferences-settings"
import { productStorage } from "@/lib/product-storage"
import {
  renderPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

describe("PreferencesSettings themes", () => {
  beforeEach(async () => {
    await setupPreferenceFixture()
    productStorage.clear()
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
  })

  it("shows theme previews in the appearance controls and choices", async () => {
    renderPreferences(<PreferencesSettings />)

    const interfaceTheme = screen.getByRole("button", {
      name: "Interface theme",
    })
    const lightTheme = screen.getByRole("button", { name: "Light theme" })
    const darkTheme = screen.getByRole("button", { name: "Dark theme" })

    expect(
      interfaceTheme.querySelector('[data-slot="theme-preview"]')
    ).not.toBeNull()
    expect(
      lightTheme.querySelector('[data-slot="theme-preview"]')
    ).not.toBeNull()
    expect(
      darkTheme.querySelector('[data-slot="theme-preview"]')
    ).not.toBeNull()
    expect(
      (
        lightTheme.querySelector(
          '[data-slot="theme-preview-label"]'
        ) as HTMLElement
      ).style.color
    ).toBe("rgb(23, 23, 23)")

    fireEvent.click(darkTheme)

    const midnightOption = await screen.findByText("Midnight")
    const option = midnightOption.closest('[role="menuitemradio"]')
    expect(option?.querySelector('[data-slot="theme-preview"]')).not.toBeNull()

    if (!option) return
    fireEvent.click(option)

    await waitFor(() => {
      expect(document.documentElement.dataset.forgeTheme).toBe("midnight")
    })
  })
})

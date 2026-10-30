import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PreferencesSettings } from "./preferences-settings"
import { productStorage } from "@/lib/product-storage"
import { loadStartedAssignmentAvailability } from "@/lib/account-preference-state"
import {
  renderPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

vi.mock("@/lib/account-preference-state", () => ({
  loadStartedAssignmentAvailability: vi.fn(),
}))

describe("PreferencesSettings themes", () => {
  afterEach(cleanup)
  beforeEach(async () => {
    vi.mocked(loadStartedAssignmentAvailability).mockResolvedValue(false)
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

  it("withholds the automation control when disabled or availability cannot be verified", () => {
    vi.mocked(loadStartedAssignmentAvailability).mockRejectedValue(
      new Error("offline")
    )
    renderPreferences(<PreferencesSettings />)
    expect(
      screen
        .getByRole("switch", { name: "Assign started issues to self" })
        .hasAttribute("data-disabled")
    ).toBe(true)
    expect(
      screen.getByText("This automation is currently unavailable")
    ).toBeTruthy()
  })

  it("exposes and saves the rule only when the server enables it", async () => {
    vi.mocked(loadStartedAssignmentAvailability).mockResolvedValue(true)
    renderPreferences(<PreferencesSettings />)
    const control = screen.getByRole("switch", {
      name: "Assign started issues to self",
    })
    await waitFor(() =>
      expect(control.hasAttribute("data-disabled")).toBe(false)
    )
    fireEvent.click(control)
    await waitFor(() =>
      expect(control.getAttribute("aria-checked")).toBe("true")
    )
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

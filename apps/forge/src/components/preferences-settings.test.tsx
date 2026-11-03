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

afterEach(cleanup)

it("FOR-129 changes an already-mounted calendar through the real preference selector", async () => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
  vi.mocked(loadStartedAssignmentAvailability).mockResolvedValue(false)
  const { DateInput } = await import("@/components/ui/date-input")
  await setupPreferenceFixture()
  const changed = vi.fn()
  const { container } = renderPreferences(
    <DateInput inlineCalendar value="2026-01-01" onValueChange={changed} />
  )
  renderPreferences(<PreferencesSettings />)
  const root = container.querySelector('[data-slot="calendar"]')
  const heading = () =>
    root?.querySelector('th[scope="col"]')?.getAttribute("aria-label")
  expect(heading()).toBe("Sunday")
  fireEvent.click(screen.getByRole("button", { name: "First day of the week" }))
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Monday" }))
  await waitFor(() => expect(heading()).toBe("Monday"))
  expect(container.querySelector('[data-slot="calendar"]')).toBe(root)
  expect((container.querySelector("input") as HTMLInputElement).value).toBe(
    "2026-01-01"
  )
  expect(changed).not.toHaveBeenCalled()
})

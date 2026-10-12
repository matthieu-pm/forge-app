import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  InitiativesSettings,
  initiativesSettingsStorageKey,
} from "./initiatives-settings"
import type { ReactNode } from "react"
import {
  initialInitiativeLabels,
  initiativeLabelsStorageKey,
} from "@/lib/team-labels"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))
beforeEach(() => {
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})
const key = initiativesSettingsStorageKey("test")
it("persists enablement and disables dependent controls without losing the schedule", () => {
  localStorage.setItem(
    key,
    JSON.stringify({ enabled: true, schedule: "2-weeks" })
  )
  const { unmount } = render(<InitiativesSettings workspaceId="test" />)
  fireEvent.click(screen.getByRole("switch", { name: "Enable Initiatives" }))
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
    enabled: false,
    schedule: "2-weeks",
  })
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Edit" }).disabled
  ).toBe(true)
  expect(
    screen
      .getByRole("link", { name: "Initiative labels settings" })
      .getAttribute("aria-disabled")
  ).toBe("true")
  unmount()
  render(<InitiativesSettings workspaceId="test" />)
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false")
  fireEvent.click(screen.getByRole("switch"))
  expect(screen.getByText("Every 2 weeks")).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Edit" }).disabled
  ).toBe(false)
})
it("saves schedule choices and cancels drafts", async () => {
  render(<InitiativesSettings workspaceId="test" />)
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  fireEvent.click(screen.getByRole("combobox"))
  const weekly = await screen.findByRole("option", { name: "Every week" })
  fireEvent.pointerDown(weekly)
  fireEvent.pointerUp(weekly)
  fireEvent.click(weekly)
  await waitFor(() =>
    expect(screen.getByRole("combobox").textContent).toContain("Every week")
  )
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.getByText("No expectation for updates")).toBeTruthy()
  expect(localStorage.getItem(key)).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  fireEvent.click(screen.getByRole("combobox"))
  const biweekly = await screen.findByRole("option", { name: "Every 2 weeks" })
  fireEvent.pointerDown(biweekly)
  fireEvent.pointerUp(biweekly)
  fireEvent.click(biweekly)
  await waitFor(() =>
    expect(screen.getByRole("combobox").textContent).toContain("Every 2 weeks")
  )
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem(key)!).schedule).toBe("2-weeks")
  )
})
it("preserves invalid saved data and prevents writes", () => {
  localStorage.setItem(key, "invalid")
  render(<InitiativesSettings workspaceId="test" />)
  expect(screen.getByRole("alert")).toBeTruthy()
  fireEvent.click(screen.getByRole("switch"))
  expect(localStorage.getItem(key)).toBe("invalid")
})
it("counts active initiative labels and links to their settings", () => {
  const directory = initialInitiativeLabels()
  directory.labels.push({
    id: "one",
    name: "Launch",
    description: "",
    color: "#ffffff",
    groupId: null,
    issues: 0,
    lastApplied: null,
    createdAt: new Date().toISOString(),
  })
  localStorage.setItem(initiativeLabelsStorageKey, JSON.stringify(directory))
  render(<InitiativesSettings workspaceId="test" />)
  expect(screen.getByText("1 label")).toBeTruthy()
  expect(
    screen
      .getByRole("link", { name: "Initiative labels settings" })
      .getAttribute("href")
  ).toBe("/settings/initiative-labels")
})

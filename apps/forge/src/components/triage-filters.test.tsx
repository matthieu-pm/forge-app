import { useState } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TriageFilterChips, TriageFilters } from "./triage-filters"
import type { TeamSummary } from "@/lib/team-contract"
import { selectOption } from "@/test-utils/select-option"
import { emptyTriageFilters } from "@/lib/triage-filters"

vi.mock("@/lib/template-state", () => ({
  loadTemplates: vi.fn().mockResolvedValue({ members: [] }),
}))
afterEach(cleanup)
function Harness() {
  const [filters, setFilters] = useState(emptyTriageFilters)
  return (
    <>
      <TriageFilters
        team={{ slug: "testing" } as TeamSummary}
        issues={[]}
        value={filters}
        onChange={setFilters}
      />
      <TriageFilterChips value={filters} onChange={setFilters} />
      <input aria-label="Other input" />
    </>
  )
}
describe("triage filter menu", () => {
  it("searches categories, opens nested choices, and clears a filter", async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }))
    const search = await screen.findByRole("textbox", { name: "Add filter" })
    fireEvent.change(search, { target: { value: "prio" } })
    expect(screen.queryByRole("menuitem", { name: "Assignee" })).toBeNull()
    fireEvent.click(screen.getByRole("menuitem", { name: "Priority" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "High" }))
    const chip = await screen.findByRole("button", {
      name: "Remove filter: Priority is High",
    })
    fireEvent.click(chip)
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull()
  })
  it("applies and cancels advanced conditions independently", async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Advanced filter" })
    )
    selectOption(await screen.findByRole("combobox", { name: "Filter 1 field" }), "Content")
    fireEvent.change(screen.getByRole("textbox", { name: "Filter 1 value" }), {
      target: { value: "request" },
    })
    selectOption(screen.getByRole("combobox", { name: "Match conditions" }), "any")
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }))
    expect(
      await screen.findByRole("button", {
        name: "Remove filter: Content contains request",
      })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Advanced filter" })
    )
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Filter 1 value" }),
      { target: { value: "changed" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(
      screen.getByRole("button", {
        name: "Remove filter: Content contains request",
      })
    ).toBeTruthy()
  })
  it("explains unavailable integrations without adding a filter", async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Agent" }))
    expect(
      await screen.findByText(
        "Agent assignments are not available for triage issues yet."
      )
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull()
  })
  it("opens with F without intercepting typing in inputs", async () => {
    render(<Harness />)
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Other input" }), {
      key: "f",
    })
    expect(screen.queryByRole("menu")).toBeNull()
    fireEvent.keyDown(document.body, { key: "f" })
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Add filter" })).toBeTruthy()
    )
  })
})

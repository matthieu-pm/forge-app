import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UpcomingCycle } from "./upcoming-cycle"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import { cycleIssuesKey, parseCycleIssues } from "@/lib/cycle-issues"
import { initialTeamCycles, teamCyclesStorageKey } from "@/lib/team-cycles"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))
const team = {
  id: "upcoming-test",
  slug: "product",
  name: "Product",
  identifier: "PRO",
} as TeamSummary
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(
    teamCyclesStorageKey(team.id),
    JSON.stringify({ ...initialTeamCycles(), enabled: true })
  )
})
afterEach(cleanup)
function create(title: string) {
  fireEvent.click(screen.getByRole("button", { name: "Create new issue" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
    target: { value: title },
  })
  fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
}
describe("upcoming cycle", () => {
  it("keeps numbered cycle pages separate from Upcoming", () => {
    const first = render(<UpcomingCycle team={team} />)
    create("First cycle issue")
    first.unmount()
    const second = render(<UpcomingCycle team={team} cycleNumber={2} />)
    expect(screen.getByRole("heading", { name: "Cycle 2" })).toBeTruthy()
    expect(screen.queryByText("First cycle issue")).toBeNull()
    create("Second cycle issue")
    second.unmount()
    render(<UpcomingCycle team={team} />)
    expect(screen.getByText("First cycle issue")).toBeTruthy()
    expect(screen.queryByText("Second cycle issue")).toBeNull()
  })

  it("creates an issue, restores it after remount, and moves it between status columns", () => {
    const view = render(<UpcomingCycle team={team} />)
    expect(screen.getByRole("heading", { name: "Cycle 1" })).toBeTruthy()
    create("Plan launch")
    expect(
      screen.getByRole("button", { name: "Open PRO-1 Plan launch" })
    ).toBeTruthy()
    view.unmount()
    render(<UpcomingCycle team={team} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Open PRO-1 Plan launch" })
    )
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "done" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save issue" }))
    const done = screen.getByRole("region", { name: "Done" })
    expect(
      within(done).getByRole("button", { name: "Open PRO-1 Plan launch" })
    ).toBeTruthy()
    fireEvent.change(
      screen.getByRole("combobox", { name: "Filter by status" }),
      { target: { value: "todo" } }
    )
    expect(screen.getByText("No issues match this filter.")).toBeTruthy()
    expect(
      parseCycleIssues(localStorage.getItem(cycleIssuesKey(team.id))!)[0].status
    ).toBe("done")
  })
  it("does not show another team's or another cycle's issues", () => {
    const old = {
      id: "old",
      number: 1,
      cycle: "2000-01-01",
      title: "Old cycle",
      description: "",
      status: "todo",
      priority: "No priority",
      createdAt: "2000-01-01T12:00:00.000Z",
    }
    localStorage.setItem(cycleIssuesKey(team.id), JSON.stringify([old]))
    localStorage.setItem(
      cycleIssuesKey("other"),
      JSON.stringify([{ ...old, title: "Another team" }])
    )
    render(<UpcomingCycle team={team} />)
    expect(screen.queryByText("Old cycle")).toBeNull()
    expect(screen.queryByText("Another team")).toBeNull()
    create("Next cycle")
    expect(
      screen.getByRole("button", { name: "Open PRO-2 Next cycle" })
    ).toBeTruthy()
    expect(
      parseCycleIssues(localStorage.getItem(cycleIssuesKey(team.id))!)
    ).toHaveLength(2)
  })
  it("preserves corrupt saved data and blocks editing", () => {
    localStorage.setItem(cycleIssuesKey(team.id), "invalid")
    render(<UpcomingCycle team={team} />)
    expect(screen.getByRole("alert").textContent).toContain("preserved")
    expect(
      screen.queryByRole("button", { name: "Create new issue" })
    ).toBeNull()
    expect(localStorage.getItem(cycleIssuesKey(team.id))).toBe("invalid")
  })
  it("keeps a draft open when saving fails", () => {
    render(<UpcomingCycle team={team} />)
    fireEvent.click(screen.getByRole("button", { name: "Create new issue" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Unsaved" },
    })
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota")
      })
    fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
    expect(screen.getByRole("alert").textContent).toContain(
      "draft is still here"
    )
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Issue title" })
        .value
    ).toBe("Unsaved")
    setItem.mockRestore()
  })
})

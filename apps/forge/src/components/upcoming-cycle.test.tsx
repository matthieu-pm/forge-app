import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UpcomingCycle } from "./upcoming-cycle"
import type { ComponentProps } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import { selectOption } from "@/test-utils/select-option"
import { cycleIssuesKey, parseCycleIssues } from "@/lib/cycle-issues"
import { initialTeamCycles, teamCyclesStorageKey } from "@/lib/team-cycles"
import { cycleIssueViewKey } from "@/lib/cycle-issue-view"
import {
  blankIssueDraft,
  readIssueStore,
  saveTeamIssue,
} from "@/lib/team-issues"
import { initialTeamStatuses } from "@/lib/team-statuses"

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params: _params,
    search: _search,
    ...props
  }: ComponentProps<"a"> & {
    to: string
    params?: unknown
    search?: unknown
  }) => (
    <a href={to} {...props} onClick={(event) => event.preventDefault()}>
      {children}
    </a>
  ),
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "user", name: "Matthieu" } } }),
  },
}))
vi.mock("@/lib/template-state", () => ({
  loadTemplates: () =>
    Promise.resolve({
      templates: [],
      teams: [team],
      members: [{ id: "user", name: "Matthieu", image: null }],
      defaults: { members: null, nonMembers: null },
      canManage: false,
    }),
}))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => <span />,
}))
const team = {
  id: "upcoming-test",
  slug: "product",
  name: "Product",
  identifier: "PRO",
} as TeamSummary
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
  localStorage.setItem(
    teamCyclesStorageKey(team.id),
    JSON.stringify({ ...initialTeamCycles(), enabled: true })
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
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

  it("creates an issue, restores it after remount, and moves it between status groups", async () => {
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
    selectOption(screen.getByRole("combobox", { name: "Status" }), "Done")
    fireEvent.click(screen.getByRole("button", { name: "Save issue" }))
    const done = screen.getByRole("region", { name: "Done group" })
    expect(
      within(done).getByRole("button", { name: "Open PRO-1 Plan launch" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Status" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Todo" }))
    expect(screen.getByText("No issues match these filters.")).toBeTruthy()
    expect(readIssueStore(team.id).issues[0].status).toBe("done")
  })
  it("uses shared issue rows and preserves inline changes, selection, and cycle display preferences", async () => {
    const view = render(<UpcomingCycle team={team} />)
    create("Inline cycle work")
    const assigned = readIssueStore(team.id).issues[0]
    expect(screen.getByLabelText("Issue list")).toBeTruthy()
    expect(screen.getAllByTestId("issue-row")).toHaveLength(1)
    expect(
      screen.getByRole("button", {
        name: "Change status for Inline cycle work",
      })
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", {
        name: "Set priority to for Inline cycle work",
      })
    )
    fireEvent.click(screen.getByRole("option", { name: "High" }))
    expect(readIssueStore(team.id).issues[0].priority).toBe("High")
    fireEvent.click(screen.getByRole("checkbox", { name: "Select PRO-1" }))
    expect(
      screen.getByRole("toolbar", { name: "Selected cycle issues" }).textContent
    ).toContain("1 selected")
    fireEvent.click(
      screen.getByRole("button", { name: "Set selected assignee" })
    )
    fireEvent.click(await screen.findByRole("option", { name: "Matthieu" }))
    expect(readIssueStore(team.id).issues[0].assignee).toBe("user")
    expect(
      screen.queryByRole("toolbar", { name: "Selected cycle issues" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Display options" }))
    fireEvent.click(screen.getByRole("tab", { name: "Board" }))
    expect(screen.getByLabelText("Issue board")).toBeTruthy()
    expect(
      JSON.parse(
        localStorage.getItem(cycleIssueViewKey(team.id, assigned.cycle))!
      ).display.layout
    ).toBe("board")
    view.unmount()
    render(<UpcomingCycle team={team} />)
    expect(screen.getByLabelText("Issue board")).toBeTruthy()
    expect(readIssueStore(team.id).display.layout).toBe("list")
  })
  it("shows complete canonical row data and keeps other cycles out of nested rows", () => {
    const view = render(<UpcomingCycle team={team} />)
    create("Parent")
    const parent = readIssueStore(team.id).issues[0]
    view.unmount()
    saveTeamIssue(team.id, {
      ...blankIssueDraft(),
      title: "Scoped child",
      cycle: parent.cycle,
      parentId: parent.id,
      assignee: "user",
      labels: "Bug",
      project: "Release",
    })
    saveTeamIssue(team.id, {
      ...blankIssueDraft(),
      title: "Other cycle child",
      cycle: "2000-01-01",
      parentId: parent.id,
    })
    render(<UpcomingCycle team={team} />)
    expect(screen.getByText("Scoped child")).toBeTruthy()
    expect(screen.getByText("Bug")).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "View issues in project Release" })
    ).toBeTruthy()
    expect(screen.queryByText("Other cycle child")).toBeNull()
    expect(screen.queryByRole("link", { name: "Open Cycle 1" })).toBeNull()
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
      screen.getByRole("button", { name: "Open PRO-1 Next cycle" })
    ).toBeTruthy()
    expect(
      parseCycleIssues(localStorage.getItem(cycleIssuesKey(team.id))!)
    ).toHaveLength(1)
    expect(readIssueStore(team.id).issues[0].title).toBe("Next cycle")
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
  it("uses the shared composer with the current cycle, assignee picker, and draft saving", async () => {
    render(<UpcomingCycle team={team} cycleNumber={2} />)
    fireEvent.click(screen.getByRole("button", { name: "Create new issue" }))
    expect(screen.getByRole("dialog", { name: "Create issue" })).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Change cycle" }).textContent
    ).toContain("Cycle 2")
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Plan next release" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Change assignee" }))
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Matthieu" })).toBeTruthy()
    )
    fireEvent.click(screen.getByRole("option", { name: "Matthieu" }))
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }))
    const saved = readIssueStore(team.id).drafts[0].draft
    expect(saved).toMatchObject({
      title: "Plan next release",
      assignee: "user",
    })
    expect(saved.cycle).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(readIssueStore(team.id).issues).toHaveLength(0)
  })
  it("opens the same composer from a status column and preserves the cycle for Create more", () => {
    render(<UpcomingCycle team={team} />)
    create("First")
    fireEvent.click(
      screen.getByRole("button", { name: "Create issue in Todo" })
    )
    expect(screen.getByRole("dialog", { name: "Create issue" })).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Change status" }).textContent
    ).toContain("Todo")
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Second" },
    })
    fireEvent.click(screen.getByRole("switch", { name: "Create more" }))
    fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
    expect(screen.getByRole("dialog", { name: "Create issue" })).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Change cycle" }).textContent
    ).toContain("Cycle 1")
    const records = readIssueStore(team.id).issues
    expect(records).toHaveLength(2)
    expect(records[1].cycle).toBe(records[0].cycle)
    expect(records[1].status).toBe(
      initialTeamStatuses().statuses.find(
        (status) => status.group === "unstarted"
      )?.id
    )
  })
})

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IssueRows } from "./issue-list"
import type { ComponentProps } from "react"
import type { TeamIssue } from "@/lib/team-issues"
import { blankIssueDraft, defaultIssueDisplay } from "@/lib/team-issues"
import { initialTeamStatuses } from "@/lib/team-statuses"

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null }) },
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
    params,
    ...props
  }: ComponentProps<"a"> & {
    search?: Record<string, string>
    params?: { teamSlug: string }
  }) => (
    <a
      {...props}
      href={`/teams/${params?.teamSlug}/issues?${new URLSearchParams(search)}`}
    >
      {children}
    </a>
  ),
}))
const statuses = initialTeamStatuses().statuses
const todo = statuses.find((item) => item.group === "unstarted")!.id
const done = statuses.find((item) => item.group === "completed")!.id
function issue(
  id: string,
  number: number,
  parentId = "",
  status = todo
): TeamIssue {
  return {
    ...blankIssueDraft(),
    id,
    number,
    parentId,
    status,
    title: id,
    creator: "You",
    activity: [],
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
    statusChangedAt: "2026-10-24T09:00:00.000Z",
    completedAt: null,
    suggestedLabel: "",
    recurrenceSpawned: false,
  }
}
const parent = issue("Parent", 1)
const child = issue("Child", 2, parent.id)
const completed = issue("Completed", 3, parent.id, done)
const other = issue("Other", 4)
function start(overrides: Partial<ComponentProps<typeof IssueRows>> = {}) {
  const props = {
    issues: [child, parent, completed, other],
    allIssues: [parent, child, completed, other],
    identifier: "TES",
    team: { slug: "testing", name: "Testing" },
    statuses,
    members: [],
    display: { ...defaultIssueDisplay(), group: "No grouping" as const },
    selected: [],
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onUpdate: vi.fn(),
    onCreate: vi.fn(),
    ...overrides,
  }
  render(<IssueRows {...props} />)
  return props
}
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("issue rows", () => {
  it("nests children after the parent while preserving the right edge of every row", () => {
    start()
    expect(
      screen.getAllByTestId("issue-row").map((row) => row.dataset.issueId)
    ).toEqual(["Parent", "Child", "Completed", "Other"])
    const childRow = screen.getAllByTestId("issue-row")[1]
    expect(childRow.dataset.depth).toBe("1")
    expect(childRow.style.marginLeft).toBe("")
    expect(
      screen.getByRole("button", { name: "Hide sub-issues for TES-1" })
        .textContent
    ).toBe("1/2")
  })
  it("collapses only the chosen parent's descendants and restores them without opening the issue", () => {
    const props = start()
    fireEvent.click(
      screen.getByRole("button", { name: "Hide sub-issues for TES-1" })
    )
    expect(
      screen.queryByRole("button", { name: "Open TES-2 Child" })
    ).toBeNull()
    expect(
      screen.getByRole("button", { name: "Open TES-4 Other" })
    ).toBeTruthy()
    expect(props.onOpen).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", { name: "Show sub-issues for TES-1" })
    )
    expect(
      screen.getByRole("button", { name: "Open TES-2 Child" })
    ).toBeTruthy()
  })
  it("keeps flat display flat and separates row opening from selection and property editing", () => {
    const props = start({
      display: {
        ...defaultIssueDisplay(),
        group: "No grouping",
        nested: "Hide",
      },
    })
    expect(
      screen.queryByRole("button", { name: "Hide sub-issues for TES-1" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select TES-2" }))
    expect(props.onSelect).toHaveBeenCalledWith("Child")
    expect(props.onOpen).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", { name: "Change status for Child" })
    )
    fireEvent.click(screen.getByRole("listbox", { name: "Change status for Child" }))
    expect(props.onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("option", { name: /Done/ }))
    expect(props.onUpdate).toHaveBeenCalledWith(child, { status: done })
    expect(props.onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByTestId("issue-row")[0])
    expect(props.onOpen).toHaveBeenCalledOnce()
  })
  it("keeps board cards flat and opens the parent from its sub-issue summary", () => {
    const props = start({
      display: { ...defaultIssueDisplay(), layout: "board" },
    })
    expect(
      screen
        .getAllByTestId("issue-row")
        .every((row) => row.dataset.depth === "0")
    ).toBe(true)
    fireEvent.click(
      screen.getByRole("button", { name: "View sub-issues for TES-1" })
    )
    expect(props.onOpen).toHaveBeenCalledWith(parent)
  })
  it("renders distinct colored label links and a project chip", () => {
    const labeled = {
      ...parent,
      labels: "Bug, Feature",
      project: "Story mapping",
    }
    start({
      issues: [labeled],
      allIssues: [labeled],
      labelColors: { Bug: "#eb5757", Feature: "#8b5cf6" },
    })
    const bug = screen.getByRole("link", { name: "View issues labeled Bug" })
    expect(bug.getAttribute("href")).toContain("label=Bug")
    expect(bug.querySelector("span")?.style.backgroundColor).toBe(
      "rgb(235, 87, 87)"
    )
    expect(
      screen.getByRole("link", { name: "View issues labeled Feature" })
    ).toBeTruthy()
    expect(
      screen
        .getByRole("link", { name: "View issues in project Story mapping" })
        .querySelector("svg")
    ).toBeTruthy()
  })
})

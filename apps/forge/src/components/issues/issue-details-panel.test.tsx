import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { IssueDetailsPanel } from "./issue-details-panel"
import type { TeamIssue } from "@/lib/team-issues"
import { blankIssueDraft, matchesIssueFilters } from "@/lib/team-issues"

function issue(id: string, patch: Partial<TeamIssue> = {}): TeamIssue {
  return {
    ...blankIssueDraft(),
    id,
    number: 1,
    title: id,
    creator: "You",
    createdAt: "2026-10-27T00:00:00Z",
    updatedAt: "2026-10-27T00:00:00Z",
    statusChangedAt: "2026-10-27T00:00:00Z",
    completedAt: null,
    suggestedLabel: "",
    recurrenceSpawned: false,
    ...patch,
  }
}
const issues = [
  issue("first", {
    assignee: "member",
    labels: "Bug, UI, Bug",
    priority: "High",
    project: "Forge",
  }),
  issue("second", { assignee: "member", labels: "Bug", priority: "Low" }),
  issue("third"),
]
function start(value = issues) {
  const onFilter = vi.fn()
  const onClose = vi.fn()
  const props = {
    issues: value,
    members: [{ id: "member", name: "Matthieu", image: null }],
    labelColors: { Bug: "#f05050" },
    onFilter,
    onClose,
  }
  const view = render(<IssueDetailsPanel {...props} />)
  return { ...view, props, onFilter, onClose }
}
afterEach(cleanup)

describe("issue details panel", () => {
  it("summarizes each dimension and counts a repeated label only once per issue", () => {
    start()
    expect(
      screen.getByRole("button", { name: "Matthieu, 2 issues" })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Unassigned, 1 issue" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Labels" }))
    expect(screen.getByRole("button", { name: "Bug, 2 issues" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "UI, 1 issue" })).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "No label, 1 issue" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Priority" }))
    expect(screen.getByRole("button", { name: "High, 1 issue" })).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "No priority, 1 issue" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }))
    expect(screen.getByRole("button", { name: "Forge, 1 issue" })).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "No project, 2 issues" })
    ).toBeTruthy()
  })

  it("produces filters that match labels within multi-label issues and missing values", () => {
    const { onFilter } = start()
    fireEvent.click(screen.getByRole("tab", { name: "Labels" }))
    fireEvent.click(screen.getByRole("button", { name: "Bug, 2 issues" }))
    const filter = { ...onFilter.mock.calls[0][0], id: "filter" }
    expect(
      issues
        .filter((item) =>
          matchesIssueFilters(item, { match: "all", rules: [filter] })
        )
        .map((item) => item.id)
    ).toEqual(["first", "second"])
    fireEvent.click(screen.getByRole("button", { name: "No label, 1 issue" }))
    const emptyFilter = { ...onFilter.mock.calls[1][0], id: "empty" }
    expect(
      issues
        .filter((item) =>
          matchesIssueFilters(item, { match: "all", rules: [emptyFilter] })
        )
        .map((item) => item.id)
    ).toEqual(["third"])
  })

  it("supports arrow, Home, and End navigation with focus following the selected tab", () => {
    start()
    const assignees = screen.getByRole("tab", { name: "Assignees" })
    fireEvent.keyDown(assignees, { key: "ArrowLeft" })
    const projects = screen.getByRole("tab", {
      name: "Projects",
      selected: true,
    })
    expect(document.activeElement).toBe(projects)
    fireEvent.keyDown(projects, { key: "Home" })
    expect(document.activeElement).toBe(assignees)
    fireEvent.keyDown(assignees, { key: "End" })
    expect(document.activeElement).toBe(projects)
    fireEvent.keyDown(projects, { key: "ArrowRight" })
    expect(document.activeElement).toBe(assignees)
  })

  it("updates counts as the visible set changes and handles an empty view", () => {
    const { rerender, props, onClose } = start()
    rerender(<IssueDetailsPanel {...props} issues={[issues[0]]} />)
    expect(
      screen.getByRole("button", { name: "Matthieu, 1 issue" })
    ).toBeTruthy()
    rerender(<IssueDetailsPanel {...props} issues={[]} />)
    expect(screen.getByText("No issues to summarize")).toBeTruthy()
    expect(screen.queryByText("Matthieu")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Close issue details" }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

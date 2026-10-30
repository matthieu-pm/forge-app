import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IssueRows } from "./issue-list"
import type { ComponentProps } from "react"
import type { TeamIssue } from "@/lib/team-issues"
import { productStorage } from "@/lib/product-storage"
import { blankIssueDraft, defaultIssueDisplay } from "@/lib/team-issues"
import { initialTeamStatuses } from "@/lib/team-statuses"
import {
  initialTeamCycles,
  scheduledTeamCycles,
  teamCyclesStorageKey,
} from "@/lib/team-cycles"

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null }) },
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
    params,
    to,
    ...props
  }: ComponentProps<"a"> & {
    search?: Record<string, string>
    params?: { teamSlug: string; cycleNumber?: string }
    to?: string
  }) => (
    <a
      {...props}
      href={
        to?.includes("/cycle")
          ? to
              .replace("$teamSlug", params?.teamSlug ?? "")
              .replace("$cycleNumber", params?.cycleNumber ?? "")
          : `/teams/${params?.teamSlug}/issues?${new URLSearchParams(search)}`
      }
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
    team: { id: "testing-id", slug: "testing", name: "Testing" },
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
  productStorage.clear()
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

it("shows the authorized group total across unloaded pages", () => {
  start({
    issues: [parent],
    allIssues: [parent],
    serverGroups: [{ group: "All issues", subgroup: "All issues", count: 121 }],
  })
  expect(screen.getByText("121")).toBeTruthy()
  expect(screen.getByRole("button", { name: /Open TES-1 Parent/ })).toBeTruthy()
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
    fireEvent.click(
      screen.getByRole("listbox", { name: "Change status for Child" })
    )
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
  it("shows an assigned cycle after the project and opens its cycle without opening the issue", () => {
    const settings = { ...initialTeamCycles(), enabled: true }
    productStorage.setItem(
      teamCyclesStorageKey("testing-id"),
      JSON.stringify(settings)
    )
    const assigned = {
      ...parent,
      project: "Story mapping",
      cycle: scheduledTeamCycles(settings)[1].value,
    }
    const props = start({
      issues: [assigned, other],
      allIssues: [assigned, other],
    })
    const badge = screen.getByRole("link", { name: "Open Cycle 2" })
    expect(badge.textContent).toBe("2")
    expect(badge.getAttribute("href")).toBe("/teams/testing/cycle/2")
    const project = screen.getByRole("link", {
      name: "View issues in project Story mapping",
    })
    expect(
      project.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      screen.getAllByTestId("issue-row")[1].querySelector('a[href*="/cycle"]')
    ).toBeNull()
    fireEvent.click(badge)
    expect(props.onOpen).not.toHaveBeenCalled()
    act(() => {
      productStorage.setItem(
        teamCyclesStorageKey("testing-id"),
        JSON.stringify({ ...settings, enabled: false })
      )
      window.dispatchEvent(
        new StorageEvent("storage", { key: teamCyclesStorageKey("testing-id") })
      )
    })
    expect(screen.queryByRole("link", { name: "Open Cycle 2" })).toBeNull()
  })
  it("uses each issue's team in mixed-team views and keeps older cycle dates identifiable", () => {
    const settings = { ...initialTeamCycles(), enabled: true }
    productStorage.setItem(
      teamCyclesStorageKey("other-team"),
      JSON.stringify(settings)
    )
    const assigned = {
      ...parent,
      cycle: scheduledTeamCycles(settings)[0].value,
    }
    const historical = { ...other, cycle: "2020-01-06" }
    start({
      issues: [assigned, historical],
      allIssues: [assigned, historical],
      contextFor: () => ({
        team: {
          id: "other-team",
          slug: "product",
          name: "Product",
          identifier: "PRO",
        },
        statuses,
        members: [],
        labelColors: {},
        issues: [assigned, historical],
      }),
    })
    expect(
      screen.getByRole("link", { name: "Open Cycle 1" }).getAttribute("href")
    ).toBe("/teams/product/cycle/1")
    const previous = screen.getByRole("link", {
      name: "Cycle starting Jan 6, 2020",
    })
    expect(previous.textContent).toBe("Jan 6")
    expect(previous.getAttribute("href")).toBe("/teams/product/cycles")
  })
})

it("shows linked PRs between labels and project by default, and supports hiding them", () => {
  const linked = {
    ...parent,
    labels: "Bug",
    project: "Web",
    links: [
      { title: "Fix permissions", url: "https://github.com/acme/web/pull/12" },
    ],
  }
  const props = start({ issues: [linked], allIssues: [linked] })
  const badge = screen.getByRole("link", {
    name: /Open linked pull request #12/,
  })
  expect(badge.textContent).toBe("#12")
  const row = badge.parentElement!
  expect(row.textContent.indexOf("Bug")).toBeLessThan(
    row.textContent.indexOf("#12")
  )
  expect(row.textContent.indexOf("#12")).toBeLessThan(
    row.textContent.indexOf("Web")
  )
  cleanup()
  start({ ...props, display: { ...props.display, showPullRequests: false } })
  expect(
    screen.queryByRole("link", { name: /Open linked pull request/ })
  ).toBeNull()
})

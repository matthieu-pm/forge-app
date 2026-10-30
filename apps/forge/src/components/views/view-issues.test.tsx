import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ViewIssues } from "./view-issues"
import type { ComponentProps } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import { productStorage } from "@/lib/product-storage"
import {
  blankIssueDraft,
  defaultIssueDisplay,
  emptyIssueFilters,
  readIssueStore,
  saveTeamIssue,
  teamIssuesKey,
} from "@/lib/team-issues"

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    search,
    params: _params,
    ...props
  }: ComponentProps<"a"> & {
    to: string
    search?: Record<string, string>
    params?: unknown
  }) => (
    <a {...props} href={`${to}?${new URLSearchParams(search)}`}>
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
      teams: [],
      templates: [],
      members: [{ id: "user", name: "Matthieu", image: null }],
      canManage: false,
      defaults: { members: null, nonMembers: null },
    }),
}))
vi.mock("@/components/issues/issue-composer", () => ({
  IssueComposer: ({
    team,
    initial,
  }: {
    team: TeamSummary
    initial: { status: string; project?: string; milestone?: string }
  }) => (
    <div role="dialog" aria-label="Create issue">
      {team.name} {initial.status}
      <span data-testid="composer-project">{initial.project}</span>
      <span data-testid="composer-milestone">{initial.milestone}</span>
    </div>
  ),
}))
vi.mock("@/components/issues/issue-detail", () => ({
  IssueDetail: ({
    issue,
    onBack,
  }: {
    issue: { title: string }
    onBack: () => void
  }) => (
    <div>
      {issue.title}
      <button onClick={onBack}>Back to view</button>
    </div>
  ),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const first: TeamSummary = {
  id: "first",
  slug: "first",
  identifier: "ONE",
  name: "First",
  icon: { kind: "emoji", value: "🔥", color: "#94a3b8" },
  timezone: "Europe/Paris",
  description: "",
  visibility: "workspace",
  estimationScheme: "none",
  issueEmailEnabled: false,
  detailedHistoryEnabled: false,
  createdAt: "2026-10-24T08:00:00Z",
}
const second = {
  ...first,
  id: "second",
  slug: "second",
  identifier: "TWO",
  name: "Second",
}
const teams = [first, second]
const user = { id: "user", name: "Matthieu" }
function start(overrides: Partial<ComponentProps<typeof ViewIssues>> = {}) {
  const props = {
    workspaceId: "workspace",
    user,
    teams,
    filters: emptyIssueFilters(),
    display: defaultIssueDisplay(),
    onFiltersChange: vi.fn(),
    onDisplayChange: vi.fn(),
    onMetricsChange: vi.fn(),
    ...overrides,
  }
  return { ...render(<ViewIssues {...props} />), props }
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
  saveTeamIssue(
    first.id,
    {
      ...blankIssueDraft(),
      title: "First issue",
      assignee: "user",
      labels: "Bug",
      project: "First project",
    },
    { creator: "user" }
  )
  saveTeamIssue(
    second.id,
    {
      ...blankIssueDraft(),
      title: "Second issue",
      priority: "High",
      labels: "Bug, Design",
    },
    { creator: "other" }
  )
})
afterEach(() => {
  cleanup()
  productStorage.clear()
  vi.unstubAllGlobals()
})
describe("Custom view issue collection", () => {
  it("reuses workspace issue rows and persists edits to their owning team", async () => {
    start()
    await screen.findByRole("button", { name: "Open ONE-1 First issue" })
    expect(
      screen.getByRole("button", { name: "Open TWO-1 Second issue" })
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Set priority to for Second issue" })
    )
    fireEvent.click(await screen.findByRole("option", { name: /Urgent/ }))
    expect(readIssueStore(second.id).issues[0].priority).toBe("Urgent")
    expect(readIssueStore(first.id).issues[0].priority).toBe("No priority")
  })
  it("previews filters without rewriting team preferences and reports actual visible metrics", async () => {
    const firstBefore = productStorage.getItem(teamIssuesKey(first.id))
    const page = start({
      filters: {
        match: "all",
        rules: [
          { id: "priority", field: "priority", operator: "is", value: "High" },
        ],
      },
    })
    await screen.findByRole("button", { name: "Open TWO-1 Second issue" })
    expect(
      screen.queryByRole("button", { name: "Open ONE-1 First issue" })
    ).toBeNull()
    await waitFor(() =>
      expect(page.props.onMetricsChange).toHaveBeenLastCalledWith({
        Assignees: [{ value: "", label: "Unassigned", count: 1 }],
        Labels: [
          { value: "Bug", label: "Bug", count: 1 },
          { value: "Design", label: "Design", count: 1 },
        ],
        Projects: [{ value: "", label: "No project", count: 1 }],
        Teams: [{ value: "second", label: "Second", count: 1 }],
      })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Priority filter" })
    )
    expect(page.props.onFiltersChange).toHaveBeenCalledWith(emptyIssueFilters())
    expect(productStorage.getItem(teamIssuesKey(first.id))).toBe(firstBefore)
  })
  it("limits team views and creation to their selected team", async () => {
    start({ team: second })
    await screen.findByRole("button", { name: "Open TWO-1 Second issue" })
    expect(
      screen.queryByRole("button", { name: "Open ONE-1 First issue" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "New issue" }))
    expect(
      screen.getByRole("dialog", { name: "Create issue" }).textContent
    ).toContain("Second")
  })
  it("filters workspace rows with the selected team summary", async () => {
    const page = start({ teamIds: [first.id] })
    await screen.findByRole("button", { name: "Open ONE-1 First issue" })
    expect(
      screen.queryByRole("button", { name: "Open TWO-1 Second issue" })
    ).toBeNull()
    await waitFor(() =>
      expect(page.props.onMetricsChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          Teams: [{ value: "first", label: "First", count: 1 }],
        })
      )
    )
    page.rerender(<ViewIssues {...page.props} teamIds={[]} />)
    expect(
      await screen.findByRole("button", { name: "Open TWO-1 Second issue" })
    ).toBeTruthy()
  })
  it("portals shared controls to the page toolbar and wires header creation", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const createActionRef = { current: null as (() => void) | null }
    const page = start({
      toolbarHost: host,
      createActionRef,
      hideCreate: true,
      hideCount: true,
    })
    await screen.findByRole("button", { name: "Open ONE-1 First issue" })
    expect(
      within(host).getByRole("button", { name: "Add filter" })
    ).toBeTruthy()
    expect(
      within(page.container).queryByRole("button", { name: "Add filter" })
    ).toBeNull()
    expect(within(host).queryByRole("button", { name: "New issue" })).toBeNull()
    expect(within(host).queryByRole("status")).toBeNull()
    act(() => createActionRef.current?.())
    expect(screen.getByRole("dialog", { name: "Create issue" })).toBeTruthy()
    page.unmount()
    expect(createActionRef.current).toBeNull()
    expect(host.childElementCount).toBe(0)
    host.remove()
  })
  it("uses shared issue details and refreshes when a team issue changes", async () => {
    start()
    fireEvent.click(
      await screen.findByRole("button", { name: "Open TWO-1 Second issue" })
    )
    expect(
      await screen.findByRole("dialog", { name: "Second issue" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Back to view" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    act(() => {
      saveTeamIssue(
        second.id,
        { ...blankIssueDraft(), title: "Third issue" },
        { creator: "user" }
      )
    })
    expect(
      await screen.findByRole("button", { name: "Open TWO-2 Third issue" })
    ).toBeTruthy()
  })
})

describe("Project milestone issue scope", () => {
  const milestone = {
    id: "beta",
    name: "Beta",
    aliases: ["Old beta"],
    completed: false,
  }
  const project = { id: "launch", name: "Launch", teamIds: [first.id] }
  it("filters milestone assignments within the project and excludes other milestones and projects", async () => {
    for (const [title, projectId, assignment] of [
      ["Beta issue", "launch", "beta"],
      ["Renamed beta issue", "launch", "Old beta"],
      ["Other milestone issue", "launch", "later"],
      ["Unrelated project issue", "other", "beta"],
    ])
      saveTeamIssue(
        first.id,
        {
          ...blankIssueDraft(),
          title,
          project: projectId,
          milestone: assignment,
        },
        { creator: "user" }
      )
    start({ project, milestone, milestones: [milestone] })
    await screen.findByRole("button", { name: /Open ONE-2 Beta issue/ })
    expect(
      screen.getByRole("button", { name: /Open ONE-3 Renamed beta issue/ })
    ).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: /Open .*Other milestone issue/ })
    ).toBeNull()
    expect(
      screen.queryByRole("button", { name: /Open .*Unrelated project issue/ })
    ).toBeNull()
  })
  it("prefills the project and selected milestone when creating from an empty milestone", async () => {
    start({ project, milestone, milestones: [milestone] })
    fireEvent.click(
      await screen.findByRole("button", { name: /Create new issue/ })
    )
    expect(screen.getByTestId("composer-project").textContent).toBe("launch")
    expect(screen.getByTestId("composer-milestone").textContent).toBe("beta")
  })
})

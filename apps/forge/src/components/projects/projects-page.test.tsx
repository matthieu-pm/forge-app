import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProjectsPage } from "./projects-page"
import type { ReactNode } from "react"
import type { InitiativeProject } from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import {
  blankIssueDraft,
  getIssueStatuses,
  saveTeamIssue,
} from "@/lib/team-issues"
import {
  defaultProjectPreferences,
  projectPreferencesKey,
} from "@/lib/projects"
import {
  addInitiative,
  blankInitiative,
  emptyInitiatives,
  initiativesSettingsStorageKey,
  initiativesStorageKey,
} from "@/lib/initiatives"

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    hash,
    search: _search,
    to: _to,
    ...props
  }: {
    children: ReactNode
    params: { projectId: string }
    hash?: string
    search?: unknown
    to: string
  }) => (
    <a
      {...props}
      href={`/projects/${params.projectId}?tab=overview#${hash ?? ""}`}
    >
      {children}
    </a>
  ),
}))
vi.mock("@/components/templates/rich-editor", () => ({
  RichEditor: ({ label }: { label: string }) => (
    <div role="textbox" aria-label={label} />
  ),
}))
vi.mock("@hugeicons/core-free-icons?catalog", () => ({
  CubeIcon: [],
  Rocket01Icon: [],
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/agent/agent-provider", () => ({
  useAgent: () => ({ openComposer: vi.fn(), setDraft: vi.fn() }),
}))
const user = { id: "user", name: "Matthieu", image: null }
const team: TeamSummary = {
  id: "team",
  slug: "test",
  name: "Test",
  identifier: "TES",
  icon: { kind: "icon", value: "StarIcon", color: "#38bdf8" },
  timezone: "Europe/Paris",
  description: "",
  visibility: "workspace",
  estimationScheme: "none",
  issueEmailEnabled: false,
  detailedHistoryEnabled: false,
  createdAt: "2026-10-26T10:00:00.000Z",
}
const props = { workspaceId: "workspace", user, people: [user], teams: [team] }
const project: InitiativeProject = {
  id: "p",
  name: "Release",
  status: "Backlog",
  health: "Update missing",
  teamIds: [team.id],
  leadId: user.id,
}
function seed(projects = [project]) {
  const state = addInitiative(emptyInitiatives(), {
    ...blankInitiative(user.id),
    id: "initiative",
    name: "Growth",
    projects,
  })
  localStorage.setItem(
    initiativesStorageKey(props.workspaceId),
    JSON.stringify(state)
  )
}
const read = () =>
  JSON.parse(localStorage.getItem(initiativesStorageKey(props.workspaceId))!)
beforeEach(() => {
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe("Projects page", () => {
  it("changes the icon and color from the row without opening the project and preserves them after remount", async () => {
    seed()
    const open = vi.fn()
    const view = render(<ProjectsPage {...props} onOpenProject={open} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Change icon for Release" })
    )
    expect(screen.getByRole("tab", { name: "Icons" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Emojis" })).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Custom icon color"), {
      target: { value: "#22c55e" },
    })
    fireEvent.change(screen.getByPlaceholderText("Search icons..."), {
      target: { value: "Rocket" },
    })
    fireEvent.click(await screen.findByRole("button", { name: "Rocket 01" }))
    expect(open).not.toHaveBeenCalled()
    expect(read().initiatives[0].projects[0].icon).toEqual({
      kind: "icon",
      value: "Rocket01Icon",
      color: "#22c55e",
    })
    view.unmount()
    render(<ProjectsPage {...props} onOpenProject={open} />)
    expect(
      screen.getByRole("button", { name: "Change icon for Release" }).style
        .color
    ).toBe("rgb(34, 197, 94)")
    fireEvent.click(screen.getByRole("button", { name: /^Release$/ }))
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Release",
        icon: { kind: "icon", value: "Rocket01Icon", color: "#22c55e" },
      }),
      "overview"
    )
  })
  it("creates while initiatives are disabled and persists after remount", async () => {
    localStorage.setItem(
      initiativesSettingsStorageKey(props.workspaceId),
      JSON.stringify({ enabled: false, schedule: "none" })
    )
    const view = render(<ProjectsPage {...props} team={team} />)
    expect(
      screen.getByRole("button", { name: /Create new project/ })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "New project" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), {
      target: { value: "Ship the app" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Ship the app" })).toBeTruthy()
    )
    expect(read().workspaceProjects[0]).toMatchObject({
      name: "Ship the app",
      teamIds: [team.id],
      creatorId: user.id,
    })
    view.unmount()
    render(<ProjectsPage {...props} team={team} />)
    expect(screen.getByRole("button", { name: "Ship the app" })).toBeTruthy()
  })
  it("preserves a failed creation draft", () => {
    render(<ProjectsPage {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "New project" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), {
      target: { value: "Keep draft" },
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Project name" })
        .value
    ).toBe("Keep draft")
    expect(
      screen
        .getAllByRole("alert")
        .some((item) => item.textContent.includes("draft has been kept"))
    ).toBe(true)
    expect(
      localStorage.getItem(initiativesStorageKey(props.workspaceId))
    ).toBeNull()
  })
  it("keeps corrupt storage intact and disables writes", () => {
    localStorage.setItem(initiativesStorageKey(props.workspaceId), "broken")
    render(<ProjectsPage {...props} />)
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "New project" })
        .disabled
    ).toBe(true)
    expect(localStorage.getItem(initiativesStorageKey(props.workspaceId))).toBe(
      "broken"
    )
  })
  it("edits a shared project using inline priority controls", async () => {
    seed()
    render(<ProjectsPage {...props} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Change priority for Release" })
    )
    fireEvent.click(screen.getByRole("option", { name: "High" }))
    await waitFor(() =>
      expect(read().workspaceProjects[0].priority).toBe("High")
    )
    expect(read().initiatives[0].projects[0].priority).toBe("High")
  })
  it("counts summary categories and filters by a summary row", () => {
    seed([project, { ...project, id: "second", name: "Second", leadId: "" }])
    render(<ProjectsPage {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }))
    const summary = screen.getByRole("complementary", {
      name: "Project summary",
    })
    expect(
      within(summary).getByRole("button", { name: /No update expected.*2/ })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Initiatives" }))
    expect(
      within(summary).getByRole("button", { name: /Growth.*2/ })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Teams" }))
    expect(
      within(summary).getByRole("button", { name: /Test.*2/ })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Leads" }))
    fireEvent.click(
      within(summary).getByRole("button", { name: /Matthieu.*1/ })
    )
    expect(screen.queryByRole("button", { name: "Second" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(screen.getByRole("button", { name: "Second" })).toBeTruthy()
  })
  it("scopes teams and their saved display options", () => {
    seed([
      project,
      { ...project, id: "second", name: "Other team", teamIds: ["else"] },
    ])
    localStorage.setItem(
      projectPreferencesKey(props.workspaceId, user.id, team.id),
      JSON.stringify({ ...defaultProjectPreferences(), layout: "Board" })
    )
    render(<ProjectsPage {...props} team={team} />)
    expect(screen.getByRole("button", { name: "Release" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Other team" })).toBeNull()
    expect(screen.getByRole("heading", { name: /Backlog/ })).toBeTruthy()
    expect(
      localStorage.getItem(projectPreferencesKey(props.workspaceId, user.id))
    ).toBeNull()
  })
  it("selects rows independently and updates the selected projects across initiatives", async () => {
    seed([
      project,
      { ...project, id: "second", name: "Second" },
      { ...project, id: "third", name: "Unselected" },
    ])
    render(<ProjectsPage {...props} />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Release" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Second" }))
    expect(
      screen.getByRole("toolbar", { name: "Selected projects" }).textContent
    ).toContain("2 selected")
    fireEvent.click(
      screen.getByRole("button", { name: "Open project command menu" })
    )
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Change priority for selected projects",
      })
    )
    fireEvent.click(screen.getByRole("option", { name: "High" }))
    await waitFor(() =>
      expect(
        screen.queryByRole("toolbar", { name: "Selected projects" })
      ).toBeNull()
    )
    expect(
      read()
        .workspaceProjects.filter(
          (item: InitiativeProject) => item.priority === "High"
        )
        .map((item: InitiativeProject) => item.id)
    ).toEqual(["p", "second"])
    expect(
      read().initiatives[0].projects.map(
        (item: InitiativeProject) => item.priority
      )
    ).toEqual(["High", "High", undefined])
    expect(
      screen
        .getByRole("checkbox", { name: "Select Release" })
        .getAttribute("aria-checked")
    ).toBe("false")
  })
  it("keeps the selection and saved data if a bulk update cannot be saved", async () => {
    seed()
    const before = localStorage.getItem(
      initiativesStorageKey(props.workspaceId)
    )
    render(<ProjectsPage {...props} />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Release" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Open project command menu" })
    )
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Change status for selected projects",
      })
    )
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    fireEvent.click(screen.getByRole("option", { name: "Completed" }))
    expect(localStorage.getItem(initiativesStorageKey(props.workspaceId))).toBe(
      before
    )
    expect(
      screen.getByRole("toolbar", { name: "Selected projects" }).textContent
    ).toContain("1 selected")
    expect(screen.getByRole("alert").textContent).toContain(
      "selection has been kept"
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Clear project selection" })
    )
    expect(
      screen.queryByRole("toolbar", { name: "Selected projects" })
    ).toBeNull()
  })
  it("derives counts and progress from linked issues rather than milestones", () => {
    seed([
      {
        ...project,
        milestones: [{ id: "milestone", name: "Design", completed: true }],
      },
    ])
    const statuses = getIssueStatuses(team.id)
    const done = statuses.find((status) => status.group === "completed")!
    const todo = statuses.find((status) => status.group === "unstarted")!
    saveTeamIssue(team.id, {
      ...blankIssueDraft(done.id),
      title: "Shipped",
      project: project.id,
    })
    saveTeamIssue(team.id, {
      ...blankIssueDraft(todo.id),
      title: "Remaining",
      project: project.name,
    })
    saveTeamIssue(team.id, {
      ...blankIssueDraft(done.id),
      title: "Other work",
      project: "Other",
    })
    render(<ProjectsPage {...props} />)
    const row = screen.getByRole("row", { name: /Release/ })
    expect(within(row).getByRole("cell", { name: "2" })).toBeTruthy()
    expect(
      within(row).getByRole("button", { name: "Change status for Release" })
        .textContent
    ).toBe("50%")
  })
  it("places dated projects on the timeline and identifies undated projects", () => {
    seed([
      project,
      {
        ...project,
        id: "dated",
        name: "Scheduled",
        startDate: "2026-10-01",
        targetDate: "2027-Q1",
      },
    ])
    localStorage.setItem(
      projectPreferencesKey(props.workspaceId, user.id),
      JSON.stringify({ ...defaultProjectPreferences(), layout: "Timeline" })
    )
    render(<ProjectsPage {...props} />)
    expect(screen.getByText("No dates set")).toBeTruthy()
    expect(
      screen
        .getByRole("button", { name: "Open Scheduled" })
        .getAttribute("title")
    ).toContain("Q1 2027")
  })
  it("saves current filters as a named view", async () => {
    seed()
    render(<ProjectsPage {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }))
    fireEvent.click(await screen.findByRole("button", { name: "Status" }))
    fireEvent.click(screen.getByRole("button", { name: "Backlog" }))
    fireEvent.click(screen.getByRole("button", { name: "Add new view" }))
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Upcoming" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create view" }))
    expect(screen.getByRole("button", { name: "Upcoming" })).toBeTruthy()
    expect(
      JSON.parse(
        localStorage.getItem(projectPreferencesKey(props.workspaceId, user.id))!
      ).views[0].filters
    ).toEqual([{ field: "Status", value: "Backlog" }])
  })
})
it("opens the appropriate detail tab and keeps property editing inline", async () => {
  seed()
  const onOpenProject = vi.fn()
  render(<ProjectsPage {...props} onOpenProject={onOpenProject} />)
  fireEvent.click(
    await screen.findByRole("button", { name: "Write update for Release" })
  )
  expect(onOpenProject).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "p" }),
    "activity"
  )
  fireEvent.click(
    screen.getByRole("button", { name: "Open issues for Release" })
  )
  expect(onOpenProject).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "p" }),
    "issues"
  )
  onOpenProject.mockClear()
  fireEvent.click(
    screen.getByRole("button", { name: "Change priority for Release" })
  )
  fireEvent.click(await screen.findByRole("option", { name: "High" }))
  expect(onOpenProject).not.toHaveBeenCalled()
  expect(read().workspaceProjects[0].priority).toBe("High")
})

it("shows the first unfinished milestone next to the project name with a link to its overview", async () => {
  seed([
    {
      ...project,
      milestones: [
        { id: "done", name: "Discovery", completed: true },
        {
          id: "beta",
          name: "Beta",
          completed: false,
          targetDate: "2026-11-13",
        },
        { id: "release", name: "Release phase", completed: false },
      ],
    },
  ])
  render(<ProjectsPage {...props} />)
  const link = await screen.findByRole("link", {
    name: "Open milestone Beta for Release",
  })
  expect(link.textContent).toContain("Nov 13")
  expect(link.getAttribute("href")).toBe(
    "/projects/p?tab=overview#milestone-beta"
  )
  expect(
    screen.queryByRole("link", { name: /Open milestone Discovery/ })
  ).toBeNull()
})

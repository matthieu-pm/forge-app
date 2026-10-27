import { useState } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ProjectDetailPage } from "./project-detail"
import type { ReactNode } from "react"
import type { InitiativeProject } from "@/lib/initiatives"
import type { ProjectTab } from "./project-detail"
import type { TeamSummary } from "@/lib/team-contract"
import {
  addInitiative,
  blankInitiative,
  emptyInitiatives,
  initiativesStorageKey,
} from "@/lib/initiatives"
import { blankIssueDraft, saveTeamIssue } from "@/lib/team-issues"

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params: _params,
    search: _search,
    ...props
  }: {
    children: ReactNode
    to: string
    params?: unknown
    search?: unknown
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))
vi.mock("@/components/agent/agent-provider", () => ({
  useAgent: () => ({ openComposer: vi.fn(), setDraft: vi.fn() }),
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
const team: TeamSummary = {
  id: "team",
  slug: "forge",
  name: "Forge",
  identifier: "FOR",
  icon: { kind: "icon", value: "CubeIcon", color: "#818cf8" },
  timezone: "Europe/Paris",
  description: "",
  visibility: "workspace",
  estimationScheme: "none",
  issueEmailEnabled: false,
  detailedHistoryEnabled: false,
  createdAt: "2026-10-26T10:00:00.000Z",
}
const props = {
  workspaceId: "workspace",
  user: { id: "user", name: "Matthieu" },
  people: [],
  teams: [team],
  projectId: "project",
  onBack: vi.fn(),
}
const read = () =>
  JSON.parse(localStorage.getItem(initiativesStorageKey("workspace"))!)
function Page({ initialTab = "overview" }: { initialTab?: ProjectTab }) {
  const [tab, onTab] = useState<ProjectTab>(initialTab)
  return <ProjectDetailPage {...props} tab={tab} onTab={onTab} />
}
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  const project: InitiativeProject = {
    id: "project",
    name: "Launch",
    status: "Backlog",
    health: "Update missing",
    teamIds: [team.id],
    createdAt: "2026-10-27T10:00:00.000Z",
    creatorId: "user",
    priority: "High",
    description: null,
  }
  const state = addInitiative(emptyInitiatives(), {
    ...blankInitiative("user"),
    name: "Growth",
    projects: [project],
  })
  localStorage.setItem(
    initiativesStorageKey("workspace"),
    JSON.stringify(state)
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it("edits the canonical project, keeps initiative copies in sync, and persists milestones", async () => {
  const page = render(<Page />)
  fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), {
    target: { value: "Launch v2" },
  })
  fireEvent.blur(screen.getByRole("textbox", { name: "Project name" }))
  expect(read().workspaceProjects[0].name).toBe("Launch v2")
  expect(read().initiatives[0].projects[0].name).toBe("Launch v2")
  fireEvent.click(screen.getByRole("button", { name: "Milestone" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Milestone name" }), {
    target: { value: "Ship beta" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Add milestone" }))
  fireEvent.click(screen.getByRole("button", { name: "Actions for Ship beta" }))
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Mark complete" })
  )
  expect(read().workspaceProjects[0].milestones[0].completed).toBe(true)
  page.unmount()
  render(<Page />)
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Project name" })
      .value
  ).toBe("Launch v2")
  expect(
    screen.getByRole("textbox", { name: "Milestone name for Ship beta" })
  ).toBeTruthy()
  expect(read().workspaceProjects[0].milestones[0].completed).toBe(true)
})
it("publishes a project update and retains it after remount", async () => {
  const page = render(<Page />)
  fireEvent.click(
    screen.getByRole("button", { name: "Write first project update" })
  )
  fireEvent.change(screen.getByRole("textbox", { name: "Project update" }), {
    target: { value: "Beta is ready for the team." },
  })
  fireEvent.click(screen.getByRole("button", { name: "Post update" }))
  await screen.findByText("Beta is ready for the team.")
  expect(read().workspaceProjects[0].updates[0].text).toBe(
    "Beta is ready for the team."
  )
  expect(read().initiatives[0].projects[0].health).toBe("On track")
  page.unmount()
  render(<Page initialTab="activity" />)
  expect(await screen.findByText("Beta is ready for the team.")).toBeTruthy()
})
it("reuses the issue table while preventing unrelated issues from entering the project view", async () => {
  saveTeamIssue(
    team.id,
    { ...blankIssueDraft("todo"), title: "Launch issue", project: "project" },
    { creator: "user" }
  )
  saveTeamIssue(
    team.id,
    {
      ...blankIssueDraft("todo"),
      title: "Other project issue",
      project: "other",
    },
    { creator: "user" }
  )
  render(<Page initialTab="issues" />)
  await waitFor(() => expect(screen.getByText("Launch issue")).toBeTruthy())
  expect(screen.queryByText("Other project issue")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }))
  expect(await screen.findByRole("menuitem", { name: "Status" })).toBeTruthy()
})
it("adds resources through the shared document and link dialog", async () => {
  render(<Page />)
  fireEvent.click(screen.getByRole("button", { name: "Add document or link…" }))
  const dialog = within(screen.getByRole("dialog"))
  const fields = dialog.getAllByRole("textbox")
  fireEvent.change(fields[0], { target: { value: "Project brief" } })
  fireEvent.change(fields[1], {
    target: { value: "https://example.com/brief" },
  })
  fireEvent.click(dialog.getByRole("button", { name: /Save|Add resource/ }))
  await waitFor(() =>
    expect(read().workspaceProjects[0].resources[0].url).toBe(
      "https://example.com/brief"
    )
  )
})
it("shows live progress breakdowns and opens the matching project issues", async () => {
  saveTeamIssue(
    team.id,
    {
      ...blankIssueDraft("todo"),
      title: "Assigned work",
      project: "project",
      assignee: "user",
      labels: "Bug",
    },
    { creator: "user" }
  )
  saveTeamIssue(
    team.id,
    {
      ...blankIssueDraft("todo"),
      title: "Unassigned work",
      project: "project",
    },
    { creator: "user" }
  )
  render(<Page />)
  fireEvent.click(screen.getByRole("button", { name: "Open project details" }))
  const panel = within(
    screen.getByRole("complementary", { name: "Project sidebar" })
  )
  expect(panel.getByText("Scope")).toBeTruthy()
  expect(panel.getByText("Completed")).toBeTruthy()
  fireEvent.click(panel.getByRole("button", { name: "Labels" }))
  expect(panel.getByRole("button", { name: /Bug.*1/ })).toBeTruthy()
  fireEvent.click(panel.getByRole("button", { name: "Assignees" }))
  fireEvent.click(panel.getByRole("button", { name: /Matthieu.*1/ }))
  expect(await screen.findByText("Assigned work")).toBeTruthy()
  expect(screen.queryByText("Unassigned work")).toBeNull()
})
it("saves a Slack channel link without publishing project updates", async () => {
  render(<Page />)
  fireEvent.click(screen.getByRole("button", { name: "Open project details" }))
  fireEvent.click(screen.getByRole("button", { name: "Add channel" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Slack channel URL" }), {
    target: { value: "https://example.slack.com/archives/C123" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Save channel" }))
  await waitFor(() =>
    expect(read().workspaceProjects[0].slackChannelUrl).toBe(
      "https://example.slack.com/archives/C123"
    )
  )
  expect(read().workspaceProjects[0].updates ?? []).toEqual([])
})

it("edits milestone metadata, reorders milestones, and filters project issues from the sidebar", async () => {
  const state = read()
  state.initiatives[0].projects[0].milestones = [
    { id: "beta", name: "Beta", completed: false },
    { id: "release", name: "Release", completed: false },
  ]
  localStorage.setItem(
    initiativesStorageKey("workspace"),
    JSON.stringify(state)
  )
  saveTeamIssue(
    team.id,
    {
      ...blankIssueDraft(),
      title: "Beta work",
      project: "project",
      milestone: "beta",
    },
    { creator: "user" }
  )
  saveTeamIssue(
    team.id,
    {
      ...blankIssueDraft(),
      title: "Other work",
      project: "project",
      milestone: "release",
    },
    { creator: "user" }
  )
  render(<Page />)
  fireEvent.click(
    screen.getByRole("button", { name: "Change target date for Beta" })
  )
  fireEvent.change(screen.getByLabelText("Beta target date"), {
    target: { value: "2026-11-13" },
  })
  expect(read().workspaceProjects[0].milestones[0].targetDate).toBe(
    "2026-11-13"
  )
  const name = screen.getByRole("textbox", { name: "Milestone name for Beta" })
  fireEvent.change(name, { target: { value: "Private beta" } })
  fireEvent.blur(name)
  expect(read().workspaceProjects[0].milestones[0]).toMatchObject({
    name: "Private beta",
    aliases: ["Beta"],
    targetDate: "2026-11-13",
  })
  fireEvent.click(screen.getByRole("button", { name: "Actions for Release" }))
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move earlier" }))
  expect(
    read().workspaceProjects[0].milestones.map(
      (item: { id: string }) => item.id
    )
  ).toEqual(["release", "beta"])
  fireEvent.click(screen.getByRole("button", { name: "Open project details" }))
  const sidebar = screen.getByLabelText("Project sidebar")
  fireEvent.click(
    await within(sidebar).findByRole("button", { name: /Private beta.*1/ })
  )
  await screen.findByRole("button", { name: /Open FOR-1 Beta work/ })
  expect(screen.queryByRole("button", { name: /Open .*Other work/ })).toBeNull()
  fireEvent.click(
    screen.getByRole("button", { name: "Clear milestone filter" })
  )
  expect(
    await screen.findByRole("button", { name: /Open FOR-2 Other work/ })
  ).toBeTruthy()
})

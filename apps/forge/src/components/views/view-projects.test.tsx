import { useState } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ViewProjects } from "./view-projects"
import type { ComponentProps } from "react"
import type { InitiativeProject } from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { ViewProjectMetricGroups } from "./view-projects"
import { productStorage } from "@/lib/product-storage"
import { defaultProjectPreferences } from "@/lib/projects"
import {
  addInitiative,
  blankInitiative,
  emptyInitiatives,
  initiativesStorageKey,
} from "@/lib/initiatives"

const projection = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock("@/lib/saved-view-project-client", () => ({
  useViewProjectQuery: (...args: Array<unknown>) => projection.read(...args),
}))
vi.mock("@/components/templates/rich-editor", () => ({
  RichEditor: ({ label }: { label: string }) => (
    <div role="textbox" aria-label={label} />
  ),
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
const project: InitiativeProject = {
  id: "p",
  name: "Release",
  status: "Backlog",
  health: "Update missing",
  teamIds: [team.id],
  leadId: user.id,
}
const base = {
  workspaceId: "workspace",
  user,
  people: [user],
  teams: [team],
  filters: [],
  display: defaultProjectPreferences(),
  onFiltersChange: vi.fn(),
  onDisplayChange: vi.fn(),
}
function seed(projects = [project]) {
  const state = addInitiative(emptyInitiatives(), {
    ...blankInitiative(user.id),
    id: "initiative",
    name: "Growth",
    projects,
  })
  productStorage.setItem(
    initiativesStorageKey(base.workspaceId),
    JSON.stringify(state)
  )
}
function start(overrides: Partial<ComponentProps<typeof ViewProjects>> = {}) {
  const props = {
    ...base,
    onFiltersChange: vi.fn(),
    onDisplayChange: vi.fn(),
    ...overrides,
  }
  return { ...render(<ViewProjects {...props} />), props }
}
const read = () =>
  JSON.parse(productStorage.getItem(initiativesStorageKey(base.workspaceId))!)
beforeEach(() => {
  projection.read.mockReturnValue({
    projects: [],
    authorizedProjectIds: [],
    loading: false,
    ready: true,
    error: "",
  })
  productStorage.clear()
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe("Custom view project collection", () => {
  it("renders real projects with team and saved filter scope", () => {
    seed([
      project,
      { ...project, id: "other", name: "Other team", teamIds: ["else"] },
      { ...project, id: "high", name: "Priority project", priority: "High" },
    ])
    const page = start({
      team,
      filters: [{ field: "Priority", value: "High" }],
    })
    expect(
      screen.getByRole("button", { name: "Priority project" })
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Other team" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Priority filter" })
    )
    expect(page.props.onFiltersChange).toHaveBeenCalledWith([])
  })
  it("uses shared sortable table and controlled display options", () => {
    seed()
    const page = start()
    fireEvent.click(screen.getByRole("button", { name: "Order by Name" }))
    expect(page.props.onDisplayChange).toHaveBeenCalledWith(
      expect.objectContaining({ ordering: "Name", descending: false })
    )
    expect(read().initiatives[0].projects[0].name).toBe("Release")
  })
  it("persists shared inline project edits to every initiative copy", async () => {
    seed()
    start()
    fireEvent.click(
      screen.getByRole("button", { name: "Change priority for Release" })
    )
    fireEvent.click(screen.getByRole("option", { name: "High" }))
    await waitFor(() =>
      expect(read().workspaceProjects[0].priority).toBe("High")
    )
    expect(read().initiatives[0].projects[0].priority).toBe("High")
  })
  it("opens the existing project dialog with the selected team and saves projects", async () => {
    seed()
    start({ team })
    fireEvent.click(screen.getByRole("button", { name: "New project" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), {
      target: { value: "New custom view project" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    expect(
      await screen.findByRole("button", { name: "New custom view project" })
    ).toBeTruthy()
    expect(
      read().workspaceProjects.find(
        (item: InitiativeProject) => item.name === "New custom view project"
      )
    ).toMatchObject({ teamIds: [team.id], creatorId: user.id })
  })
  it("reports actual summary counts without a parent update loop", async () => {
    seed([project, { ...project, id: "second", name: "Second", leadId: "" }])
    let updates = 0
    function Harness() {
      const [metrics, setMetrics] = useState<ViewProjectMetricGroups>()
      return (
        <>
          <ViewProjects
            {...base}
            onMetricsChange={(value) => {
              updates += 1
              setMetrics(value)
            }}
          />
          <output aria-label="Project metrics">
            {JSON.stringify(metrics)}
          </output>
        </>
      )
    }
    render(<Harness />)
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByLabelText("Project metrics").textContent)
          .Initiatives
      ).toEqual([{ value: "initiative", count: 2, label: "Growth" }])
    )
    const metrics = JSON.parse(
      screen.getByLabelText("Project metrics").textContent
    ) as ViewProjectMetricGroups
    expect(metrics.Teams).toEqual([{ value: "team", count: 2, label: "Test" }])
    expect(metrics.Leads).toEqual(
      expect.arrayContaining([
        { value: "user", count: 1, label: "Matthieu", image: null },
      ])
    )
    expect(updates).toBeLessThan(4)
  })
})

describe("Canonical project view editor authority", () => {
  const ready = () => ({
    projects: [project],
    authorizedProjectIds: [project.id],
    loading: false,
    ready: true,
    error: "",
  })
  it.each(["loading", "error"])(
    "hides a new project draft during %s and restores its text after verification",
    async (state) => {
      seed()
      projection.read.mockReturnValue(ready())
      const page = start({ canonical: true })
      fireEvent.click(screen.getByRole("button", { name: "New project" }))
      fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), {
        target: { value: "Unsaved nested project" },
      })
      projection.read.mockReturnValue({
        projects: [],
        authorizedProjectIds: [],
        ready: false,
        loading: state === "loading",
        error: state === "error" ? "Access could not be verified" : "",
      })
      page.rerender(<ViewProjects {...page.props} />)
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull()
      projection.read.mockReturnValue(ready())
      page.rerender(<ViewProjects {...page.props} />)
      expect(
        await screen.findByRole("textbox", { name: "Project name" })
      ).toHaveProperty("value", "Unsaved nested project")
    }
  )
  it("closes an existing editor after confirmed access loss instead of restoring it on regrant", async () => {
    seed()
    projection.read.mockReturnValue(ready())
    const page = start({ canonical: true })
    fireEvent.click(screen.getByRole("button", { name: "Release" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), {
      target: { value: "Retained private title" },
    })
    projection.read.mockReturnValue({
      projects: [],
      authorizedProjectIds: [],
      loading: false,
      ready: true,
      error: "",
    })
    page.rerender(<ViewProjects {...page.props} />)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    projection.read.mockReturnValue(ready())
    page.rerender(<ViewProjects {...page.props} />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
  it("keeps an authorized editor when a filter excludes its row", () => {
    seed()
    projection.read.mockReturnValue(ready())
    const page = start({ canonical: true })
    fireEvent.click(screen.getByRole("button", { name: "Release" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), {
      target: { value: "Filtered draft" },
    })
    projection.read.mockReturnValue({ ...ready(), projects: [] })
    page.rerender(
      <ViewProjects
        {...page.props}
        filters={[{ field: "Priority", value: "High" }]}
      />
    )
    expect(
      screen.getByRole("textbox", { name: "Project name" })
    ).toHaveProperty("value", "Filtered draft")
  })
})

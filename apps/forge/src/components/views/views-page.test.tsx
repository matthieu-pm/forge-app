import { useState } from "react"
import { cleanup, fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ViewsPage } from "./views-page"
import type { ViewsSearch } from "./views-page"
import type { ViewIssuesProps } from "./view-issues"
import type { ComponentProps } from "react"
import type { ViewProjects } from "./view-projects"
import { productStorage } from "@/lib/product-storage"
import {
  readTestView,
  renderPreferences as render,
  setupPreferenceFixture,
} from "@/test/preference-fixture"
import {
  customViewsKey,
  newCustomView,
  parseCustomViews,
} from "@/lib/custom-views"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/team-icon-picker", () => ({
  TeamIconPicker: ({ label }: { label: string }) => (
    <button aria-label={label}>Icon</button>
  ),
}))
vi.mock("./view-issues", () => ({
  ViewIssues: ({
    filters,
    display,
    onFiltersChange,
    onDisplayChange,
    toolbarActions,
  }: ViewIssuesProps) => (
    <div>
      <output data-testid="issue-config">
        {JSON.stringify({ filters, display })}
      </output>
      <button
        onClick={() =>
          onFiltersChange({
            match: "all",
            rules: [
              {
                id: "priority",
                field: "priority",
                operator: "is",
                value: "High",
              },
            ],
          })
        }
      >
        Filter high priority issues
      </button>
      <button onClick={() => onDisplayChange({ ...display, layout: "board" })}>
        Use issue board
      </button>
      {toolbarActions}
    </div>
  ),
}))
vi.mock("./view-projects", () => ({
  ViewProjects: ({
    filters,
    display,
    onFiltersChange,
    onDisplayChange,
    toolbarActions,
  }: ComponentProps<typeof ViewProjects>) => (
    <div>
      <output data-testid="project-config">
        {JSON.stringify({ filters, display })}
      </output>
      <button
        onClick={() =>
          onFiltersChange([{ field: "Status", value: "In Progress" }])
        }
      >
        Filter active projects
      </button>
      <button
        onClick={() => onDisplayChange({ ...display, layout: "Timeline" })}
      >
        Use project timeline
      </button>
      {toolbarActions}
    </div>
  ),
}))

const user = { id: "user", name: "Matthieu", image: null }
const props = { workspaceId: "workspace", user, people: [user], teams: [] }
const navigate = vi.fn()
function Harness({ initial = { kind: "issues" } }: { initial?: ViewsSearch }) {
  const [search, setSearch] = useState(initial)
  return (
    <ViewsPage
      {...props}
      search={search}
      onNavigate={(next) => {
        navigate(next)
        setSearch(next)
      }}
    />
  )
}
const read = () =>
  parseCustomViews(
    productStorage.getItem(customViewsKey(props.workspaceId, user.id))
  ).views
const issueConfig = () =>
  JSON.parse(screen.getByTestId("issue-config").textContent)
const projectConfig = () =>
  JSON.parse(screen.getByTestId("project-config").textContent)
const changeName = (name: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
    target: { value: name },
  })
async function openOptions(action: string) {
  fireEvent.click(screen.getAllByRole("button", { name: "View options" })[0])
  fireEvent.click(await screen.findByRole("button", { name: action }))
}
beforeEach(async () => {
  await setupPreferenceFixture("user")
  productStorage.clear()
  vi.clearAllMocks()
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
  vi.unstubAllGlobals()
})

describe("Views pages", () => {
  it("creates from the directory with the preview configuration and reopens the saved view after remount", async () => {
    const mounted = render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Create new view" }))
    changeName("High priority work")
    fireEvent.change(
      screen.getByRole("textbox", { name: "View description" }),
      { target: { value: "Watch urgent work" } }
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Filter high priority issues" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Use issue board" }))
    expect(read()).toEqual([])
    fireEvent.click(screen.getByRole("button", { name: "Create view" }))
    const saved = read()[0]
    expect(saved).toMatchObject({
      name: "High priority work",
      description: "Watch urgent work",
      kind: "issues",
      filters: { rules: [{ value: "High" }] },
      display: { layout: "board" },
    })
    expect(navigate).toHaveBeenLastCalledWith({
      kind: "issues",
      view: saved.id,
    })
    mounted.unmount()
    render(<Harness initial={{ kind: "issues", view: saved.id }} />)
    expect(issueConfig().filters.rules[0].value).toBe("High")
    expect(issueConfig().display.layout).toBe("board")
    expect(
      screen.getByRole("heading", { level: 1, name: "High priority work" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Views" }))
    expect(
      await screen.findByRole("link", { name: "High priority work" })
    ).toBeTruthy()
  })

  it("edits a saved view as a draft, cancels without saving, then commits subsequent edits", async () => {
    const saved = newCustomView("issues", user.id)
    productStorage.setItem(
      customViewsKey(props.workspaceId, user.id),
      JSON.stringify({ version: 1, views: [saved] })
    )
    render(<Harness initial={{ kind: "issues", view: saved.id }} />)
    await openOptions("Edit view…")
    changeName("Discard this edit")
    fireEvent.click(
      screen.getByRole("button", { name: "Filter high priority issues" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(read()[0].name).toBe("All issues")
    expect(issueConfig().filters.rules).toEqual([])
    await openOptions("Edit view…")
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "View name" }).value
    ).toBe("All issues")
    changeName("Saved edit")
    fireEvent.click(screen.getByRole("button", { name: "Save view" }))
    expect(read()).toHaveLength(1)
    expect(read()[0]).toMatchObject({ id: saved.id, name: "Saved edit" })
  })

  it("duplicates all filter and display settings into an independent unsaved draft", async () => {
    const source = newCustomView("projects", user.id)
    source.name = "Current roadmap"
    source.favorite = true
    source.description = "Planning view"
    source.filters = [{ field: "Priority", value: "High" }]
    source.display.layout = "Timeline"
    productStorage.setItem(
      customViewsKey(props.workspaceId, user.id),
      JSON.stringify({ version: 1, views: [source] })
    )
    render(<Harness initial={{ kind: "projects", view: source.id }} />)
    await openOptions("Duplicate view…")
    expect(read()).toHaveLength(1)
    expect(projectConfig()).toEqual({
      filters: source.filters,
      display: source.display,
    })
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "View name" }).value
    ).toBe("Current roadmap (copy)")
    fireEvent.click(screen.getByRole("button", { name: "Create view" }))
    expect(read()).toHaveLength(2)
    expect(read()[1]).toMatchObject({
      name: "Current roadmap (copy)",
      description: "Planning view",
      favorite: false,
      filters: source.filters,
      display: source.display,
    })
    expect(read()[1].id).not.toBe(source.id)
    expect(read()[0]).toEqual(source)
  })

  it("switches the draft type, retaining entered metadata but replacing incompatible configuration", () => {
    render(<Harness initial={{ kind: "issues", view: "new" }} />)
    changeName("My delivery view")
    fireEvent.click(
      screen.getByRole("button", { name: "Filter high priority issues" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Projects" }))
    expect(projectConfig().filters).toEqual([])
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "View name" }).value
    ).toBe("My delivery view")
    fireEvent.click(
      screen.getByRole("button", { name: "Filter active projects" })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Use project timeline" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Create view" }))
    expect(read()[0]).toMatchObject({
      kind: "projects",
      name: "My delivery view",
      filters: [{ field: "Status", value: "In Progress" }],
      display: { layout: "Timeline" },
    })
  })

  it("keeps issue and project directory tabs separate", async () => {
    const issues = { ...newCustomView("issues", user.id), name: "Bugs" }
    const projects = { ...newCustomView("projects", user.id), name: "Roadmap" }
    productStorage.setItem(
      customViewsKey(props.workspaceId, user.id),
      JSON.stringify({ version: 1, views: [issues, projects] })
    )
    render(<Harness />)
    expect(screen.getByRole("link", { name: "Bugs" })).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Roadmap" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Projects" }))
    expect(await screen.findByRole("link", { name: "Roadmap" })).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Bugs" })).toBeNull()
  })

  it("persists favorites and only removes the selected view after confirming deletion", async () => {
    const first = { ...newCustomView("issues", user.id), name: "Watch list" }
    const second = { ...newCustomView("issues", user.id), name: "Other list" }
    productStorage.setItem(
      customViewsKey(props.workspaceId, user.id),
      JSON.stringify({ version: 1, views: [first, second] })
    )
    render(<Harness initial={{ kind: "issues", view: first.id }} />)
    fireEvent.click(
      screen.getAllByRole("button", { name: "Add to favorites" })[0]
    )
    expect(readTestView("directory").favoriteIds).toContain(first.id)
    await openOptions("Delete view…")
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(read()).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(read()).toHaveLength(2)
    await openOptions("Delete view…")
    fireEvent.click(screen.getByRole("button", { name: "Delete view" }))
    expect(read()).toEqual([second])
    expect(navigate).toHaveBeenLastCalledWith({ kind: "issues" })
    expect(await screen.findByRole("link", { name: "Other list" })).toBeTruthy()
  })

  it("disables saving when existing storage is corrupt and preserves the unreadable value", () => {
    const key = customViewsKey(props.workspaceId, user.id)
    productStorage.setItem(key, "{damaged")
    render(<Harness initial={{ kind: "issues", view: "new" }} />)
    expect(screen.getByRole("alert").textContent).toContain("preserved")
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Create view" })
        .disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Create view" }))
    expect(productStorage.getItem(key)).toBe("{damaged")
    expect(navigate).not.toHaveBeenCalled()
  })
})

import { useState } from "react"
import {
  act,
  cleanup,
  fireEvent,
  isInaccessible,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ViewsPage } from "./views-page"
import type { ViewsSearch } from "./views-page"
import type { ViewIssuesProps } from "./view-issues"
import type { ComponentProps } from "react"
import type { ViewProjects } from "./view-projects"
import { productStorage } from "@/lib/product-storage"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"
import { invalidatePreferenceSession } from "@/lib/preference-session-events"
import {
  renderPreferences as render,
  setupPreferenceFixture,
} from "@/test/preference-fixture"
import { newCustomView } from "@/lib/custom-views"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

const transport = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }))
vi.mock("@/lib/saved-view-functions", () => ({
  loadSavedViews: transport.load,
  persistSavedView: transport.save,
}))

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
  ViewProjects: function ProjectPreview({
    filters,
    display,
    onFiltersChange,
    onDisplayChange,
    toolbarActions,
  }: ComponentProps<typeof ViewProjects>) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState("")
    return (
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
        <button onClick={() => setEditing(true)}>
          Open nested project editor
        </button>
        <Popover>
          <PopoverTrigger render={<button>Open project filter</button>} />
          <PopoverContent>
            <p>Private project filter option</p>
          </PopoverContent>
        </Popover>
        <Dialog open={editing} onOpenChange={setEditing}>
          <DialogContent>
            <DialogTitle>Nested project editor</DialogTitle>
            <input
              aria-label="Nested project draft"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </DialogContent>
        </Dialog>
        {toolbarActions}
      </div>
    )
  },
}))

const user = { id: "user", name: "Matthieu", image: null }
const identity = {
  workspaceId: "workspace",
  userId: "user",
  sessionId: "session",
}
const props = { workspaceId: "workspace", user, people: [user], teams: [] }
const saved = {
  ...newCustomView("issues", user.id),
  name: "Shared view",
  visibility: "workspace" as const,
  revision: 1,
  canEdit: true,
}
function Harness({ initial = { kind: "issues" } }: { initial?: ViewsSearch }) {
  const [search, setSearch] = useState(initial)
  return <ViewsPage {...props} search={search} onNavigate={setSearch} />
}
beforeEach(async () => {
  productStorage.clear()
  await setupPreferenceFixture("user")
  invalidatePreferenceSession("start")
  replaceCanonicalIssues({ ...identity, records: [], projects: [], cycles: [] })
  transport.load
    .mockReset()
    .mockResolvedValue(
      JSON.stringify({ ...identity, enabled: true, views: [saved], error: "" })
    )
  transport.save.mockReset().mockResolvedValue({})
})
afterEach(() => {
  cleanup()
  invalidatePreferenceSession("start")
  replaceCanonicalIssues(null)
})
describe("FOR-60 saved view interactions", () => {
  it("creates with an explicit acknowledged save and keeps filters in the draft", async () => {
    render(<Harness />)
    await screen.findByRole("link", { name: "Shared view" })
    fireEvent.click(screen.getByRole("button", { name: "New view" }))
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "High priority" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Filter high priority issues" })
    )
    expect(transport.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Create view" }))
    await waitFor(() => expect(transport.save).toHaveBeenCalledOnce())
    expect(transport.save.mock.calls[0][0].data.mutation).toMatchObject({
      action: "save",
      expectedRevision: null,
      definition: {
        name: "High priority",
        filters: { rules: [{ field: "priority", value: "High" }] },
      },
    })
  })
  it("browsing filters stay temporary while favorites use the actor-owned command", async () => {
    render(<Harness initial={{ kind: "issues", view: saved.id }} />)
    await screen.findByTestId("issue-config")
    fireEvent.click(
      screen.getByRole("button", { name: "Filter high priority issues" })
    )
    expect(transport.save).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getAllByRole("button", { name: "Add to favorites" })[0]
    )
    await waitFor(() => expect(transport.save).toHaveBeenCalledOnce())
    expect(transport.save.mock.calls[0][0].data.mutation).toEqual({
      action: "favorite",
      id: saved.id,
      favorite: true,
    })
  })
  it("readers cannot enter the shared editor or change ownership", async () => {
    transport.load.mockResolvedValue(
      JSON.stringify({
        ...identity,
        enabled: true,
        views: [{ ...saved, ownerId: "alice", canEdit: false }],
        error: "",
      })
    )
    render(<Harness initial={{ kind: "issues", view: saved.id, edit: true }} />)
    await screen.findByTestId("issue-config")
    expect(screen.queryByRole("textbox", { name: "View name" })).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Change view visibility" })
    ).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Change view owner" })
    ).toBeNull()
  })
  it("preserves failed edit drafts and allows a retry", async () => {
    transport.save.mockRejectedValueOnce(
      new Error("Conflict: review the latest view")
    )
    render(<Harness initial={{ kind: "issues", view: saved.id, edit: true }} />)
    await screen.findByRole("textbox", { name: "View name" })
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "My edit" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save view" }))
    await screen.findByRole("alert")
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveProperty(
      "value",
      "My edit"
    )
    expect(
      screen.getByRole("button", { name: "Save view" }).hasAttribute("disabled")
    ).toBe(false)
  })
  it("retains an unsaved edit and its revision through a failed refresh and recovery", async () => {
    render(<Harness initial={{ kind: "issues", view: saved.id, edit: true }} />)
    await screen.findByRole("textbox", { name: "View name" })
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "My retained draft" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Filter high priority issues" })
    )
    transport.load.mockRejectedValueOnce(new Error("Network unavailable"))
    fireEvent.focus(window)
    await screen.findByText(
      "Saved views are unavailable. Refresh to try again."
    )
    expect(screen.queryByRole("textbox", { name: "View name" })).toBeNull()
    expect(isInaccessible(screen.getByTestId("issue-config"))).toBe(true)
    transport.load.mockResolvedValue(
      JSON.stringify({
        ...identity,
        enabled: true,
        views: [{ ...saved, name: "Changed remotely", revision: 2 }],
        error: "",
      })
    )
    fireEvent.focus(window)
    const input = await screen.findByRole("textbox", { name: "View name" })
    expect(input).toHaveProperty("value", "My retained draft")
    fireEvent.click(screen.getByRole("button", { name: "Save view" }))
    await waitFor(() => expect(transport.save).toHaveBeenCalledOnce())
    expect(transport.save.mock.calls[0][0].data.mutation).toMatchObject({
      expectedRevision: 1,
      definition: {
        name: "My retained draft",
        filters: { rules: [{ field: "priority", value: "High" }] },
      },
    })
  })
  it("preserves a nested project editor while hiding all protected content during reauthorization", async () => {
    const projectView = {
      ...newCustomView("projects", user.id),
      name: "Saved projects",
      revision: 1,
      canEdit: true,
    }
    const directory = JSON.stringify({
      ...identity,
      enabled: true,
      views: [projectView],
      error: "",
    })
    transport.load.mockResolvedValue(directory)
    render(<Harness initial={{ kind: "projects", view: projectView.id }} />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Open nested project editor" })
    )
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Nested project draft" }),
      { target: { value: "Unsubmitted project changes" } }
    )
    let resolve!: (value: string) => void
    transport.load.mockReturnValueOnce(
      new Promise<string>((done) => {
        resolve = done
      })
    )
    act(() =>
      replaceCanonicalIssues({
        ...identity,
        records: [],
        projects: [],
        cycles: [],
      })
    )
    await screen.findByText("Loading saved views…")
    expect(screen.queryByRole("heading", { name: "Saved projects" })).toBeNull()
    expect(
      screen.queryByRole("textbox", { name: "Nested project draft" })
    ).toBeNull()
    expect(
      screen.queryByRole("dialog", { name: "Nested project editor" })
    ).toBeNull()
    await act(async () => {
      resolve(directory)
      await Promise.resolve()
    })
    expect(
      await screen.findByRole("textbox", { name: "Nested project draft" })
    ).toHaveProperty("value", "Unsubmitted project changes")
    transport.load.mockRejectedValueOnce(new Error("Temporary refresh failure"))
    fireEvent.focus(window)
    await screen.findByText(
      "Saved views are unavailable. Refresh to try again."
    )
    expect(
      screen.queryByRole("textbox", { name: "Nested project draft" })
    ).toBeNull()
    expect(
      screen.queryByRole("dialog", { name: "Nested project editor" })
    ).toBeNull()
    transport.load.mockResolvedValueOnce(directory)
    fireEvent.focus(window)
    expect(
      await screen.findByRole("textbox", { name: "Nested project draft" })
    ).toHaveProperty("value", "Unsubmitted project changes")
    // A definitive missing view retires the nested state, unlike a pending read.
    transport.load.mockResolvedValueOnce(
      JSON.stringify({ ...identity, enabled: true, views: [], error: "" })
    )
    act(() =>
      replaceCanonicalIssues({
        ...identity,
        records: [],
        projects: [],
        cycles: [],
      })
    )
    await screen.findByText("This view could not be found.")
    expect(
      screen.queryByRole("textbox", {
        name: "Nested project draft",
        hidden: true,
      })
    ).toBeNull()
    transport.load.mockResolvedValueOnce(directory)
    fireEvent.focus(window)
    fireEvent.click(
      await screen.findByRole("button", { name: "Open nested project editor" })
    )
    expect(
      await screen.findByRole("textbox", { name: "Nested project draft" })
    ).toHaveProperty("value", "")
  })
  it("hides portalled filter content on read failure and drops it when the feature is disabled", async () => {
    const projectView = {
      ...newCustomView("projects", user.id),
      name: "Scoped project view",
      revision: 1,
      canEdit: true,
    }
    const directory = JSON.stringify({
      ...identity,
      enabled: true,
      views: [projectView],
      error: "",
    })
    transport.load.mockResolvedValue(directory)
    render(<Harness initial={{ kind: "projects", view: projectView.id }} />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Open project filter" })
    )
    await waitFor(() =>
      expect(
        isInaccessible(screen.getByText("Private project filter option"))
      ).toBe(false)
    )
    transport.load.mockRejectedValueOnce(new Error("Temporary read failure"))
    fireEvent.focus(window)
    await screen.findByText(
      "Saved views are unavailable. Refresh to try again."
    )
    expect(
      isInaccessible(screen.getByText("Private project filter option"))
    ).toBe(true)
    expect(screen.queryByRole("heading", { name: projectView.name })).toBeNull()
    transport.load.mockResolvedValueOnce(directory)
    fireEvent.focus(window)
    await waitFor(() =>
      expect(
        isInaccessible(screen.getByText("Private project filter option"))
      ).toBe(false)
    )
    transport.load.mockResolvedValueOnce(
      JSON.stringify({ ...identity, enabled: false, views: [], error: "" })
    )
    fireEvent.focus(window)
    await screen.findByText("Saved views are not enabled for this environment.")
    expect(screen.queryByText("Private project filter option")).toBeNull()
    transport.load.mockResolvedValueOnce(directory)
    fireEvent.focus(window)
    await screen.findByRole("button", { name: "Open project filter" })
    expect(screen.queryByText("Private project filter option")).toBeNull()
  })
  it("keeps the original revision when changing an existing view type", async () => {
    render(<Harness initial={{ kind: "issues", view: saved.id, edit: true }} />)
    await screen.findByRole("textbox", { name: "View name" })
    fireEvent.click(screen.getByRole("button", { name: "Projects" }))
    fireEvent.click(screen.getByRole("button", { name: "Save view" }))
    await waitFor(() => expect(transport.save).toHaveBeenCalledOnce())
    expect(transport.save.mock.calls[0][0].data.mutation).toMatchObject({
      id: saved.id,
      expectedRevision: 1,
      definition: { kind: "projects" },
    })
  })
  it("duplicates a readable shared view as a new private definition", async () => {
    render(<Harness initial={{ kind: "issues", view: saved.id }} />)
    await screen.findByTestId("issue-config")
    fireEvent.click(screen.getAllByRole("button", { name: "View options" })[0])
    fireEvent.click(
      await screen.findByRole("button", { name: "Duplicate view…" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Create view" }))
    await waitFor(() => expect(transport.save).toHaveBeenCalledOnce())
    expect(transport.save.mock.calls[0][0].data.mutation).toMatchObject({
      expectedRevision: null,
      definition: { name: "Shared view (copy)", visibility: "personal" },
    })
    expect(transport.save.mock.calls[0][0].data.mutation.id).not.toBe(saved.id)
  })
  it("the disabled gate exposes no create or saved-view content", async () => {
    transport.load.mockResolvedValue(
      JSON.stringify({ ...identity, enabled: false, views: [], error: "" })
    )
    render(<Harness />)
    await screen.findByText("Saved views are not enabled for this environment.")
    expect(
      screen.getByRole("button", { name: "New view" }).hasAttribute("disabled")
    ).toBe(true)
    expect(screen.queryByRole("link", { name: "Shared view" })).toBeNull()
  })
})

it("FOR-60 review: keeps an unsaved edit draft after a failed background refresh recovers", async () => {
  render(<Harness initial={{ kind: "issues", view: saved.id, edit: true }} />)
  const name = await screen.findByRole("textbox", { name: "View name" })
  fireEvent.change(name, { target: { value: "Unsaved review draft" } })
  fireEvent.click(
    screen.getByRole("button", { name: "Filter high priority issues" })
  )
  transport.load.mockRejectedValueOnce(new Error("Temporary read failure"))
  act(() => window.dispatchEvent(new Event("focus")))
  await screen.findByText(
    "Saved views could not be loaded. Refresh to try again."
  )
  transport.load.mockResolvedValueOnce(
    JSON.stringify({
      ...identity,
      enabled: true,
      views: [{ ...saved, name: "Newer shared name", revision: 2 }],
      error: "",
    })
  )
  act(() => window.dispatchEvent(new Event("focus")))
  const recovered = await screen.findByRole("textbox", { name: "View name" })
  expect((recovered as HTMLInputElement).value).toBe("Unsaved review draft")
  expect(screen.getByTestId("issue-config").textContent).toContain("High")
  fireEvent.click(screen.getByRole("button", { name: "Save view" }))
  await waitFor(() => expect(transport.save).toHaveBeenCalledOnce())
  expect(transport.save.mock.calls[0][0].data.mutation).toMatchObject({
    expectedRevision: 1,
    definition: { name: "Unsaved review draft" },
  })
})

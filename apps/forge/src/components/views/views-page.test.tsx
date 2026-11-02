import { useState } from "react"
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
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

import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceProjectTemplates } from "./workspace-project-templates"
import { TemplateEditor } from "./template-editor"
import { useTemplateLabels } from "./template-controls"
import type { SavedTemplate, TemplateDirectory } from "@/lib/template-contract"
import {
  projectLabelsStorageKey,
  workspaceLabelsStorageKey,
} from "@/lib/team-labels"
import { deleteTemplate, saveTemplate } from "@/lib/template-state"
import { emptyTemplate } from "@/lib/template-contract"

vi.mock("@/lib/template-state", () => ({
  saveTemplate: vi.fn().mockResolvedValue({ id: "saved" }),
  deleteTemplate: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock("./rich-editor", () => ({
  RichEditor: () => null,
  insertFiles: vi.fn(),
}))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => null,
}))
const directory: TemplateDirectory = {
  templates: [],
  teams: [],
  members: [],
  defaults: { members: null, nonMembers: null },
  canManage: true,
}
function record(kind: "issue" | "project", name: string): SavedTemplate {
  return {
    id: kind,
    payload: { ...emptyTemplate(kind), name },
    createdBy: "Owner",
    createdAt: "2026-10-12T10:00:00Z",
    updatedAt: "2026-10-12T10:00:00Z",
  }
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})
async function setup(data = directory) {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
  const root = createRootRoute()
  const list = createRoute({
    getParentRoute: () => root,
    path: "/settings/project-templates",
    component: () => <WorkspaceProjectTemplates directory={data} />,
  })
  const editor = createRoute({
    getParentRoute: () => root,
    path: "/settings/templates/project/$templateId",
    component: () => (
      <TemplateEditor
        workspace
        kind="project"
        directory={data}
        saved={data.templates.find(
          (t) => t.id === editor.useParams().templateId
        )}
      />
    ),
  })
  const router = createRouter({
    routeTree: root.addChildren([list, editor]),
    history: createMemoryHistory({
      initialEntries: ["/settings/project-templates"],
    }),
  })
  render(<RouterProvider router={router} />)
  await screen.findByRole("heading", { name: "Project templates" })
  return router
}
describe("Workspace project template flow", () => {
  it("opens the project editor, validates, saves in workspace scope and returns to the list", async () => {
    const router = await setup()
    fireEvent.click(
      screen.getByRole("link", { name: "Create new project template" })
    )
    await screen.findByRole("heading", { name: "New project template" })
    expect(
      screen.getByRole("button", { name: "Template visibility" }).textContent
    ).toContain("Workspace")
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }))
    expect(saveTemplate).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole("textbox", { name: "Template name" }), {
      target: { value: "Product launch" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), {
      target: { value: "Launch" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: "Project summary" }), {
      target: { value: "Ship a product" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }))
    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          slug: undefined,
          payload: expect.objectContaining({
            kind: "project",
            name: "Product launch",
            title: "Launch",
            summary: "Ship a product",
            visibility: "",
          }),
        }),
      })
    )
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/project-templates")
    )
  })
  it("shows only project templates and edits the saved revision", async () => {
    const saved = record("project", "Launch plan")
    const router = await setup({
      ...directory,
      templates: [saved, record("issue", "Bug report")],
    })
    expect(screen.queryByText("Bug report")).toBeNull()
    fireEvent.click(screen.getByRole("link", { name: /Launch plan/ }))
    await screen.findByRole("heading", { name: "Edit project template" })
    fireEvent.change(screen.getByRole("textbox", { name: "Template name" }), {
      target: { value: "Updated launch" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: saved.id,
          updatedAt: saved.updatedAt,
          payload: expect.objectContaining({ name: "Updated launch" }),
        }),
      })
    )
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/project-templates")
    )
  })
  it("retains the draft if saving fails", async () => {
    vi.mocked(saveTemplate).mockRejectedValueOnce(
      new Error("This template changed in another window.")
    )
    await setup()
    fireEvent.click(
      screen.getByRole("link", { name: "Create new project template" })
    )
    const input = await screen.findByRole("textbox", { name: "Template name" })
    fireEvent.change(input, { target: { value: "Keep this draft" } })
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }))
    expect((await screen.findByRole("alert")).textContent).toContain(
      "another window"
    )
    expect((input as HTMLInputElement).value).toBe("Keep this draft")
  })
  it("requires confirmation to delete and hides management actions for readers", async () => {
    await setup({ ...directory, templates: [record("project", "Launch")] })
    fireEvent.click(screen.getByRole("button", { name: "Delete Launch" }))
    await screen.findByRole("dialog")
    expect(deleteTemplate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Delete template" }))
    await waitFor(() =>
      expect(deleteTemplate).toHaveBeenCalledWith({ data: { id: "project" } })
    )
    cleanup()
    await setup({
      ...directory,
      canManage: false,
      templates: [record("project", "Launch")],
    })
    expect(
      screen.queryByRole("link", { name: "Create new project template" })
    ).toBeNull()
    expect(screen.queryByRole("button", { name: "Delete Launch" })).toBeNull()
  })
  it("uses project labels rather than workspace issue labels", async () => {
    const label = {
      id: "launch",
      name: "Launch",
      description: "",
      color: "#5e6ad2",
      groupId: null,
      issues: 0,
      lastApplied: null,
      createdAt: "2026-10-12T10:00:00Z",
    }
    const labels = {
      version: 1,
      groups: [],
      inheritedCount: 0,
      labels: [label],
    }
    localStorage.setItem(projectLabelsStorageKey, JSON.stringify(labels))
    localStorage.setItem(
      workspaceLabelsStorageKey,
      JSON.stringify({
        ...labels,
        labels: [{ ...label, id: "bug", name: "Bug" }],
      })
    )
    const { result } = renderHook(() => useTemplateLabels(undefined, true))
    await waitFor(() =>
      expect(result.current.map((option) => option.label)).toEqual(["Launch"])
    )
  })
  it("adds milestones to the saved payload and protects unsaved changes on cancel", async () => {
    await setup()
    fireEvent.click(
      screen.getByRole("link", { name: "Create new project template" })
    )
    const name = await screen.findByRole("textbox", { name: "Template name" })
    fireEvent.change(name, { target: { value: "Launch" } })
    fireEvent.click(screen.getByRole("button", { name: "Add milestone" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Milestone name" }), {
      target: { value: "Kickoff" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add milestone" }))
    expect(screen.getByRole("button", { name: "Kickoff" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }))
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" })
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
    fireEvent.click(await screen.findByRole("button", { name: /^Create$/ }))
    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            milestones: [expect.objectContaining({ title: "Kickoff" })],
          }),
        }),
      })
    )
  })
})

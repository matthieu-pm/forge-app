import {
  cleanup,
  fireEvent,
  render,
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
import { WorkspaceIssueTemplates } from "./workspace-issue-templates"
import { TemplateEditor } from "./template-editor"
import { saveTemplate } from "@/lib/template-state"

vi.mock("@/lib/template-state", () => ({
  saveTemplate: vi.fn().mockResolvedValue({ id: "saved" }),
  deleteTemplate: vi.fn(),
}))
vi.mock("./rich-editor", () => ({
  RichEditor: () => null,
  insertFiles: vi.fn(),
}))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => null,
}))
const directory = {
  templates: [],
  teams: [],
  members: [],
  defaults: { members: null, nonMembers: null },
  canManage: true,
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
async function setup() {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
  const root = createRootRoute()
  const list = createRoute({
    getParentRoute: () => root,
    path: "/settings/issue-templates",
    component: () => <WorkspaceIssueTemplates directory={directory} />,
  })
  const editor = createRoute({
    getParentRoute: () => root,
    path: "/settings/templates/issue/$templateId",
    validateSearch: (s: Record<string, unknown>) => ({
      form: s.form === true || s.form === "true",
    }),
    component: () => (
      <TemplateEditor
        workspace
        kind="issue"
        directory={directory}
        form={editor.useSearch().form}
      />
    ),
  })
  const router = createRouter({
    routeTree: root.addChildren([list, editor]),
    history: createMemoryHistory({
      initialEntries: ["/settings/issue-templates"],
    }),
  })
  render(<RouterProvider router={router} />)
  await screen.findByRole("heading", { name: "No issue templates" })
  return router
}
describe("workspace issue template flow", () => {
  it("opens Standard, validates the name, saves without a team, and returns to the list", async () => {
    const router = await setup()
    fireEvent.click(
      screen.getByRole("button", { name: "Create new issue template" })
    )
    fireEvent.click(
      await screen.findByRole("button", { name: /Standard Basic/ })
    )
    const name = await screen.findByRole("textbox", { name: "Template name" })
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }))
    expect(saveTemplate).not.toHaveBeenCalled()
    fireEvent.change(name, { target: { value: "Bug report" } })
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Bug:" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^Create$/ }))
    await waitFor(() =>
      expect(saveTemplate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          slug: undefined,
          payload: expect.objectContaining({
            name: "Bug report",
            title: "Bug:",
            issueType: "standard",
            properties: expect.objectContaining({ teamIds: [] }),
          }),
        }),
      })
    )
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/issue-templates")
    )
  })
  it("routes the custom form choice into the shared form builder", async () => {
    await setup()
    fireEvent.click(
      screen.getByRole("button", { name: "Create new issue template" })
    )
    fireEvent.click(
      await screen.findByRole("button", { name: /Custom Form Define/ })
    )
    await screen.findByRole("textbox", { name: "Template name" })
    expect(screen.getByRole("button", { name: /Add field/ })).toBeTruthy()
  })
})

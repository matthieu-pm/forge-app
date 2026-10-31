import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { InitiativeProject } from "@/lib/initiatives"
import { ProjectDialog } from "@/components/initiatives/initiative-projects"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"

vi.mock("@/components/templates/rich-editor", () => ({
  RichEditor: () => <div />,
}))
vi.mock("@hugeicons/core-free-icons?catalog", () => ({
  CubeIcon: [],
  Rocket01Icon: [],
}))
const project: InitiativeProject = {
  id: "00000000-0000-4000-8000-000000000001",
  revision: 2,
  name: "Private project name",
  summary: "Original summary",
  status: "Planned",
  health: "Update missing",
  teamIds: [],
}
const props = {
  project,
  catalog: [project],
  people: [],
  teams: [],
  labels: [],
  onSave: vi.fn(() => true),
  onClose: vi.fn(),
  onAsk: vi.fn(),
}
beforeEach(() => {
  props.onSave.mockClear()
  replaceCanonicalIssues({
    workspaceId: "workspace",
    userId: "user",
    sessionId: "session",
    records: [],
    cycles: [],
    projects: [
      {
        id: project.id,
        name: project.name,
        revision: 2,
        legacyId: null,
        properties: project,
      },
    ],
  })
})
afterEach(() => {
  cleanup()
  replaceCanonicalIssues(null, false)
})
it("retains an open form and rejects stale save after the catalog refreshes", () => {
  const view = render(<ProjectDialog {...props} />)
  fireEvent.change(screen.getByRole("textbox", { name: "Project summary" }), {
    target: { value: "My unsaved summary" },
  })
  view.rerender(
    <ProjectDialog
      {...props}
      catalog={[{ ...project, revision: 3, summary: "Bob's shared summary" }]}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "Save project" }))
  expect(props.onSave).not.toHaveBeenCalled()
  expect(screen.getByRole("alert").textContent).toContain(
    "changed while you were editing"
  )
  expect(
    screen.getByRole<HTMLInputElement>("textbox", {
      name: "Project summary",
    }).value
  ).toBe("My unsaved summary")
})
it("hides an already open private form when its project becomes unavailable", () => {
  const view = render(<ProjectDialog {...props} />)
  view.rerender(<ProjectDialog {...props} catalog={[]} />)
  expect(
    screen.getByRole("heading", { name: "Project unavailable" })
  ).toBeTruthy()
  expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull()
  expect(screen.queryByDisplayValue("Private project name")).toBeNull()
})

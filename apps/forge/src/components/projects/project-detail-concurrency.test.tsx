import { act, cleanup, fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ProjectDetailPage } from "./project-detail"
import type { ReactNode } from "react"
import type * as IssueQueries from "@/lib/issue-query-client"
import type { InitiativeProject } from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"
import {
  initializeProductStorage,
  resetProductStorage,
} from "@/lib/product-storage"
import { persistProductState } from "@/lib/product-state-server"
import {
  renderPreferences as render,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock("@/components/agent/agent-provider", () => ({
  useAgent: () => ({ openComposer: vi.fn(), setDraft: vi.fn() }),
}))
vi.mock("@/lib/product-state-server", () => ({
  loadProductState: vi.fn(),
  persistProductState: vi.fn(),
}))
vi.mock("@/lib/issue-query-client", async (original) => ({
  ...(await original<typeof IssueQueries>()),
  useIssueQuery: () => ({ enabled: false, page: undefined, error: "" }),
}))
vi.mock("@/components/templates/rich-editor", () => ({
  RichEditor: ({
    value,
    onChange,
    label,
  }: {
    value: unknown
    onChange: (value: unknown) => void
    label: string
  }) => (
    <textarea
      aria-label={label}
      value={JSON.stringify(value)}
      onChange={(event) => onChange(JSON.parse(event.target.value))}
    />
  ),
}))
const identity = {
  workspaceId: "workspace",
  userId: "user",
  sessionId: "session",
}
const project: InitiativeProject = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Shared plan",
  summary: "Shared summary",
  revision: 1,
  status: "Planned",
  health: "Update missing",
  teamIds: [],
}
const team: TeamSummary = {
  id: "00000000-0000-4000-8000-000000000002",
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
function install(current: InitiativeProject) {
  replaceCanonicalIssues({
    ...identity,
    projects: [
      {
        id: current.id,
        name: current.name,
        revision: current.revision,
        legacyId: null,
        properties: current,
      },
    ],
    records: [],
    cycles: [],
  })
}
function page() {
  return (
    <ProjectDetailPage
      workspaceId={identity.workspaceId}
      user={{ id: identity.userId, name: "Bob" }}
      people={[]}
      teams={[team]}
      projectId={project.id}
      tab="overview"
      onTab={vi.fn()}
      onBack={vi.fn()}
    />
  )
}
beforeEach(async () => {
  await setupPreferenceFixture(identity.userId)
  window.localStorage.clear()
  initializeProductStorage({ ...identity, entries: [] }, false)
  install(project)
  vi.mocked(persistProductState).mockReset()
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
  resetProductStorage()
  replaceCanonicalIssues(null, false)
  vi.unstubAllGlobals()
})
it.each(["Project name", "Project summary"])(
  "keeps the dirty %s and its starting revision across remote refreshes",
  (label) => {
    render(page())
    const field = screen.getByRole("textbox", { name: label })
    fireEvent.change(field, { target: { value: "Bob's private draft" } })
    act(() =>
      install({
        ...project,
        revision: 2,
        name: "Alice's name",
        summary: "Alice's summary",
      })
    )
    expect(screen.getByRole("textbox", { name: label })).toBe(field)
    expect((field as HTMLInputElement).value).toBe("Bob's private draft")
    fireEvent.blur(field)
    expect(persistProductState).not.toHaveBeenCalled()
    expect((field as HTMLInputElement).value).toBe("Bob's private draft")
    expect(screen.getByRole("alert").textContent).toContain("changed")
    act(() =>
      install({
        ...project,
        revision: 3,
        name: "New shared name",
        summary: "New shared summary",
      })
    )
    expect((field as HTMLInputElement).value).toBe("Bob's private draft")
    fireEvent.keyDown(field, { key: "Escape" })
    expect((field as HTMLInputElement).value).toBe(
      label === "Project name" ? "New shared name" : "New shared summary"
    )
  }
)
it("binds description edits to the revision at the first edit and keeps stale rich text intact", () => {
  render(page())
  const field = screen.getByRole("textbox", { name: "Project description" })
  const document = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Bob's description draft" }],
      },
    ],
  }
  fireEvent.change(field, { target: { value: JSON.stringify(document) } })
  act(() =>
    install({
      ...project,
      revision: 2,
      description: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Alice's description" }],
          },
        ],
      },
    })
  )
  fireEvent.blur(field)
  expect(persistProductState).not.toHaveBeenCalled()
  expect(JSON.parse((field as HTMLTextAreaElement).value)).toEqual(document)
  expect(screen.getByRole("alert").textContent).toContain("changed")
})

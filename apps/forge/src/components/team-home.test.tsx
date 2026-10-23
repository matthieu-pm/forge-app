import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ResourceEditor, TeamOverview } from "./team-home"
import { TeamDocuments } from "./team-home-documents"
import { TeamLoops } from "./team-home-loops"
import type { TeamSummary } from "@/lib/team-contract"
import { updateTeam } from "@/lib/team-state"
import { emptyTeamHome, teamHomeKey } from "@/lib/team-home-state"

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn(), invalidate: vi.fn() }),
  Link: ({ children, params, to, search: _search, ...props }: any) => (
    <a href={to.replace("$teamSlug", params?.teamSlug ?? "")} {...props}>
      {children}
    </a>
  ),
}))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => <span />,
}))
vi.mock("@/lib/team-state", () => ({ updateTeam: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const team: TeamSummary = {
  id: "test-home",
  slug: "testing",
  name: "Testing",
  identifier: "TEST",
  icon: { kind: "emoji", value: "🔥", color: "#818cf8" },
  timezone: "Europe/Paris",
  description: "",
  visibility: "workspace",
  estimationScheme: "none",
  issueEmailEnabled: false,
  detailedHistoryEnabled: false,
  createdAt: "2026-10-12",
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
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe("team home workflows", () => {
  it("cancels inline team edits with Escape without saving on blur", () => {
    render(
      <TeamOverview
        team={team}
        directory={{ members: [], availableMembers: [], canManage: true }}
        store={{
          state: emptyTeamHome(),
          ready: true,
          error: null,
          update: vi.fn(),
        }}
      />
    )
    for (const label of ["Team name", "Team description"]) {
      const input = screen.getByLabelText<HTMLInputElement>(label)
      act(() => input.focus())
      fireEvent.change(input, { target: { value: "Discard this edit" } })
      fireEvent.keyDown(input, { key: "Escape" })
      expect(input.value).toBe(
        label === "Team name" ? team.name : team.description
      )
      expect(document.activeElement).not.toBe(input)
    }
    expect(updateTeam).not.toHaveBeenCalled()
  })
  it("keeps the resource menu operable through its tooltip trigger", () => {
    render(
      <TeamOverview
        team={team}
        directory={{ members: [], availableMembers: [], canManage: true }}
        store={{
          state: emptyTeamHome(),
          ready: true,
          error: null,
          update: vi.fn(),
        }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Add resources" }))
    expect(screen.getByRole("menuitem", { name: "New link…" })).toBeTruthy()
    fireEvent.click(screen.getByRole("menuitem", { name: "New link…" }))
    expect(screen.getByRole("dialog")).toBeTruthy()
  })
  it("creates and reopens a document with its contents", async () => {
    render(<TeamDocuments team={team} />)
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create document" })
      ).toBeTruthy()
    )
    fireEvent.click(screen.getByRole("button", { name: "Create document" }))
    fireEvent.change(screen.getByLabelText("Resource title"), {
      target: { value: "Decision log" },
    })
    fireEvent.change(screen.getByLabelText("Document content"), {
      target: { value: "Keep the existing shell." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save document" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Decision log" })).toBeTruthy()
    )
    fireEvent.click(screen.getByRole("button", { name: "Decision log" }))
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Document content").value
    ).toBe("Keep the existing shell.")
    expect(
      JSON.parse(localStorage.getItem(teamHomeKey(team.id))!).resources[0].title
    ).toBe("Decision log")
  })
  it("rejects unsafe link schemes before saving", () => {
    const update = vi.fn(() => true)
    render(
      <ResourceEditor
        resource={{
          id: "link",
          kind: "link",
          title: "Bad link",
          content: "javascript:alert(1)",
          sectionId: null,
          updatedAt: "2026-10-12",
        }}
        onClose={vi.fn()}
        store={{ state: emptyTeamHome(), ready: true, error: null, update }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Save link" }))
    expect(screen.getByRole("alert").textContent).toContain("http or https")
    expect(update).not.toHaveBeenCalled()
  })
  it("keeps the editor open if saving fails", () => {
    const close = vi.fn()
    render(
      <ResourceEditor
        resource={{
          id: "doc",
          kind: "document",
          title: "Plan",
          content: "Draft",
          sectionId: null,
          updatedAt: "2026-10-12",
        }}
        onClose={close}
        store={{
          state: emptyTeamHome(),
          ready: true,
          error: null,
          update: () => false,
        }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Save document" }))
    expect(close).not.toHaveBeenCalled()
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Document content").value
    ).toBe("Draft")
  })
  it("turns a loop template into an editable persisted draft", async () => {
    render(<TeamLoops team={team} />)
    const template = screen.getByRole("button", {
      name: /Weekly wrap Summarizes/,
    })
    await waitFor(() => expect(template.hasAttribute("disabled")).toBe(false))
    fireEvent.click(template)
    expect(screen.getByRole("combobox", { name: "Loop trigger" }).textContent).toBe(
      "Weekly schedule"
    )
    fireEvent.change(screen.getByLabelText("Loop name"), {
      target: { value: "Friday wrap" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Friday wrap" })).toBeTruthy()
    )
    expect(
      JSON.parse(localStorage.getItem(teamHomeKey(team.id))!).loops[0].trigger
    ).toBe("Weekly schedule")
    expect(screen.getByText("Draft · On this device")).toBeTruthy()
  })
})

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { IssueComposer } from "./issue-composer"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import { createSharedTeamIssue } from "@/lib/canonical-issue-client"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"
import { blankIssueDraft } from "@/lib/team-issues"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "owner" } } }) },
}))
vi.mock("@/lib/canonical-issue-client", () => ({
  createSharedTeamIssue: vi.fn(),
}))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => <span />,
}))
const team = {
  id: "team",
  name: "First team",
  slug: "first",
  identifier: "ONE",
} as TeamSummary
const other = {
  ...team,
  id: "other",
  name: "Other team",
  slug: "other",
  identifier: "TWO",
}
beforeEach(() => {
  replaceCanonicalIssues({
    workspaceId: "workspace",
    sessionId: "session",
    userId: "owner",
    records: [],
    projects: [],
    cycles: [],
  })
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.mocked(createSharedTeamIssue).mockResolvedValue({ id: "saved" } as Awaited<
    ReturnType<typeof createSharedTeamIssue>
  >)
})
afterEach(() => {
  cleanup()
  replaceCanonicalIssues(null, false)
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})
it.each([
  ["dialog", undefined, undefined],
  ["inline", undefined, undefined],
  ["dialog", "", ""],
  ["inline", "", ""],
  ["dialog", "former-team-member", undefined],
] as const)(
  "%s preserves assignment intent %s through team selection",
  async (presentation, initialAssignee, expected) => {
    render(
      <IssueComposer
        team={team}
        directory={{
          teams: [team, other],
          members: [],
          templates: [],
          canManage: false,
          defaults: { members: null, nonMembers: null },
        }}
        initial={{
          ...blankIssueDraft(),
          title: "Assign according to my choice",
          assignee: initialAssignee,
        }}
        presentation={presentation}
        labels={[]}
        projects={[]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDraftSaved={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Set team" }))
    fireEvent.click(screen.getByRole("option", { name: "Other team" }))
    fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
    await waitFor(() => expect(createSharedTeamIssue).toHaveBeenCalledTimes(1))
    expect(vi.mocked(createSharedTeamIssue).mock.calls[0][0]).toBe(other.id)
    expect(vi.mocked(createSharedTeamIssue).mock.calls[0][1].assignee).toBe(
      expected
    )
  }
)
it("an explicit No assignee selection reaches the command as unassigned", async () => {
  render(
    <IssueComposer
      team={team}
      initial={{ ...blankIssueDraft(), title: "Leave unassigned" }}
      labels={[]}
      projects={[]}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      onDraftSaved={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "Change assignee" }))
  fireEvent.click(screen.getByRole("option", { name: "No assignee" }))
  fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
  await waitFor(() => expect(createSharedTeamIssue).toHaveBeenCalledTimes(1))
  expect(vi.mocked(createSharedTeamIssue).mock.calls[0][1].assignee).toBe("")
})

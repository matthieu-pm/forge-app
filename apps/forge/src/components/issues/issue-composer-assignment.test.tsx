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
import { productStorage } from "@/lib/product-storage"
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

it("retains the original creation identity while preserving newer typing as a separate draft", async () => {
  vi.mocked(createSharedTeamIssue).mockRejectedValueOnce(
    new Error("Response lost")
  )
  render(
    <IssueComposer
      team={team}
      initial={{ ...blankIssueDraft(), title: "Uncertain original" }}
      labels={[]}
      projects={[]}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      onDraftSaved={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
  await screen.findByText(/Response lost/)
  const originalKey = vi.mocked(createSharedTeamIssue).mock.calls[0][2]
    .commandKey
  fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
    target: { value: "Newer typing" },
  })
  fireEvent.click(
    screen.getByRole("button", { name: "Restore original draft to retry" })
  )
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Issue title" }).value
  ).toBe("Uncertain original")
  fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
  await waitFor(() => expect(createSharedTeamIssue).toHaveBeenCalledTimes(2))
  expect(vi.mocked(createSharedTeamIssue).mock.calls[1][2].commandKey).toBe(
    originalKey
  )
})

it("recovers unpublished edit-dialog input on reopening without submitting it", () => {
  productStorage.clear()
  const props = {
    team,
    issueId: "existing",
    initial: { ...blankIssueDraft(), title: "Existing issue" },
    labels: [],
    projects: [],
    onClose: vi.fn(),
    onSaved: vi.fn(),
    onDraftSaved: vi.fn(),
  }
  const first = render(<IssueComposer {...props} />)
  fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
    target: { value: "Unpublished offline edit" },
  })
  first.unmount()
  render(<IssueComposer {...props} />)
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Issue title" }).value
  ).toBe("Unpublished offline edit")
  expect(createSharedTeamIssue).not.toHaveBeenCalled()
})

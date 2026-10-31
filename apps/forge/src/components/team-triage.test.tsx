import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TeamTriage } from "./team-triage"
import { CanonicalEditFeedback } from "./issues/canonical-edit-feedback"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import { productStorage } from "@/lib/product-storage"
import { initialTeamTriage, teamTriageStorageKey } from "@/lib/team-triage"
import { triageDraftKey, triageIssuesKey } from "@/lib/triage-issues"
import { blankIssueDraft, issueSchema } from "@/lib/issue-record-contract"
import {
  canonicalIssueRows,
  replaceCanonicalIssues,
} from "@/lib/canonical-issue-cache"
import { resetIssueEdits } from "@/lib/canonical-issue-edit-client"
import { persistCanonicalIssueEdits } from "@/lib/canonical-issue-state"

vi.mock("@/components/ui/option-select", () => ({
  OptionSelect: ({
    children,
    value,
    onValueChange,
    ...props
  }: {
    children: ReactNode
    value: string
    onValueChange: (value: string) => void
  }) => (
    <select
      {...props}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/lib/template-state", () => ({
  loadTemplates: vi.fn().mockResolvedValue({
    templates: [],
    defaults: { members: null, nonMembers: null },
    teams: [],
    members: [{ id: "bob", name: "Bob" }],
    canManage: true,
  }),
}))
vi.mock("@/lib/issue-query-client", () => ({
  useIssueQuery: ({ teamIds }: { teamIds: Array<string> }) => ({
    enabled: true,
    records: canonicalIssueRows(teamIds[0]).filter(
      (r) => r.issue.triage && !r.issue.snoozed
    ),
    loading: false,
    error: "",
    refresh: vi.fn(),
    loadMore: vi.fn(),
  }),
}))
vi.mock("@/lib/canonical-issue-state", () => ({
  persistCanonicalIssueEdits: vi.fn(),
  persistCanonicalIssue: vi.fn(),
  loadCanonicalIssues: vi.fn(),
}))
const team = {
  id: "60109b0b-7cd4-4097-9883-196a80ff2493",
  slug: "product",
  name: "Product",
  identifier: "PRO",
  icon: { kind: "emoji", value: "🔥", color: "#94a3b8" },
} as TeamSummary
const issue = () =>
  issueSchema.parse({
    ...blankIssueDraft("backlog"),
    id: "02fb5f39-eaac-4d41-a658-f2ac45e17acb",
    number: 9,
    revision: 3,
    triage: true,
    title: "Investigate request",
    creator: "alice",
    createdAt: "2026-10-30T12:00:00Z",
    updatedAt: "2026-10-30T12:00:00Z",
    statusChangedAt: "2026-10-30T12:00:00Z",
    suggestedLabel: "",
    completedAt: null,
  })
function snapshot(rows = [issue()]) {
  replaceCanonicalIssues({
    workspaceId: "workspace",
    userId: "alice",
    sessionId: "session",
    records: rows.map((i) => ({ teamId: team.id, issue: i })),
    projects: [],
    cycles: [],
  })
}
beforeEach(() => {
  resetIssueEdits()
  productStorage.clear()
  replaceCanonicalIssues(null, false)
  productStorage.setItem(
    teamTriageStorageKey(team.id),
    JSON.stringify({ ...initialTeamTriage(), enabled: true })
  )
  snapshot()
  vi.mocked(persistCanonicalIssueEdits).mockReset()
})
afterEach(() => {
  cleanup()
  resetIssueEdits()
  replaceCanonicalIssues(null, false)
  productStorage.clear()
})
async function open() {
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Open PRO-9 Investigate request",
    })
  )
  await screen.findByRole("button", { name: "Accept issue" })
  await waitFor(() =>
    expect(
      screen
        .getByRole("combobox", { name: "Triage assignee" })
        .hasAttribute("disabled")
    ).toBe(false)
  )
}
describe("FOR-50 canonical triage screen", () => {
  it("accepts and assigns the reviewed canonical revision and never writes a local copy", async () => {
    vi.mocked(persistCanonicalIssueEdits).mockResolvedValue(
      JSON.stringify({
        status: "saved",
        records: [
          {
            teamId: team.id,
            issue: { ...issue(), triage: false, assignee: "bob", revision: 4 },
          },
        ],
      })
    )
    render(<TeamTriage team={team} />)
    await open()
    fireEvent.change(
      screen.getByRole("combobox", { name: "Triage assignee" }),
      { target: { value: "bob" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Accept issue" }))
    await waitFor(() =>
      expect(persistCanonicalIssueEdits).toHaveBeenCalledTimes(1)
    )
    expect(
      vi.mocked(persistCanonicalIssueEdits).mock.calls[0][0].data.edits[0]
    ).toMatchObject({
      issueId: issue().id,
      expectedRevision: 3,
      triageDecision: "accept",
      changes: { status: "backlog", assignee: "bob" },
    })
    expect(productStorage.getItem(triageIssuesKey(team.id))).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Open PRO-9 Investigate request" })
    ).toBeNull()
  })
  it("declines to the team's Canceled status", async () => {
    vi.mocked(persistCanonicalIssueEdits).mockResolvedValue(
      JSON.stringify({
        status: "saved",
        records: [
          {
            teamId: team.id,
            issue: {
              ...issue(),
              triage: false,
              status: "canceled",
              revision: 4,
            },
          },
        ],
      })
    )
    render(<TeamTriage team={team} />)
    await open()
    fireEvent.click(screen.getByRole("button", { name: "Decline issue" }))
    await waitFor(() =>
      expect(persistCanonicalIssueEdits).toHaveBeenCalledTimes(1)
    )
    expect(
      vi.mocked(persistCanonicalIssueEdits).mock.calls[0][0].data.edits[0]
    ).toMatchObject({
      triageDecision: "decline",
      changes: { status: "canceled" },
    })
  })
  it("shows a competing decision conflict and prevents rebasing onto already decided work", async () => {
    vi.mocked(persistCanonicalIssueEdits).mockResolvedValue(
      JSON.stringify({
        status: "conflict",
        records: [
          {
            teamId: team.id,
            issue: {
              ...issue(),
              triage: false,
              status: "canceled",
              revision: 4,
            },
          },
        ],
      })
    )
    render(
      <>
        <CanonicalEditFeedback />
        <TeamTriage team={team} />
      </>
    )
    await open()
    fireEvent.click(screen.getByRole("button", { name: "Accept issue" }))
    await screen.findByText(/These issues changed in another session/)
    expect(
      screen
        .getByRole("button", { name: "Apply my edits to latest" })
        .hasAttribute("disabled")
    ).toBe(true)
    fireEvent.click(screen.getByText("Review saved issue edits"))
    expect(screen.getByText(/already left triage/)).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Use latest shared version" })
    )
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  })
  it("retains the reviewed revision when background data refreshes", async () => {
    vi.mocked(persistCanonicalIssueEdits).mockResolvedValue(
      JSON.stringify({
        status: "conflict",
        records: [{ teamId: team.id, issue: { ...issue(), revision: 4 } }],
      })
    )
    render(<TeamTriage team={team} />)
    await open()
    act(() => snapshot([{ ...issue(), revision: 4, priority: "High" }]))
    fireEvent.click(screen.getByRole("button", { name: "Accept issue" }))
    await waitFor(() =>
      expect(persistCanonicalIssueEdits).toHaveBeenCalledTimes(1)
    )
    expect(
      vi.mocked(persistCanonicalIssueEdits).mock.calls[0][0].data.edits[0]
        .expectedRevision
    ).toBe(3)
  })
  it("preserves legacy triage data without displaying a second copy", async () => {
    productStorage.setItem(triageIssuesKey(team.id), "legacy payload preserved")
    snapshot([])
    render(<TeamTriage team={team} />)
    expect(await screen.findByText("Nothing to triage")).toBeTruthy()
    expect(productStorage.getItem(triageIssuesKey(team.id))).toBe(
      "legacy payload preserved"
    )
  })
  it("retains a creation draft when shared triage is unavailable", async () => {
    productStorage.setItem(
      triageDraftKey(team.id),
      JSON.stringify({ title: "Unsaved draft" })
    )
    replaceCanonicalIssues(null, false)
    render(<TeamTriage team={team} />)
    expect((await screen.findByRole("alert")).textContent).toContain(
      "preserved"
    )
    expect(
      JSON.parse(productStorage.getItem(triageDraftKey(team.id))!).title
    ).toBe("Unsaved draft")
  })
})

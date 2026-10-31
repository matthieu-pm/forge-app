import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TeamTriage } from "./team-triage"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import type { IssueQueryPage } from "@/lib/issue-query-contract"
import { productStorage } from "@/lib/product-storage"
import { initialTeamTriage, teamTriageStorageKey } from "@/lib/team-triage"
import { blankIssueDraft, issueSchema } from "@/lib/issue-record-contract"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"
import { resetIssueEdits } from "@/lib/canonical-issue-edit-client"
import {
  loadIssueQuery,
  persistCanonicalIssueEdits,
} from "@/lib/canonical-issue-state"
import { invalidateIssueQueries } from "@/lib/issue-query-client"

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
vi.mock("@/lib/canonical-issue-state", () => ({
  persistCanonicalIssueEdits: vi.fn(),
  persistCanonicalIssue: vi.fn(),
  loadCanonicalIssues: vi.fn(),
  loadIssueQuery: vi.fn(),
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

function page(revision = 3): IssueQueryPage {
  return {
    workspaceId: "workspace",
    userId: "alice",
    sessionId: "session",
    records: [{ teamId: team.id, issue: { ...issue(), revision } }],
    resultRevision: String(revision),
    projectTotals: [],
    rollups: [],
    nextCursor: null,
    total: 1,
    facets: {
      assignee: [],
      labels: [],
      priority: [],
      project: [],
      team: [],
      status: [],
    },
    facetsTruncated: false,
    groups: [],
  }
}
beforeEach(() => {
  resetIssueEdits()
  productStorage.clear()
  replaceCanonicalIssues(null, false)
  invalidateIssueQueries()
  productStorage.setItem(
    teamTriageStorageKey(team.id),
    JSON.stringify({ ...initialTeamTriage(), enabled: true })
  )
  snapshot()
  vi.mocked(loadIssueQuery)
    .mockReset()
    .mockResolvedValue(JSON.stringify(page()))
  vi.mocked(persistCanonicalIssueEdits)
    .mockReset()
    .mockResolvedValue(
      JSON.stringify({ status: "conflict", records: page(4).records })
    )
})
afterEach(() => {
  cleanup()
  resetIssueEdits()
  replaceCanonicalIssues(null, false)
  invalidateIssueQueries()
  productStorage.clear()
})
it("retains the decision and reviewed revision through actual query invalidation and delayed page replacement", async () => {
  render(<TeamTriage team={team} />)
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Open PRO-9 Investigate request",
    })
  )
  const assignee = await screen.findByRole("combobox", {
    name: "Triage assignee",
  })
  await waitFor(() => expect(assignee.hasAttribute("disabled")).toBe(false))
  fireEvent.change(assignee, { target: { value: "bob" } })
  fireEvent.change(
    screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Acceptance status",
    }),
    { target: { value: "todo" } }
  )
  let resolve!: (value: string) => void
  vi.mocked(loadIssueQuery).mockImplementationOnce(
    () =>
      new Promise<string>((done) => {
        resolve = done
      })
  )
  // The provider's metadata refresh clears rows and invalidates the bounded page.
  act(() => snapshot([]))
  await screen.findByText("Loading issues…")
  expect(
    screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Triage assignee",
    }).value
  ).toBe("bob")
  await act(async () => resolve(JSON.stringify(page(4))))
  await screen.findByText("1 of 1 issues")
  expect(
    screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Acceptance status",
    }).value
  ).toBe("todo")
  expect(
    screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Triage assignee",
    }).value
  ).toBe("bob")
  fireEvent.click(screen.getByRole("button", { name: "Accept issue" }))
  await waitFor(() =>
    expect(persistCanonicalIssueEdits).toHaveBeenCalledTimes(1)
  )
  expect(
    vi.mocked(persistCanonicalIssueEdits).mock.calls[0][0].data.edits[0]
  ).toMatchObject({
    expectedRevision: 3,
    changes: { status: "todo", assignee: "bob" },
  })
})

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UpcomingCycle } from "./upcoming-cycle"
import type * as TeamCyclesModule from "@/lib/team-cycles"
import type * as EditClient from "@/lib/canonical-issue-edit-client"
import type { TeamIssue } from "@/lib/issue-record-contract"
import type { TeamSummary } from "@/lib/team-contract"
import {
  renderPreferences as render,
  setupPreferenceFixture,
} from "@/test/preference-fixture"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"
import { productStorage } from "@/lib/product-storage"
import { initialTeamCycles } from "@/lib/team-cycles-contract"
import { blankIssueDraft, saveTeamIssue } from "@/lib/team-issues"

const fixture = vi.hoisted(() => ({
  issues: [] as Array<TeamIssue>,
  loading: false,
  enqueue: vi.fn(),
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "user", name: "Matthieu" } } }),
  },
}))
vi.mock("@/lib/template-state", () => ({
  loadTemplates: async () => ({
    templates: [],
    teams: [],
    members: [],
    defaults: { members: null, nonMembers: null },
    canManage: false,
  }),
}))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => <span />,
}))
vi.mock("@/lib/team-cycles", async (original) => ({
  ...(await original<typeof TeamCyclesModule>()),
  useTeamCycles: () => ({
    ready: true,
    error: null,
    settings: { ...initialTeamCycles(), enabled: true },
    cycles: [
      {
        id: "closed",
        value: "closed",
        teamId: "rollover-ui",
        number: 12,
        start: new Date("2026-10-19T12:00:00"),
        end: new Date("2026-11-01T12:00:00"),
        timezone: "Europe/Paris",
        state: "Closed",
        issueCount: fixture.issues.length,
        completedCount: 0,
        closure: { closedAt: "2026-11-02T00:01:00Z", carriedCount: 1 },
      },
    ],
  }),
}))
vi.mock("@/lib/issue-query-client", () => ({
  useIssueQuery: () => ({
    enabled: true,
    records: fixture.issues.map((issue) => ({ teamId: "rollover-ui", issue })),
    page: { total: fixture.issues.length, groups: [], nextCursor: null },
    loading: fixture.loading,
    error: "",
    refresh: vi.fn(),
  }),
}))
vi.mock("@/lib/canonical-issue-edit-client", async (original) => ({
  ...(await original<typeof EditClient>()),
  enqueueIssueEdits: fixture.enqueue,
}))
const team = {
  id: "rollover-ui",
  name: "Product",
  slug: "product",
  identifier: "PRO",
} as TeamSummary
beforeEach(async () => {
  replaceCanonicalIssues(null, false)
  await setupPreferenceFixture("user")
  productStorage.clear()
  fixture.issues = []
  fixture.loading = false
  fixture.enqueue.mockReset()
  Element.prototype.scrollIntoView = vi.fn()
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
  replaceCanonicalIssues(null, false)
  vi.unstubAllGlobals()
})
function seed(mixed = false) {
  fixture.issues = [
    saveTeamIssue(team.id, {
      ...blankIssueDraft("todo"),
      title: "Carried work",
      cycle: "next",
    }),
  ]
  if (mixed)
    fixture.issues.push(
      saveTeamIssue(team.id, {
        ...blankIssueDraft("done"),
        title: "Completed work",
        cycle: "closed",
      })
    )
  fixture.issues = fixture.issues.map((issue) => ({ ...issue, revision: 2 }))
  replaceCanonicalIssues({
    workspaceId: "workspace",
    userId: "user",
    sessionId: "session-user",
    projects: [],
    cycles: [],
    records: fixture.issues.map((issue) => ({ teamId: team.id, issue })),
  })
}
describe("closed cycle canonical history", () => {
  it("shows historical issues even when every issue was carried out of the source cycle", async () => {
    seed()
    render(<UpcomingCycle team={team} cycleNumber={12} />)
    expect(await screen.findByText("Carried work")).toBeTruthy()
    expect(screen.queryByText("Plan your next cycle")).toBeNull()
    expect(
      screen.queryByRole("button", { name: /Create issue in|Create new issue/ })
    ).toBeNull()
  })
  it("edits carried issue properties against the current canonical revision without moving membership", async () => {
    seed(true)
    render(<UpcomingCycle team={team} cycleNumber={12} />)
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Set priority to for Carried work",
      })
    )
    fireEvent.click(screen.getByRole("option", { name: "High" }))
    expect(fixture.enqueue).toHaveBeenCalledWith(team.id, [
      expect.objectContaining({
        before: expect.objectContaining({ cycle: "next", revision: 2 }),
        changes: { priority: "High" },
      }),
    ])
  })
  it("saves a historical row dialog without resetting its current cycle", async () => {
    seed(true)
    render(<UpcomingCycle team={team} cycleNumber={12} />)
    fireEvent.click(await screen.findByText("Carried work"))
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Updated carried work" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save issue" }))
    await waitFor(() =>
      expect(fixture.enqueue).toHaveBeenCalledWith(team.id, [
        expect.objectContaining({
          before: expect.objectContaining({ cycle: "next", revision: 2 }),
          changes: { title: "Updated carried work" },
        }),
      ])
    )
  })
  it("does not offer creation while a closed historical query is loading or empty", () => {
    seed()
    fixture.issues = []
    fixture.loading = true
    const view = render(<UpcomingCycle team={team} cycleNumber={12} />)
    expect(
      screen.queryByRole("button", { name: /Create new issue/ })
    ).toBeNull()
    fixture.loading = false
    view.rerender(<UpcomingCycle team={team} cycleNumber={12} />)
    expect(
      screen.queryByRole("button", { name: /Create new issue/ })
    ).toBeNull()
    expect(
      screen.getByText("No visible issues were recorded at closure.")
    ).toBeTruthy()
  })
})

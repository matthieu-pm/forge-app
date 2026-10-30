import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MyIssues } from "./my-issues"
import type { ComponentProps } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import { productStorage } from "@/lib/product-storage"
import {
  readTestView,
  renderPreferences as render,
  setupPreferenceFixture,
} from "@/test/preference-fixture"
import {
  blankIssueDraft,
  readIssueStore,
  saveTeamIssue,
  teamIssuesKey,
} from "@/lib/team-issues"

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    search,
    params: _params,
    hash: _hash,
    ...props
  }: ComponentProps<"a"> & {
    to: string
    search?: Record<string, string>
    params?: unknown
    hash?: string
  }) => (
    <a {...props} href={`${to}?${new URLSearchParams(search)}`}>
      {children}
    </a>
  ),
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "user", name: "Matthieu" } } }),
  },
}))
vi.mock("@/lib/template-state", () => ({
  loadTemplates: () =>
    Promise.resolve({
      teams: [],
      templates: [],
      members: [{ id: "user", name: "Matthieu", image: null }],
      canManage: false,
      defaults: { members: null, nonMembers: null },
    }),
}))
vi.mock("./issue-composer", () => ({
  IssueComposer: ({ initial }: { initial: { assignee: string } }) => (
    <div role="dialog" aria-label="Create issue">
      Assignee: {initial.assignee}
    </div>
  ),
}))
vi.mock("./issue-detail", () => ({
  IssueDetail: ({
    issue,
    onBack,
  }: {
    issue: { title: string }
    onBack: () => void
  }) => (
    <div>
      {issue.title}
      <button onClick={onBack}>Back to My issues</button>
    </div>
  ),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const first: TeamSummary = {
  id: "first",
  slug: "first",
  identifier: "ONE",
  name: "First",
  icon: { kind: "emoji", value: "🔥", color: "#94a3b8" },
  timezone: "Europe/Paris",
  description: "",
  visibility: "workspace",
  estimationScheme: "none",
  issueEmailEnabled: false,
  detailedHistoryEnabled: false,
  createdAt: "2026-10-24T08:00:00Z",
}
const second = {
  ...first,
  id: "second",
  slug: "second",
  identifier: "TWO",
  name: "Second",
}
const teams = [first, second]
const user = { id: "user", name: "Matthieu" }
function start(
  search: ComponentProps<typeof MyIssues>["search"] = { view: "assigned" }
) {
  const onNavigate = vi.fn()
  const result = render(
    <MyIssues
      teams={teams}
      user={user}
      workspaceId="workspace"
      search={search}
      onNavigate={onNavigate}
    />
  )
  return { ...result, onNavigate }
}
beforeEach(async () => {
  await setupPreferenceFixture("user")
  productStorage.clear()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
  saveTeamIssue(
    first.id,
    {
      ...blankIssueDraft(),
      title: "Assigned first",
      assignee: "user",
      subscribers: "user",
    },
    { creator: "other" }
  )
  saveTeamIssue(
    second.id,
    { ...blankIssueDraft(), title: "Assigned second", assignee: "user" },
    { creator: "user" }
  )
  saveTeamIssue(
    first.id,
    {
      ...blankIssueDraft(),
      title: "Other person's issue",
      assignee: "other",
      subscribers: "other",
    },
    { creator: "other" }
  )
})
afterEach(() => {
  cleanup()
  productStorage.clear()
  vi.unstubAllGlobals()
})
describe("My issues page", () => {
  it("reuses rows across teams and updates only the owning team", async () => {
    start()
    expect(
      await screen.findByRole("button", { name: "Open ONE-1 Assigned first" })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Open TWO-1 Assigned second" })
    ).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: /Other person's issue/ })
    ).toBeNull()
    fireEvent.click(
      screen.getByRole("button", {
        name: "Set priority to for Assigned second",
      })
    )
    fireEvent.click(await screen.findByRole("option", { name: /High/ }))
    expect(readIssueStore(second.id).issues[0].priority).toBe("High")
    expect(readIssueStore(first.id).issues[0].priority).toBe("No priority")
  })
  it("uses separate personal preferences for the details preview and keeps team preferences unchanged", async () => {
    const firstBefore = productStorage.getItem(teamIssuesKey(first.id))
    const page = start()
    await screen.findByRole("button", { name: "Open ONE-1 Assigned first" })
    fireEvent.click(screen.getByRole("button", { name: "Open details" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Open ONE-1 Assigned first" })
    )
    expect(
      screen.getByRole("complementary", { name: "Issue details" })
    ).toBeTruthy()
    expect(page.onNavigate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Open issue" }))
    expect(page.onNavigate).toHaveBeenCalledWith({
      view: "assigned",
      issue: readIssueStore(first.id).issues[0].id,
    })
    expect(readTestView("myIssues").details).toBe(true)
    expect(productStorage.getItem(teamIssuesKey(first.id))).toBe(firstBefore)
  })
  it("shows created/subscribed scopes, and uses the shared composer with self-assignment on Assigned", async () => {
    const page = start({ view: "created" })
    await screen.findByRole("button", { name: "Open TWO-1 Assigned second" })
    expect(
      screen.queryByRole("button", { name: "Open ONE-1 Assigned first" })
    ).toBeNull()
    page.rerender(
      <MyIssues
        teams={teams}
        user={user}
        workspaceId="workspace"
        search={{ view: "subscribed" }}
        onNavigate={page.onNavigate}
      />
    )
    expect(
      screen.getByRole("button", { name: "Open ONE-1 Assigned first" })
    ).toBeTruthy()
    page.rerender(
      <MyIssues
        teams={teams}
        user={user}
        workspaceId="workspace"
        search={{ view: "assigned" }}
        onNavigate={page.onNavigate}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "New issue" }))
    expect(
      screen.getByRole("dialog", { name: "Create issue" }).textContent
    ).toContain("Assignee: user")
  })
  it("keeps corrupt team data intact while showing the other team's issues and refreshing same-tab updates", async () => {
    productStorage.setItem(teamIssuesKey(first.id), "invalid saved data")
    start()
    await screen.findByRole("button", { name: "Open TWO-1 Assigned second" })
    expect(screen.getByRole("alert").textContent).toContain(
      "First issues could not be loaded"
    )
    expect(productStorage.getItem(teamIssuesKey(first.id))).toBe(
      "invalid saved data"
    )
    act(() => {
      saveTeamIssue(
        second.id,
        { ...blankIssueDraft(), title: "New assigned", assignee: "user" },
        { creator: "user" }
      )
    })
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open TWO-2 New assigned" })
      ).toBeTruthy()
    )
  })
})

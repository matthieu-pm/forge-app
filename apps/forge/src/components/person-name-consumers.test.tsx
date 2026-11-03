import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PersonNameScope } from "./person-name-provider"
import { ActivityAuthor } from "./initiatives/activity-author"
import { SafeCommentContent } from "./issues/safe-comment-content"
import { InlineIssueProperties, IssueRows } from "./issues/issue-list"
import { SharedCommentInput } from "./issues/shared-comment-input"
import { WorkspaceMembers } from "./workspace-members"
import { IssueHistory } from "./issues/issue-history"
import { PreferencesSettings } from "./preferences-settings"
import * as PersonNames from "@/lib/person-name"
import { usePersonName } from "./person-name-provider"
import type { ReactNode } from "react"
import type { TeamIssue } from "@/lib/team-issues"
import type { WorkspaceAccessSummary } from "@/lib/member-contract"
import type * as CommentClient from "@/lib/issue-comment-client"
import {
  PreferenceFixtureScope,
  externalPreferenceEdit,
  setupPreferenceFixture,
} from "@/test/preference-fixture"
import { blankIssueDraft, defaultIssueDisplay } from "@/lib/team-issues"
import { initialTeamStatuses } from "@/lib/team-statuses"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"
import { productStorage } from "@/lib/product-storage"

const requests = vi.hoisted(() => ({
  send: vi.fn(),
  mentions: vi.fn(),
  history: vi.fn(),
}))
vi.mock("@/lib/issue-comment-client", async (original) => ({
  ...(await original<typeof CommentClient>()),
  sendIssueComment: requests.send,
}))
vi.mock("@/lib/issue-comment-state", () => ({
  loadCommentMentions: requests.mentions,
  persistIssueComment: vi.fn(),
}))
vi.mock("@/lib/issue-history-state", () => ({
  loadIssueHistory: requests.history,
}))
vi.mock("@/lib/account-preference-state", () => ({
  loadStartedAssignmentAvailability: vi.fn().mockResolvedValue(false),
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null }) },
}))
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))

const people = [
  { id: "account-a", name: "Alex Smith", username: "alex_one", image: null },
  { id: "account-b", name: "Alex Smith", username: "alex_two", image: null },
  { id: "account-c", name: "", username: "no_full_name", image: null },
  { id: "account-d", name: "No username", username: null, image: null },
  { id: "account-e", name: "", username: null, image: null },
]
const statuses = initialTeamStatuses().statuses
const issue: TeamIssue = {
  ...blankIssueDraft(),
  id: "f58de071-9917-4c67-8f88-278282788159",
  number: 1,
  title: "Name formatting",
  status: statuses[0].id,
  assignee: people[1].id,
  creator: people[0].id,
  activity: [],
  createdAt: "2026-11-03T12:00:00Z",
  updatedAt: "2026-11-03T12:00:00Z",
  statusChangedAt: "2026-11-03T12:00:00Z",
  completedAt: null,
  suggestedLabel: "",
  recurrenceSpawned: false,
}
const document = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "mention",
          attrs: { id: people[1].id, label: "Original snapshot" },
        },
        { type: "text", text: " hello" },
      ],
    },
  ],
}
const access: WorkspaceAccessSummary = {
  canManage: false,
  currentUserId: "alice",
  invitations: [],
  members: people.map((person) => ({
    ...person,
    userId: person.id,
    email: `${person.id}@example.test`,
    title: null,
    role: "member",
    joinedAt: "2026-11-03T12:00:00Z",
    lastSeenAt: null,
    teamCount: 0,
    isOnline: false,
  })),
}
function Scope({
  children,
  enabled = true,
}: {
  children: ReactNode
  enabled?: boolean
}) {
  return (
    <PreferenceFixtureScope>
      <PersonNameScope value={{ enabled, people }}>{children}</PersonNameScope>
    </PreferenceFixtureScope>
  )
}
beforeEach(async () => {
  productStorage.clear()
  await setupPreferenceFixture()
  replaceCanonicalIssues({
    workspaceId: "workspace",
    userId: "alice",
    sessionId: "session-alice",
    records: [],
    projects: [],
    cycles: [],
  })
  requests.send.mockReset().mockResolvedValue({ status: "saved", records: [] })
  requests.mentions
    .mockReset()
    .mockResolvedValue({ targets: people, canModerate: false })
  requests.history.mockReset().mockResolvedValue({
    entries: [
      {
        id: "event",
        topic: "issue.created",
        createdAt: "2026-11-03T12:00:00Z",
        actor: {
          userId: people[0].id,
          name: "Old author snapshot",
          kind: "session",
        },
        origin: "command",
        changes: [],
      },
    ],
    nextCursor: null,
  })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )
})
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await new Promise((resolve) => setTimeout(resolve, 5))
})

describe("FOR-130 AT-01", () => {
  it("updates an already open member dialog with the same disambiguation as its row", async () => {
    render(
      <Scope>
        <WorkspaceMembers access={access} teams={[]} />
      </Scope>
    )
    fireEvent.click(screen.getByRole("button", { name: "View alex_two" }))
    await screen.findByRole("dialog", { name: "alex_two" })
    await act(() =>
      externalPreferenceEdit("alice", { "general.displayNames": "full-name" })
    )
    expect(
      screen.getByRole("dialog", { name: "Alex Smith · @alex_two" })
    ).toBeTruthy()
  })

  it("shares workspace formatting across mounted consumers", async () => {
    const format = vi.spyOn(PersonNames, "formatPersonNames")
    function Name() {
      const personName = usePersonName(people)
      return <span>{personName(people[0])}</span>
    }
    render(
      <Scope>
        {Array.from({ length: 100 }, (_, index) => (
          <Name key={index} />
        ))}
      </Scope>
    )
    expect(format).toHaveBeenCalledTimes(1)
    await act(() =>
      externalPreferenceEdit("alice", { "general.displayNames": "full-name" })
    )
    expect(format).toHaveBeenCalledTimes(2)
    expect(screen.getAllByText("Alex Smith · @alex_one")).toHaveLength(100)
  })

  it("distinguishes unavailable mention snapshots in both read-only and mounted editor views", async () => {
    const mentions = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "former-a", label: "Alex" } },
            { type: "text", text: " and " },
            { type: "mention", attrs: { id: "former-b", label: "Alex" } },
          ],
        },
      ],
    }
    const original = structuredClone(mentions)
    render(
      <Scope>
        <section aria-label="Former mentions">
          <SafeCommentContent document={mentions} fallback="" />
        </section>
        <SharedCommentInput
          teamId="6ac18b75-07f7-41dc-9890-a52cccd4c551"
          issueId={issue.id}
          comment={{
            id: "cba89ef8-84b7-4f42-bcb1-a41d04b87c48",
            body: "@Alex and @Alex",
            document: mentions,
            version: 1,
          }}
        />
      </Scope>
    )
    const saved = within(
      screen.getByRole("region", { name: "Former mentions" })
    )
    expect(saved.getByText("@Alex · former-a")).toBeTruthy()
    expect(saved.getByText("@Alex · former-b")).toBeTruthy()
    const editor = await screen.findByRole("textbox", { name: "Edit comment" })
    expect(editor.textContent).toContain("@Alex · former-a")
    expect(editor.textContent).toContain("@Alex · former-b")
    await act(() =>
      externalPreferenceEdit("alice", { "general.displayNames": "full-name" })
    )
    expect(editor.textContent).toContain("@Alex · former-b")
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }))
    await waitFor(() => expect(requests.send).toHaveBeenCalled())
    expect(requests.send.mock.calls[0][0].document).toEqual(original)
    expect(mentions).toEqual(original)
  })

  it("updates mounted assignee, activity, comment mention, history and member consumers with safe fallbacks", async () => {
    const frozen = structuredClone(document)
    render(
      <Scope>
        <section aria-label="Assignee">
          <InlineIssueProperties
            issue={issue}
            statuses={statuses}
            members={people}
            property="assignee"
            onUpdate={vi.fn()}
          />
        </section>
        <section aria-label="Author">
          <ActivityAuthor person={people[0]} userId="alice" />
        </section>
        <section aria-label="Comment">
          <SafeCommentContent document={document} fallback="" />
        </section>
        <IssueHistory issueId={issue.id} revision={1} />
        <WorkspaceMembers access={access} teams={[]} />
      </Scope>
    )
    expect(
      within(screen.getByRole("region", { name: "Assignee" })).getByText(
        "alex_two"
      )
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "View alex_one's profile" })
    ).toBeTruthy()
    expect(await screen.findByText("@alex_two")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "View No username" })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "View Member · account-e" })
    ).toBeTruthy()
    await act(() =>
      externalPreferenceEdit("alice", { "general.displayNames": "full-name" })
    )
    expect(
      within(screen.getByRole("region", { name: "Assignee" })).getByText(
        "Alex Smith · @alex_two"
      )
    ).toBeTruthy()
    expect(
      screen.getByRole("button", {
        name: "View Alex Smith · @alex_one's profile",
      })
    ).toBeTruthy()
    expect(screen.getByText("@Alex Smith · @alex_two")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "View Alex Smith · @alex_one" })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "View Alex Smith · @alex_two" })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "View no_full_name" })
    ).toBeTruthy()
    expect(document).toEqual(frozen)
    expect(issue.assignee).toBe(people[1].id)
    await act(() =>
      externalPreferenceEdit("alice", { "general.displayNames": "username" })
    )
    expect(screen.getByText("@alex_two")).toBeTruthy()
  })

  it("searches the full-name alias while showing usernames and selects the immutable account", async () => {
    const update = vi.fn()
    render(
      <Scope>
        <InlineIssueProperties
          issue={{ ...issue, assignee: "" }}
          statuses={statuses}
          members={people}
          property="assignee"
          onUpdate={update}
        />
      </Scope>
    )
    fireEvent.click(
      screen.getByRole("button", { name: `Assign to for ${issue.title}` })
    )
    fireEvent.change(screen.getByRole("textbox", { name: "Assign to…" }), {
      target: { value: "Alex Smith" },
    })
    fireEvent.click(screen.getByRole("option", { name: /alex_two/ }))
    expect(update).toHaveBeenCalledWith(expect.anything(), {
      assignee: people[1].id,
    })
    await act(() =>
      externalPreferenceEdit("alice", { "general.displayNames": "full-name" })
    )
    expect(update).toHaveBeenCalledTimes(1)
  })

  it("keeps original mention labels for unavailable accounts and respects the disabled gate", () => {
    render(
      <Scope enabled={false}>
        <SafeCommentContent document={document} fallback="" />
        <PreferencesSettings />
      </Scope>
    )
    expect(screen.getByText("@Original snapshot")).toBeTruthy()
    expect(
      screen
        .getByRole("button", { name: "Display names" })
        .hasAttribute("disabled")
    ).toBe(true)
  })
})

describe("FOR-130 AT-02", () => {
  it("keeps duplicate assignee groups separate and creates into their immutable account before and after toggling", async () => {
    const create = vi.fn()
    render(
      <Scope>
        <IssueRows
          issues={[]}
          allIssues={[]}
          identifier="FOR"
          team={{ slug: "forge", name: "Forge" }}
          statuses={statuses}
          members={people}
          display={{
            ...defaultIssueDisplay(),
            group: "Assignee",
            showEmpty: true,
          }}
          selected={[]}
          onSelect={vi.fn()}
          onOpen={vi.fn()}
          onUpdate={vi.fn()}
          onCreate={create}
        />
      </Scope>
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Create issue in alex_two" })
    )
    expect(create).toHaveBeenLastCalledWith({ assignee: people[1].id })
    await act(() =>
      externalPreferenceEdit("alice", { "general.displayNames": "full-name" })
    )
    fireEvent.click(
      screen.getByRole("button", {
        name: "Create issue in Alex Smith · @alex_two",
      })
    )
    expect(create).toHaveBeenLastCalledWith({ assignee: people[1].id })
    expect(screen.getAllByRole("heading", { name: /Alex Smith/ })).toHaveLength(
      2
    )
  })

  it("retains a selected mention's ID and snapshot while its mounted editor label changes", async () => {
    render(
      <Scope>
        <SharedCommentInput
          teamId="6ac18b75-07f7-41dc-9890-a52cccd4c551"
          issueId={issue.id}
        />
      </Scope>
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "Mention a person" })
    )
    fireEvent.click(await screen.findByRole("button", { name: "alex_two" }))
    const editor = screen.getByRole("textbox", { name: "Comment" })
    await waitFor(() => expect(editor.textContent).toContain("@alex_two"))
    await act(() =>
      externalPreferenceEdit("alice", { "general.displayNames": "full-name" })
    )
    await waitFor(() =>
      expect(editor.textContent).toContain("@Alex Smith · @alex_two")
    )
    fireEvent.click(screen.getByRole("button", { name: "Submit comment" }))
    await waitFor(() => expect(requests.send).toHaveBeenCalled())
    const command = requests.send.mock.calls[0][0]
    expect(command.document.content[0].content[0].attrs).toEqual({
      id: people[1].id,
      label: people[1].name,
    })
  })
})

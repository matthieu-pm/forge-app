import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IssueHistory } from "./issue-history"
import type { IssueHistoryEntry } from "@/lib/issue-history-contract"

const context = vi.hoisted(() => ({
  epoch: 1,
  workspaceId: "workspace-a",
  sessionId: "session-a",
  userId: "user-a",
  load: vi.fn(),
}))
vi.mock("@/lib/canonical-issue-cache", () => ({
  CANONICAL_ISSUES_CHANGED: "test-history-scope",
  canonicalIssueEpoch: () => context.epoch,
  canonicalIssueState: () => ({
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    userId: context.userId,
  }),
}))
vi.mock("@/lib/issue-history-state", () => ({ loadIssueHistory: context.load }))
vi.mock("./issue-activity-row", () => ({
  ActivityRow: ({
    children,
    id,
  }: {
    children: React.ReactNode
    id: string
  }) => <div id={id}>{children}</div>,
}))
const entry = (id: string, topic = "issue.updated"): IssueHistoryEntry => ({
  id,
  topic,
  createdAt: "2026-10-31T12:00:00Z",
  actor: { userId: "verified-user", name: "Alice", kind: "session" },
  origin: "command",
  changes: [{ field: "status", from: "todo", to: "done" }],
})
const deferred = () => {
  let resolve!: (value: unknown) => void
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
beforeEach(() => {
  context.epoch = 1
  context.workspaceId = "workspace-a"
  context.sessionId = "session-a"
  context.load.mockReset()
})
afterEach(cleanup)
describe("committed issue history", () => {
  it("pages older events without duplicates and renders verified attribution and current comment links", async () => {
    context.load
      .mockResolvedValueOnce({
        entries: [
          {
            ...entry("new", "issue.comment.created"),
            commentId: "comment-id",
            changes: [],
          },
        ],
        nextCursor: "older",
      })
      .mockResolvedValueOnce({
        entries: [
          {
            ...entry("new", "issue.comment.created"),
            commentId: "comment-id",
            changes: [],
          },
          entry("old"),
        ],
        nextCursor: null,
      })
    render(
      <IssueHistory
        issueId="issue-id"
        revision={1}
        valueLabel={(field, value) =>
          field === "status" && value === "done" ? "Done" : value
        }
      />
    )
    await screen.findByText("added a comment", { exact: false })
    expect(
      screen.getByRole("link", { name: "View comment" }).getAttribute("href")
    ).toBe("#comment-comment-id")
    fireEvent.click(screen.getByRole("button", { name: "Load older history" }))
    await screen.findByText("from todo to Done", { exact: false })
    expect(context.load.mock.calls[1][0].data.query.cursor).toBe("older")
    expect(screen.getAllByText("Alice")).toHaveLength(2)
    expect(
      screen.queryByRole("button", { name: "Load older history" })
    ).toBeNull()
  })
  it("clears protected entries on pagination failure and can refresh", async () => {
    context.load
      .mockResolvedValueOnce({ entries: [entry("one")], nextCursor: "older" })
      .mockRejectedValueOnce(new Error("revoked"))
      .mockResolvedValueOnce({ entries: [], nextCursor: null })
    render(<IssueHistory issueId="issue-id" revision={1} />)
    await screen.findByText("Alice")
    fireEvent.click(screen.getByRole("button", { name: "Load older history" }))
    await screen.findByRole("alert")
    expect(screen.queryByText("Alice")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }))
    await screen.findByText("No committed history is available for this issue.")
    expect(screen.queryByRole("alert")).toBeNull()
  })
  it("fences late responses across a workspace/session change and issue navigation", async () => {
    const old = deferred()
    context.load.mockReturnValueOnce(old.promise).mockResolvedValue({
      entries: [
        {
          ...entry("new"),
          actor: { userId: "other", name: "Bob", kind: "apiKey" },
        },
      ],
      nextCursor: null,
    })
    const view = render(<IssueHistory issueId="issue-a" revision={1} />)
    await waitFor(() => expect(context.load).toHaveBeenCalledTimes(1))
    act(() => {
      context.epoch++
      context.workspaceId = "workspace-b"
      context.sessionId = "session-b"
      window.dispatchEvent(new Event("test-history-scope"))
    })
    view.rerender(<IssueHistory issueId="issue-b" revision={1} />)
    await screen.findByText("Bob")
    await act(async () => {
      old.resolve({ entries: [entry("secret")], nextCursor: null })
      await old.promise
    })
    expect(screen.queryByText("Alice")).toBeNull()
    expect(screen.getByText("via API key", { exact: false })).toBeTruthy()
  })
  it("labels imported attribution without treating historical authors as verified", async () => {
    context.load.mockResolvedValue({
      entries: [{ ...entry("import"), origin: "import", changes: [] }],
      nextCursor: null,
    })
    render(<IssueHistory issueId="issue-id" revision={1} />)
    await screen.findByText("historical attribution unverified", {
      exact: false,
    })
  })
})

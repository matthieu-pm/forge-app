import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SharedCommentInput } from "./shared-comment-input"
import type * as CommentClient from "@/lib/issue-comment-client"
import { commentFromText } from "@/lib/comment-rich-text"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }))
const requests = vi.hoisted(() => ({ send: vi.fn(), mentions: vi.fn() }))
vi.mock("@/lib/issue-comment-client", async (original) => ({
  ...(await original<typeof CommentClient>()),
  sendIssueComment: requests.send,
}))
vi.mock("@/lib/product-storage", () => ({ productStorage: storage }))
vi.mock("@/lib/issue-comment-state", () => ({
  loadCommentMentions: requests.mentions,
  persistIssueComment: vi.fn(),
}))
const props = {
  teamId: "6ac18b75-07f7-41dc-9890-a52cccd4c551",
  issueId: "f58de071-9917-4c67-8f88-278282788159",
}
const identity = {
  workspaceId: "workspace",
  userId: "alice",
  sessionId: "alice-session",
  records: [],
  projects: [],
  cycles: [],
}
beforeEach(() => {
  replaceCanonicalIssues(identity)
  storage.getItem.mockReset()
  storage.setItem.mockReset()
  requests.send.mockReset().mockResolvedValue({ status: "saved", records: [] })
  requests.mentions.mockReset().mockResolvedValue({
    targets: [{ id: "bob", name: "Bob" }],
    canModerate: false,
  })
})
afterEach(cleanup)
describe("FOR-46 private comment draft isolation", () => {
  it("remounts the editor when the account changes while the same shared issue stays open", async () => {
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document: commentFromText("Alice private draft"),
      })
    )
    const { rerender } = render(<SharedCommentInput {...props} />)
    expect(
      (await screen.findByRole("textbox", { name: "Comment" })).textContent
    ).toBe("Alice private draft")
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document: commentFromText("Bob private draft"),
      })
    )
    replaceCanonicalIssues({
      ...identity,
      userId: "bob",
      sessionId: "bob-session",
    })
    rerender(<SharedCommentInput {...props} />)
    expect(
      (await screen.findByRole("textbox", { name: "Comment" })).textContent
    ).toBe("Bob private draft")
    expect(screen.queryByText("Alice private draft")).toBeNull()
  })
  it("keeps a saved uncertain command available for exact retry after mounting", async () => {
    const document = commentFromText("Uncertain saved comment")
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document,
        command: {
          ...props,
          action: "create",
          commandKey: crypto.randomUUID(),
          commentId: crypto.randomUUID(),
          expectedVersion: 0,
          parentId: "",
          document,
        },
      })
    )
    render(<SharedCommentInput {...props} />)
    expect(
      (await screen.findByRole("textbox", { name: "Comment" })).getAttribute(
        "contenteditable"
      )
    ).toBe("false")
    expect(
      screen.getByRole("button", { name: "Submit comment" }).textContent
    ).toBe("Retry comment")
  })
  it("keeps the original edit version through refresh, then advances only after explicit review", async () => {
    const comment = {
      id: crypto.randomUUID(),
      body: "Original",
      document: commentFromText("Original"),
      version: 0,
    }
    const view = render(<SharedCommentInput {...props} comment={comment} />)
    await screen.findByRole("textbox", { name: "Edit comment" })
    view.rerender(
      <SharedCommentInput
        {...props}
        comment={{
          ...comment,
          version: 1,
          body: "Teammate edit",
          document: commentFromText("Teammate edit"),
        }}
      />
    )
    requests.send.mockResolvedValueOnce({ status: "conflict", records: [] })
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }))
    await screen.findByRole("button", { name: "Apply draft to this version" })
    expect(requests.send.mock.calls[0][0].expectedVersion).toBe(0)
    expect(requests.send.mock.calls[0][2].expectedVersion).toBe(0)
    expect(screen.getByText("Teammate edit")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Apply draft to this version" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }))
    await waitFor(() => expect(requests.send).toHaveBeenCalledTimes(2))
    expect(requests.send.mock.calls[1][0].expectedVersion).toBe(1)
  })
  it("restores the saved edit baseline after reload, and requires review for drafts without a baseline", async () => {
    const comment = {
      id: crypto.randomUUID(),
      body: "Latest shared edit",
      version: 4,
    }
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        expectedVersion: 1,
        document: commentFromText("Older draft"),
      })
    )
    const view = render(<SharedCommentInput {...props} comment={comment} />)
    await screen.findByRole("textbox", { name: "Edit comment" })
    requests.send.mockResolvedValueOnce({ status: "conflict", records: [] })
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }))
    await screen.findByRole("button", { name: "Apply draft to this version" })
    expect(requests.send.mock.calls[0][0].expectedVersion).toBe(1)
    view.unmount()
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document: commentFromText("Legacy draft"),
      })
    )
    render(<SharedCommentInput {...props} comment={comment} />)
    expect(
      screen
        .getByRole("button", { name: "Save comment" })
        .hasAttribute("disabled")
    ).toBe(true)
    expect(
      screen.getByRole("button", { name: "Apply draft to this version" })
    ).toBeTruthy()
  })
  it("recovers an oversized failed draft without discarding it or publishing it", async () => {
    const oversized = "a".repeat(10001)
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document: commentFromText(oversized),
      })
    )
    render(<SharedCommentInput {...props} />)
    expect(
      (await screen.findByRole("textbox", { name: "Comment" })).textContent
    ).toBe(oversized)
    fireEvent.click(screen.getByRole("button", { name: "Submit comment" }))
    expect(screen.getByRole("alert").textContent).toContain("10,000")
    expect(requests.send).not.toHaveBeenCalled()
    await waitFor(() => expect(storage.setItem).toHaveBeenCalled())
    expect(JSON.parse(storage.setItem.mock.calls.at(-1)![1]).document).toEqual(
      commentFromText(oversized)
    )
  })
  it("retains unsupported saved data for explicit recovery instead of overwriting it", () => {
    const unsupported = {
      type: "doc",
      content: [{ type: "script", text: "private draft" }],
    }
    storage.getItem.mockReturnValue(
      JSON.stringify({ issueId: props.issueId, document: unsupported })
    )
    render(<SharedCommentInput {...props} />)
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Saved draft recovery",
      }).value
    ).toContain("private draft")
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(document.querySelector("script")).toBeNull()
  })
  it("closes an open mention picker before a pending command can accept more changes", async () => {
    storage.getItem.mockReturnValue(
      JSON.stringify({
        issueId: props.issueId,
        document: commentFromText("Original draft"),
      })
    )
    let settle!: (value: unknown) => void
    requests.send.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    render(<SharedCommentInput {...props} />)
    await screen.findByRole("textbox", { name: "Comment" })
    fireEvent.click(screen.getByRole("button", { name: "Mention a person" }))
    await screen.findByRole("button", { name: "Bob" })
    fireEvent.click(screen.getByRole("button", { name: "Submit comment" }))
    expect(screen.queryByRole("button", { name: "Bob" })).toBeNull()
    expect(
      screen
        .getByRole("button", { name: "Mention a person" })
        .hasAttribute("disabled")
    ).toBe(true)
    settle({ status: "saved", records: [] })
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Comment" }).textContent).toBe(
        ""
      )
    )
    expect(
      JSON.stringify(requests.send.mock.calls[0][0].document)
    ).not.toContain('"mention"')
  })
})

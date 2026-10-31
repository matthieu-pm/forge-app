import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SharedCommentInput } from "./shared-comment-input"
import { commentFromText } from "@/lib/comment-rich-text"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }))
vi.mock("@/lib/product-storage", () => ({ productStorage: storage }))
vi.mock("@/lib/issue-comment-state", () => ({
  loadCommentMentions: vi.fn(),
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
})

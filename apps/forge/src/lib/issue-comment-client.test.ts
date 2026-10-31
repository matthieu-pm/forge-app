import { beforeEach, describe, expect, it, vi } from "vitest"
import { commentDraftKey, sendIssueComment } from "./issue-comment-client"
import { commentFromText } from "./comment-rich-text"
import { replaceCanonicalIssues } from "./canonical-issue-cache"

const mock = vi.hoisted(() => ({
  persist: vi.fn(),
  save: vi.fn(),
  sequence: [] as Array<string>,
}))
vi.mock("./issue-comment-state", () => ({ persistIssueComment: mock.persist }))
vi.mock("./product-storage", () => ({ saveProductValue: mock.save }))
describe("FOR-46 comment retry durability", () => {
  const input = {
    commandKey: crypto.randomUUID(),
    teamId: crypto.randomUUID(),
    issueId: crypto.randomUUID(),
    commentId: crypto.randomUUID(),
    parentId: "",
    action: "create" as const,
    expectedVersion: 0,
    document: commentFromText("Keep my draft"),
  }
  const key = commentDraftKey(input.issueId, "root"),
    draft = { document: input.document }
  const state = {
    workspaceId: "workspace",
    userId: "alice",
    sessionId: "session",
    records: [],
    projects: [],
    cycles: [],
  }
  beforeEach(() => {
    replaceCanonicalIssues(state)
    mock.sequence.length = 0
    mock.save.mockReset().mockImplementation(async (_key, value) => {
      mock.sequence.push(value === null ? "clear" : "save")
    })
    mock.persist.mockReset().mockImplementation(async () => {
      mock.sequence.push("command")
      return JSON.stringify({ status: "saved", records: [] })
    })
  })
  it("durably saves the exact command first, then clears only after confirmation", async () => {
    await sendIssueComment(input, key, draft)
    expect(mock.sequence).toEqual(["save", "command", "clear"])
    expect(JSON.parse(mock.save.mock.calls[0][1]).command).toEqual(input)
  })
  it("retains an uncertain command for exact replay after a lost response", async () => {
    mock.persist.mockRejectedValueOnce(new Error("Response lost"))
    await expect(sendIssueComment(input, key, draft)).rejects.toThrow(
      "Response lost"
    )
    expect(mock.save).toHaveBeenCalledTimes(1)
    await sendIssueComment(input, key, draft)
    expect(mock.persist.mock.calls.map((c) => c[0].data.commandKey)).toEqual([
      input.commandKey,
      input.commandKey,
    ])
  })
  it("never publishes if saving the durable draft fails", async () => {
    mock.save.mockRejectedValueOnce(new Error("Offline"))
    await expect(sendIssueComment(input, key, draft)).rejects.toThrow("Offline")
    expect(mock.persist).not.toHaveBeenCalled()
  })
  it("preserves conflicts as reviewable drafts without reusing their old command", async () => {
    mock.persist.mockResolvedValue(
      JSON.stringify({ status: "conflict", records: [] })
    )
    await sendIssueComment(input, key, draft)
    expect(JSON.parse(mock.save.mock.calls[1][1])).toEqual({
      ...draft,
      issueId: input.issueId,
      requiresReview: true,
    })
  })
  it("ignores an old-session response and does not clear that session's draft", async () => {
    mock.persist.mockImplementation(async () => {
      replaceCanonicalIssues({ ...state, userId: "bob", sessionId: "other" })
      return JSON.stringify({ status: "saved", records: [] })
    })
    await expect(sendIssueComment(input, key, draft)).rejects.toThrow(
      "session changed"
    )
    expect(mock.save).toHaveBeenCalledTimes(1)
  })
})

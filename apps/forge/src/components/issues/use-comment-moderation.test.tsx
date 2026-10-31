import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useCommentModeration } from "./use-comment-moderation"
import type * as CommentClient from "@/lib/issue-comment-client"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"

const requests = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock("@/lib/issue-comment-client", async (original) => ({
  ...(await original<typeof CommentClient>()),
  sendIssueComment: requests.send,
}))
vi.mock("@/lib/product-storage", () => ({
  productStorage: { getItem: () => null },
}))
const identity = {
  workspaceId: "workspace",
  userId: "alice",
  sessionId: "alice",
  records: [],
  projects: [],
  cycles: [],
}
beforeEach(() => {
  replaceCanonicalIssues(identity)
  requests.send.mockReset()
})
describe("comment moderation identity fences", () => {
  it("unblocks the next identity and ignores the old identity's completion during its request", async () => {
    const finishes: Array<(value: unknown) => void> = []
    requests.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve)
        })
    )
    const { result, rerender } = renderHook(() =>
      useCommentModeration("team", "issue")
    )
    let oldRequest!: Promise<void>, newRequest!: Promise<void>
    act(() => {
      oldRequest = result.current.change({ id: "comment" }, "delete")
    })
    expect(result.current.pending).toBe(true)
    replaceCanonicalIssues({ ...identity, userId: "bob", sessionId: "bob" })
    rerender()
    expect(result.current.pending).toBe(false)
    act(() => {
      newRequest = result.current.change({ id: "comment" }, "restore")
    })
    expect(result.current.pending).toBe(true)
    await act(async () => {
      finishes[0]({ status: "saved", records: [] })
      await oldRequest
    })
    expect(result.current.pending).toBe(true)
    await act(async () => {
      await result.current.change({ id: "comment" }, "restore")
    })
    expect(requests.send).toHaveBeenCalledTimes(2)
    await act(async () => {
      finishes[1]({ status: "saved", records: [] })
      await newRequest
    })
    expect(result.current.pending).toBe(false)
  })
})

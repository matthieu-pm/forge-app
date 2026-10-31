import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useIssueEngagement } from "./use-issue-engagement"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"

const mock = vi.hoisted(() => ({ send: vi.fn(), pending: vi.fn() }))
vi.mock("@/lib/issue-engagement-client", () => ({
  sendIssueEngagement: mock.send,
  pendingIssueEngagement: mock.pending,
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
  mock.send.mockReset().mockResolvedValue({ status: "saved", records: [] })
  mock.pending.mockReset().mockReturnValue(null)
})
describe("FOR-47 controls", () => {
  it("does not present the durable in-flight copy as an uncertain outcome", async () => {
    let finish!: (value: unknown) => void
    mock.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { result } = renderHook(() => useIssueEngagement("team", "issue"))
    let sending!: Promise<void>
    act(() => {
      sending = result.current.change({
        action: "subscription",
        subscribed: true,
      })
    })
    mock.pending.mockReturnValue(mock.send.mock.calls[0][0])
    act(() => {
      window.dispatchEvent(new Event("forge:product-storage-changed"))
    })
    expect(result.current.pending).toBe(true)
    expect(result.current.retry).toBe(false)
    await act(async () => {
      finish({ status: "saved" })
      await sending
    })
    expect(result.current.retry).toBe(false)
  })

  it("fences duplicate clicks and ignores completion after an account switch", async () => {
    const finishes: Array<(value: unknown) => void> = []
    mock.send.mockImplementation(
      () => new Promise((resolve) => finishes.push(resolve))
    )
    const { result, rerender } = renderHook(() =>
      useIssueEngagement("team", "issue")
    )
    let old!: Promise<void>, next!: Promise<void>
    act(() => {
      old = result.current.change({ action: "subscription", subscribed: true })
    })
    await act(async () => {
      await result.current.change({ action: "subscription", subscribed: true })
    })
    expect(mock.send).toHaveBeenCalledTimes(1)
    replaceCanonicalIssues({ ...identity, userId: "bob", sessionId: "bob" })
    rerender()
    act(() => {
      next = result.current.change({
        action: "subscription",
        subscribed: false,
      })
    })
    await act(async () => {
      finishes[0]({ status: "saved" })
      await old
    })
    expect(result.current.pending).toBe(true)
    await act(async () => {
      finishes[1]({ status: "saved" })
      await next
    })
    expect(result.current.pending).toBe(false)
  })
  it("offers explicit exact retry and blocks new intent until the uncertain result is known", async () => {
    mock.send.mockRejectedValueOnce(new Error("Lost response"))
    const { result } = renderHook(() => useIssueEngagement("team", "issue"))
    await act(async () => {
      await result.current.change({
        action: "reaction",
        emoji: "👍",
        present: true,
      })
    })
    expect(result.current.retry).toBe(true)
    await act(async () => {
      await result.current.change({
        action: "reaction",
        emoji: "🎉",
        present: true,
      })
    })
    expect(mock.send).toHaveBeenCalledTimes(1)
    await act(async () => {
      await result.current.change()
    })
    expect(mock.send.mock.calls[1][0]).toEqual(mock.send.mock.calls[0][0])
    expect(result.current.retry).toBe(false)
  })
  it("restores retry state after remount without automatically replaying or toggling", async () => {
    const saved = {
      commandKey: crypto.randomUUID(),
      teamId: "team",
      issueId: "issue",
      action: "subscription",
      subscribed: false,
    }
    mock.pending.mockReturnValue(saved)
    const { result } = renderHook(() => useIssueEngagement("team", "issue"))
    expect(result.current.blocked).toBe(true)
    expect(mock.send).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.change()
    })
    expect(mock.send).toHaveBeenCalledWith(saved)
  })
})

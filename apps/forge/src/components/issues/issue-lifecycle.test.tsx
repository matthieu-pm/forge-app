import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useIssueLifecycle } from "./issue-lifecycle"
import {
  canonicalIssueRows,
  mergeCanonicalIssueRecords,
  replaceCanonicalIssues,
} from "@/lib/canonical-issue-cache"
import { persistIssueLifecycle } from "@/lib/issue-lifecycle-state"
import { blankIssueDraft } from "@/lib/issue-record-contract"

vi.mock("@/lib/issue-lifecycle-state", () => ({
  loadInactiveIssues: vi.fn(),
  persistIssueLifecycle: vi.fn(),
}))
const teamId = "00000000-0000-4000-8000-000000000001",
  issueId = "00000000-0000-4000-8000-000000000002"
const record = {
  teamId,
  issue: {
    ...blankIssueDraft(),
    id: issueId,
    number: 1,
    revision: 3,
    createdAt: "2026-10-30T00:00:00Z",
    updatedAt: "2026-10-30T00:00:00Z",
    creator: "alice",
    completedAt: null,
    recurrenceSpawned: false,
    statusChangedAt: "2026-10-30T00:00:00Z",
    suggestedLabel: "",
  },
}
const input = {
  teamId,
  issueId,
  expectedRevision: 3,
  action: "delete" as const,
}
function seed(workspaceId = "workspace") {
  replaceCanonicalIssues({
    workspaceId,
    userId: "alice",
    sessionId: "session",
    records: [record],
    cycles: [],
    projects: [],
  })
}
beforeEach(() => {
  seed()
  vi.mocked(persistIssueLifecycle).mockReset()
})
afterEach(() => {
  cleanup()
  replaceCanonicalIssues(null)
})
describe("FOR-45 lifecycle client", () => {
  it("retains the command key after an uncertain response and suppresses late stale rows after success", async () => {
    vi.mocked(persistIssueLifecycle)
      .mockRejectedValueOnce(new Error("Network interrupted"))
      .mockResolvedValueOnce(
        JSON.stringify({ status: "saved", value: { revision: 4 } })
      )
    const { result } = renderHook(() => useIssueLifecycle())
    await act(async () => {
      expect(await result.current.change(input)).toBe(false)
    })
    expect(canonicalIssueRows(teamId)).toHaveLength(1)
    await act(async () => {
      expect(await result.current.change(input)).toBe(true)
    })
    expect(
      vi.mocked(persistIssueLifecycle).mock.calls[0][0].data.commandKey
    ).toBe(vi.mocked(persistIssueLifecycle).mock.calls[1][0].data.commandKey)
    expect(canonicalIssueRows(teamId)).toHaveLength(0)
    act(() => mergeCanonicalIssueRecords([record]))
    expect(canonicalIssueRows(teamId)).toHaveLength(0)
    act(() =>
      mergeCanonicalIssueRecords([
        { ...record, issue: { ...record.issue, revision: 5 } },
      ])
    )
    expect(canonicalIssueRows(teamId)[0].issue.revision).toBe(5)
  })
  it("shows a conflict without unmounting the current detail or changing its content", async () => {
    vi.mocked(persistIssueLifecycle).mockResolvedValue(
      JSON.stringify({ status: "conflict" })
    )
    const invalidate = vi.fn()
    window.addEventListener("forge:issue-queries-invalidated", invalidate)
    const { result } = renderHook(() => useIssueLifecycle())
    await act(async () => {
      expect(await result.current.change(input)).toBe(false)
    })
    expect(result.current.error).toContain("Reload and review")
    expect(invalidate).not.toHaveBeenCalled()
    expect(canonicalIssueRows(teamId)).toHaveLength(1)
    window.removeEventListener("forge:issue-queries-invalidated", invalidate)
  })
  it("ignores a completed operation after the workspace changed", async () => {
    let resolve!: (value: string) => void
    vi.mocked(persistIssueLifecycle).mockImplementation(
      () =>
        new Promise<string>((r) => {
          resolve = r
        })
    )
    const { result } = renderHook(() => useIssueLifecycle())
    let pending!: Promise<boolean>
    act(() => {
      pending = result.current.change(input)
    })
    act(() => seed("other-workspace"))
    await act(async () => {
      resolve(JSON.stringify({ status: "saved", value: { revision: 4 } }))
      expect(await pending).toBe(false)
    })
    expect(canonicalIssueRows(teamId)).toHaveLength(1)
  })
  it("keeps the current row when a capacity refusal occurs", async () => {
    vi.mocked(persistIssueLifecycle).mockRejectedValue(
      new Error("This workspace has reached 250 active issues.")
    )
    const { result } = renderHook(() => useIssueLifecycle())
    await act(async () => {
      expect(await result.current.change({ ...input, action: "restore" })).toBe(
        false
      )
    })
    expect(result.current.error).toContain("250 active")
    expect(result.current.pending).toBe(false)
    expect(canonicalIssueRows(teamId)).toHaveLength(1)
  })
})

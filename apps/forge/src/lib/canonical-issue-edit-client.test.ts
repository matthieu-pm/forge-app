import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  canonicalIssueRows,
  canonicalIssueState,
  replaceCanonicalIssues,
} from "./canonical-issue-cache"
import { blankIssueDraft, issueSchema } from "./issue-record-contract"
import {
  applyEditsToLatest,
  enqueueIssueEdits,
  flushIssueEdits,
  hydrateIssueEdits,
  issueEditSnapshot,
  resetIssueEdits,
  useLatestIssueVersions,
} from "./canonical-issue-edit-client"
import { persistCanonicalIssueEdits } from "./canonical-issue-state"
import { productStorage, saveProductValue } from "./product-storage"
import type * as ProductStorage from "./product-storage"

vi.mock("./canonical-issue-state", () => ({
  persistCanonicalIssueEdits: vi.fn(),
  persistCanonicalIssue: vi.fn(),
  loadCanonicalIssues: vi.fn(),
  importCanonicalProjectState: vi.fn(),
}))
vi.mock("./product-storage", async (original) => {
  const actual = await original<typeof ProductStorage>()
  return {
    ...actual,
    saveProductValue: vi.fn(async (key: string, value: string | null) => {
      if (value === null) actual.productStorage.removeItem(key)
      else actual.productStorage.setItem(key, value)
    }),
  }
})
const teamId = "60109b0b-7cd4-4097-9883-196a80ff2493",
  id = "02fb5f39-eaac-4d41-a658-f2ac45e17acb"
const original = issueSchema.parse({
  ...blankIssueDraft("todo"),
  id,
  number: 1,
  revision: 0,
  title: "Original",
  creator: "user",
  createdAt: "2026-10-30T12:00:00.000Z",
  updatedAt: "2026-10-30T12:00:00.000Z",
  statusChangedAt: "2026-10-30T12:00:00.000Z",
  suggestedLabel: "",
  completedAt: null,
})
const snapshot = () => ({
  workspaceId: "workspace",
  userId: "user",
  sessionId: "session",
  records: [{ teamId, issue: { ...original } }],
  projects: [],
  cycles: [],
})
beforeEach(() => {
  productStorage.clear()
  resetIssueEdits()
  replaceCanonicalIssues(null, false)
  replaceCanonicalIssues(snapshot())
  vi.mocked(persistCanonicalIssueEdits).mockReset()
  vi.mocked(saveProductValue).mockClear()
})
afterEach(() => {
  resetIssueEdits()
  replaceCanonicalIssues(null, false)
  productStorage.clear()
  vi.restoreAllMocks()
})
describe("canonical issue edit queue", () => {
  it("persists a retry draft before sending an optimistic, version-bound edit", async () => {
    let resolve!: (value: string) => void
    vi.mocked(persistCanonicalIssueEdits).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    enqueueIssueEdits(teamId, [
      { before: original, changes: { title: "Mine" } },
    ])
    await vi.waitFor(() =>
      expect(persistCanonicalIssueEdits).toHaveBeenCalled()
    )
    const request = vi.mocked(persistCanonicalIssueEdits).mock.calls[0][0].data
    expect(request.edits[0]).toMatchObject({
      issueId: id,
      expectedRevision: 0,
      changes: { title: "Mine" },
    })
    expect(canonicalIssueRows(teamId)[0].issue.title).toBe("Mine")
    expect(vi.mocked(saveProductValue).mock.calls[0][0]).toContain(
      "team-issue-edit-drafts"
    )
    resolve(
      JSON.stringify({
        status: "saved",
        records: [
          { teamId, issue: { ...original, title: "Mine", revision: 1 } },
        ],
      })
    )
    await vi.waitFor(() =>
      expect(JSON.parse(issueEditSnapshot()).pending).toBe(0)
    )
    expect(canonicalIssueRows(teamId)[0].issue.revision).toBe(1)
  })
  it("returns to shared state on conflict and preserves a field-only draft for explicit rebase", async () => {
    const latest = {
      ...original,
      title: "Other writer",
      priority: "High" as const,
      revision: 1,
    }
    vi.mocked(persistCanonicalIssueEdits).mockResolvedValueOnce(
      JSON.stringify({
        status: "conflict",
        records: [{ teamId, issue: latest }],
      })
    )
    enqueueIssueEdits(teamId, [
      { before: original, changes: { description: "My description" } },
    ])
    await vi.waitFor(() =>
      expect(JSON.parse(issueEditSnapshot()).conflict).toBe(true)
    )
    expect(canonicalIssueRows(teamId)[0].issue).toMatchObject({
      title: "Other writer",
      priority: "High",
      description: "",
    })
    expect(JSON.parse(issueEditSnapshot()).drafts[0].changes).toEqual({
      description: "My description",
    })
    const first = vi.mocked(persistCanonicalIssueEdits).mock.calls[0][0].data
    vi.mocked(persistCanonicalIssueEdits).mockResolvedValueOnce(
      JSON.stringify({
        status: "saved",
        records: [
          {
            teamId,
            issue: { ...latest, description: "My description", revision: 2 },
          },
        ],
      })
    )
    await applyEditsToLatest()
    await vi.waitFor(() =>
      expect(JSON.parse(issueEditSnapshot()).pending).toBe(0)
    )
    const rebased = vi.mocked(persistCanonicalIssueEdits).mock.calls[1][0].data
    expect(rebased.commandKey).not.toBe(first.commandKey)
    expect(rebased.edits[0]).toMatchObject({
      expectedRevision: 1,
      changes: { description: "My description" },
    })
    expect(canonicalIssueRows(teamId)[0].issue.priority).toBe("High")
  })
  it("retries an unknown transport outcome with the identical command key", async () => {
    vi.mocked(persistCanonicalIssueEdits).mockRejectedValueOnce(
      new Error("Offline")
    )
    enqueueIssueEdits(teamId, [
      { before: original, changes: { priority: "Low" } },
    ])
    await vi.waitFor(() =>
      expect(JSON.parse(issueEditSnapshot()).error).toBe("Offline")
    )
    const first = vi.mocked(persistCanonicalIssueEdits).mock.calls[0][0]
    vi.mocked(persistCanonicalIssueEdits).mockResolvedValueOnce(
      JSON.stringify({
        status: "saved",
        records: [
          { teamId, issue: { ...original, priority: "Low", revision: 1 } },
        ],
      })
    )
    await flushIssueEdits()
    expect(vi.mocked(persistCanonicalIssueEdits).mock.calls[1][0]).toEqual(
      first
    )
  })
  it("restores saved edits after reload without applying them until the user retries", async () => {
    vi.mocked(persistCanonicalIssueEdits).mockRejectedValueOnce(
      new Error("Offline")
    )
    enqueueIssueEdits(teamId, [
      { before: original, changes: { title: "Saved draft" } },
    ])
    await vi.waitFor(() =>
      expect(JSON.parse(issueEditSnapshot()).error).toBe("Offline")
    )
    resetIssueEdits()
    replaceCanonicalIssues(null, false)
    replaceCanonicalIssues(snapshot())
    vi.mocked(persistCanonicalIssueEdits).mockClear()
    hydrateIssueEdits()
    expect(JSON.parse(issueEditSnapshot()).pending).toBe(1)
    expect(persistCanonicalIssueEdits).not.toHaveBeenCalled()
    expect(canonicalIssueRows(teamId)[0].issue.title).toBe("Original")
  })
  it("persists batches queued behind a conflict and restores each without executing", async () => {
    let resolve!: (value: string) => void
    vi.mocked(persistCanonicalIssueEdits).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    enqueueIssueEdits(teamId, [
      { before: original, changes: { title: "First" } },
    ])
    await vi.waitFor(() =>
      expect(persistCanonicalIssueEdits).toHaveBeenCalledTimes(1)
    )
    enqueueIssueEdits(teamId, [
      { before: original, changes: { description: "Second" } },
    ])
    resolve(
      JSON.stringify({
        status: "conflict",
        records: [{ teamId, issue: { ...original, revision: 1 } }],
      })
    )
    await vi.waitFor(() =>
      expect(JSON.parse(issueEditSnapshot()).conflict).toBe(true)
    )
    resetIssueEdits()
    hydrateIssueEdits()
    expect(
      JSON.parse(issueEditSnapshot()).drafts.map(
        (draft: { changes: unknown }) => draft.changes
      )
    ).toEqual([{ title: "First" }, { description: "Second" }])
    expect(persistCanonicalIssueEdits).toHaveBeenCalledTimes(1)
  })
  it("replaces a conflict draft in one slot and retains its identity through a save failure", async () => {
    vi.mocked(persistCanonicalIssueEdits).mockResolvedValueOnce(
      JSON.stringify({
        status: "conflict",
        records: [{ teamId, issue: { ...original, revision: 1 } }],
      })
    )
    enqueueIssueEdits(teamId, [
      { before: original, changes: { subIssues: ["Child"] } },
    ])
    await vi.waitFor(() =>
      expect(JSON.parse(issueEditSnapshot()).conflict).toBe(true)
    )
    const initialKeys = Array.from(
      { length: productStorage.length },
      (_, index) => productStorage.key(index)
    )
    vi.mocked(saveProductValue).mockImplementationOnce(async (key, value) => {
      productStorage.setItem(key, value!)
      throw new Error("Acknowledgment lost")
    })
    await applyEditsToLatest()
    expect(persistCanonicalIssueEdits).toHaveBeenCalledTimes(1)
    expect(
      Array.from({ length: productStorage.length }, (_, index) =>
        productStorage.key(index)
      )
    ).toEqual(initialKeys)
    const prepared = JSON.parse(productStorage.getItem(initialKeys[0])!)
    resetIssueEdits()
    hydrateIssueEdits()
    expect(JSON.parse(issueEditSnapshot()).pending).toBe(1)
    vi.mocked(persistCanonicalIssueEdits).mockResolvedValueOnce(
      JSON.stringify({
        status: "saved",
        records: [{ teamId, issue: { ...original, revision: 2 } }],
      })
    )
    await flushIssueEdits()
    expect(
      vi.mocked(persistCanonicalIssueEdits).mock.calls[1][0].data.commandKey
    ).toBe(prepared.commandKey)
  })
  it("keeps edits enqueued while an earlier draft is being discarded", async () => {
    vi.mocked(persistCanonicalIssueEdits).mockRejectedValueOnce(
      new Error("Offline")
    )
    enqueueIssueEdits(teamId, [
      { before: original, changes: { title: "Discard me" } },
    ])
    await vi.waitFor(() =>
      expect(JSON.parse(issueEditSnapshot()).error).toBe("Offline")
    )
    let finish!: () => void
    vi.mocked(saveProductValue).mockImplementationOnce(
      (key) =>
        new Promise<void>((resolve) => {
          finish = () => {
            productStorage.removeItem(key)
            resolve()
          }
        })
    )
    const discard = useLatestIssueVersions()
    enqueueIssueEdits(teamId, [
      { before: original, changes: { description: "Keep me" } },
    ])
    let respond!: (response: string) => void
    vi.mocked(persistCanonicalIssueEdits).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve
        })
    )
    finish()
    await discard
    await vi.waitFor(() =>
      expect(persistCanonicalIssueEdits).toHaveBeenCalledTimes(2)
    )
    expect(JSON.parse(issueEditSnapshot()).drafts).toHaveLength(1)
    expect(JSON.parse(issueEditSnapshot()).drafts[0].changes).toEqual({
      description: "Keep me",
    })
    const keys = Array.from({ length: productStorage.length }, (_, index) =>
      productStorage.key(index)
    )
    expect(keys).toHaveLength(1)
    respond(
      JSON.stringify({
        status: "saved",
        records: [
          {
            teamId,
            issue: { ...original, description: "Keep me", revision: 1 },
          },
        ],
      })
    )
    await vi.waitFor(() =>
      expect(JSON.parse(issueEditSnapshot()).pending).toBe(0)
    )
  })
  it("never replaces an uncertain command key with a rebase, including child additions", async () => {
    vi.mocked(persistCanonicalIssueEdits).mockRejectedValueOnce(
      new Error("Response lost")
    )
    enqueueIssueEdits(teamId, [
      { before: original, changes: { subIssues: ["Child"] } },
    ])
    await vi.waitFor(() =>
      expect(JSON.parse(issueEditSnapshot()).error).toBe("Response lost")
    )
    await applyEditsToLatest()
    expect(persistCanonicalIssueEdits).toHaveBeenCalledTimes(1)
    vi.mocked(persistCanonicalIssueEdits).mockResolvedValueOnce(
      JSON.stringify({
        status: "saved",
        records: [{ teamId, issue: { ...original, revision: 1 } }],
      })
    )
    await flushIssueEdits()
    expect(vi.mocked(persistCanonicalIssueEdits).mock.calls[1][0]).toEqual(
      vi.mocked(persistCanonicalIssueEdits).mock.calls[0][0]
    )
  })
  it("ignores a completed write after the active identity changes", async () => {
    let resolve!: (value: string) => void
    vi.mocked(persistCanonicalIssueEdits).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    enqueueIssueEdits(teamId, [
      { before: original, changes: { title: "Old session" } },
    ])
    await vi.waitFor(() =>
      expect(persistCanonicalIssueEdits).toHaveBeenCalled()
    )
    resetIssueEdits()
    replaceCanonicalIssues(null, false)
    replaceCanonicalIssues({
      ...snapshot(),
      userId: "other",
      sessionId: "other-session",
      records: [],
    })
    resolve(
      JSON.stringify({
        status: "saved",
        records: [
          { teamId, issue: { ...original, title: "Old session", revision: 1 } },
        ],
      })
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(canonicalIssueState()!.records).toEqual([])
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  pendingIssueEngagement,
  sendIssueEngagement,
} from "./issue-engagement-client"
import {
  canonicalIssueState,
  removeCanonicalIssueRecords,
  replaceCanonicalIssues,
} from "./canonical-issue-cache"
import { blankIssueDraft } from "./issue-record-contract"
import { issueEngagementCommandSchema } from "./issue-engagement-contract"
import { issueChangesSchema } from "./canonical-issue-edit-contract"

const mock = vi.hoisted(() => ({
  persist: vi.fn(),
  save: vi.fn(),
  get: vi.fn(),
  order: [] as Array<string>,
}))
vi.mock("./issue-engagement-state", () => ({
  persistIssueEngagement: mock.persist,
}))
vi.mock("./product-storage", () => ({
  saveProductValue: mock.save,
  productStorage: { getItem: mock.get },
}))
const state = {
  workspaceId: "workspace",
  userId: "bob",
  sessionId: "session",
  records: [],
  projects: [],
  cycles: [],
}
const input = {
  commandKey: crypto.randomUUID(),
  teamId: crypto.randomUUID(),
  issueId: crypto.randomUUID(),
  action: "reaction" as const,
  commentId: crypto.randomUUID(),
  emoji: "👍",
  present: true,
}
beforeEach(() => {
  replaceCanonicalIssues(state)
  mock.order.length = 0
  mock.get.mockReset().mockReturnValue(null)
  mock.save.mockReset().mockImplementation(async (_key, value) => {
    mock.order.push(value === null ? "clear" : "save")
  })
  mock.persist.mockReset().mockImplementation(async () => {
    mock.order.push("command")
    return JSON.stringify({ status: "saved", records: [] })
  })
})
describe("FOR-47 durable desired-state commands", () => {
  it("saves the exact command before publishing and clears after confirmation", async () => {
    await sendIssueEngagement(input)
    expect(mock.order).toEqual(["save", "command", "clear"])
    expect(JSON.parse(mock.save.mock.calls[0][1])).toEqual({
      issueId: input.issueId,
      command: input,
    })
  })
  it("keeps an uncertain command and replays it without toggling", async () => {
    mock.persist.mockRejectedValueOnce(new Error("Response lost"))
    await expect(sendIssueEngagement(input)).rejects.toThrow("Response lost")
    expect(mock.order).toEqual(["save"])
    mock.get.mockReturnValue(
      JSON.stringify({ issueId: input.issueId, command: input })
    )
    const restored = pendingIssueEngagement(input.issueId)!
    await sendIssueEngagement(restored)
    expect(mock.persist.mock.calls.map((call) => call[0].data.command)).toEqual(
      [input, input]
    )
  })
  it("does not publish if preserving the retry identity fails", async () => {
    mock.save.mockRejectedValueOnce(new Error("Offline"))
    await expect(sendIssueEngagement(input)).rejects.toThrow("Offline")
    expect(mock.persist).not.toHaveBeenCalled()
  })
  it("ignores old-session responses and retains the original retry", async () => {
    mock.persist.mockImplementation(async () => {
      replaceCanonicalIssues({
        ...state,
        userId: "alice",
        sessionId: "different",
      })
      return JSON.stringify({ status: "saved", records: [] })
    })
    await expect(sendIssueEngagement(input)).rejects.toThrow("session changed")
    expect(mock.save).toHaveBeenCalledTimes(1)
  })
  it("does not publish a saved command for a different issue", () => {
    mock.get.mockReturnValue(
      JSON.stringify({ command: { ...input, issueId: crypto.randomUUID() } })
    )
    expect(() => pendingIssueEngagement(input.issueId)).toThrow("Invalid saved")
  })
  it("rejects actor injection, bulk lists, and subscriber edits", () => {
    expect(
      issueEngagementCommandSchema.safeParse({ ...input, userId: "alice" })
        .success
    ).toBe(false)
    expect(
      issueEngagementCommandSchema.safeParse({ ...input, users: ["alice"] })
        .success
    ).toBe(false)
    expect(issueChangesSchema.safeParse({ subscribers: "alice" }).success).toBe(
      false
    )
  })
})

it("FOR-51 review: a delayed confirmed mutation cannot restore an evicted private record and still clears its receipt draft", async () => {
  const record = {
    teamId: input.teamId,
    issue: {
      ...blankIssueDraft(),
      id: input.issueId,
      number: 1,
      creator: "alice",
      revision: 2,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      statusChangedAt: "2026-01-01T00:00:00Z",
      suggestedLabel: "",
      completedAt: null,
      recurrenceSpawned: false,
    },
  }
  replaceCanonicalIssues({ ...state, records: [record] })
  let finish!: (raw: string) => void
  mock.persist.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const sending = sendIssueEngagement(input)
  await vi.waitFor(() => expect(mock.persist).toHaveBeenCalledTimes(1))
  removeCanonicalIssueRecords([input.issueId], { requireAuthorizedRead: true })
  finish(JSON.stringify({ status: "saved", records: [record] }))
  await expect(sending).resolves.toMatchObject({ status: "saved" })
  expect(mock.save.mock.calls.at(-1)?.[1]).toBeNull()
  expect(canonicalIssueState()?.records).toEqual([])
})

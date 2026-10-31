import { afterEach, expect, it, vi } from "vitest"
import { createSharedTeamIssue } from "./canonical-issue-client"
import { finishCreatedIssueFiles } from "./issue-file-client"
import { blankIssueDraft, issueSchema } from "./issue-record-contract"
import {
  mergeCanonicalIssueRecords,
  replaceCanonicalIssues,
} from "./canonical-issue-cache"
import {
  loadCanonicalIssues,
  persistCanonicalIssue,
} from "./canonical-issue-state"

vi.mock("./canonical-issue-state", () => ({
  loadCanonicalIssues: vi.fn(),
  persistCanonicalIssue: vi.fn(),
}))
vi.mock("./issue-file-client", () => ({ finishCreatedIssueFiles: vi.fn() }))
afterEach(() => {
  replaceCanonicalIssues(null, false)
  vi.resetAllMocks()
})
it("replays an identical prepared create after its response is lost and a relation appears", async () => {
  const teamId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    state = {
      workspaceId: "workspace",
      sessionId: "session",
      userId: "user",
      records: [],
      projects: [],
      cycles: [],
    }
  replaceCanonicalIssues(state)
  vi.mocked(persistCanonicalIssue).mockRejectedValueOnce(
    new Error("Response lost")
  )
  const draft = {
      ...blankIssueDraft("todo"),
      title: "Retry me",
      cycle: "2026-10-26",
    },
    options = { commandKey: crypto.randomUUID() }
  await expect(createSharedTeamIssue(teamId, draft, options)).rejects.toThrow(
    "Response lost"
  )
  const refreshed = {
    ...state,
    cycles: [
      {
        id: crypto.randomUUID(),
        teamId,
        startDate: "2026-10-26",
        endDate: "2026-11-08",
      },
    ],
  }
  replaceCanonicalIssues(refreshed)
  vi.mocked(loadCanonicalIssues).mockResolvedValue(JSON.stringify(refreshed))
  vi.mocked(persistCanonicalIssue).mockResolvedValueOnce(
    JSON.stringify({ issue: { id }, records: [] })
  )
  await createSharedTeamIssue(teamId, draft, options)
  expect(vi.mocked(persistCanonicalIssue).mock.calls[1][0]).toEqual(
    vi.mocked(persistCanonicalIssue).mock.calls[0][0]
  )
})

it("uploads creation files after metadata refresh and returns the final durable projection", async () => {
  const teamId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    fileId = crypto.randomUUID()
  const state = {
    workspaceId: "workspace",
    sessionId: "session",
    userId: "user",
    records: [],
    projects: [],
    cycles: [],
  }
  replaceCanonicalIssues(state)
  const draft = {
    ...blankIssueDraft("todo"),
    title: "Created with evidence",
    attachments: [
      { name: "evidence.txt", data: "data:text/plain;base64,ZXZpZGVuY2U=" },
    ],
  }
  const issue = issueSchema.parse({
    ...draft,
    attachments: [],
    id,
    number: 1,
    creator: "user",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    statusChangedAt: new Date().toISOString(),
    suggestedLabel: "",
    completedAt: null,
  })
  const final = {
    ...issue,
    revision: 1,
    attachments: [{ name: "evidence.txt", data: "", fileId }],
  }
  vi.mocked(loadCanonicalIssues).mockResolvedValue(JSON.stringify(state))
  vi.mocked(persistCanonicalIssue).mockResolvedValue(
    JSON.stringify({ issue, records: [{ teamId, issue }] })
  )
  vi.mocked(finishCreatedIssueFiles).mockImplementation(async () => {
    mergeCanonicalIssueRecords([{ teamId, issue: final }])
  })
  const options = { commandKey: crypto.randomUUID() }
  expect(await createSharedTeamIssue(teamId, draft, options)).toEqual(final)
  expect(
    vi.mocked(persistCanonicalIssue).mock.calls[0][0].data.draft.attachments
  ).toEqual(draft.attachments)
  expect(finishCreatedIssueFiles).toHaveBeenCalledWith(
    teamId,
    id,
    draft.attachments,
    options.commandKey,
    true
  )
})

it("returns the committed issue when attachment completion or metadata refresh fails", async () => {
  const teamId = crypto.randomUUID(),
    id = crypto.randomUUID()
  const state = {
    workspaceId: "workspace",
    sessionId: "session",
    userId: "user",
    records: [],
    projects: [],
    cycles: [],
  }
  replaceCanonicalIssues(state)
  const draft = {
    ...blankIssueDraft("todo"),
    title: "Already created",
    attachments: [
      { name: "refused.txt", data: "data:text/plain;base64,ZXZpZGVuY2U=" },
    ],
  }
  const issue = issueSchema.parse({
    ...draft,
    attachments: [],
    id,
    number: 1,
    creator: "user",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    statusChangedAt: new Date().toISOString(),
    suggestedLabel: "",
    completedAt: null,
  })
  vi.mocked(loadCanonicalIssues).mockRejectedValue(
    new Error("Offline metadata")
  )
  vi.mocked(persistCanonicalIssue).mockResolvedValue(
    JSON.stringify({ issue, records: [{ teamId, issue }] })
  )
  vi.mocked(finishCreatedIssueFiles).mockRejectedValue(
    new Error("File type refused")
  )
  expect(
    await createSharedTeamIssue(teamId, draft, {
      commandKey: crypto.randomUUID(),
    })
  ).toEqual(issue)
  expect(persistCanonicalIssue).toHaveBeenCalledTimes(1)
})

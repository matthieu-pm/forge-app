import { afterEach, expect, it, vi } from "vitest"
import { createSharedTeamIssue } from "./canonical-issue-client"
import { replaceCanonicalIssues } from "./canonical-issue-cache"
import {
  loadCanonicalIssues,
  persistCanonicalIssue,
} from "./canonical-issue-state"
import { blankIssueDraft } from "./issue-record-contract"

vi.mock("./canonical-issue-state", () => ({
  loadCanonicalIssues: vi.fn(),
  persistCanonicalIssue: vi.fn(),
}))
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

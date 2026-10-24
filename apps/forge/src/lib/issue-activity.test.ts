import { describe, expect, it } from "vitest"
import { issueActivityTimeline } from "./issue-activity"
import { blankIssueDraft, issueDraftSchema } from "./team-issues"

const event = (id: string, seconds: number, author = "You") => ({
  id,
  author,
  text: "updated priority",
  createdAt: new Date(seconds * 1000).toISOString(),
})
describe("issue activity timeline", () => {
  it("interleaves comments and updates by time without pulling replies out of their thread", () => {
    const issue = issueDraftSchema.parse({
      ...blankIssueDraft(),
      activity: [event("later", 50), event("first", 10)],
      comments: [
        {
          id: "root",
          author: "You",
          body: "Review",
          createdAt: new Date(20_000).toISOString(),
        },
        {
          id: "reply",
          parentId: "root",
          author: "You",
          body: "Reply",
          createdAt: new Date(60_000).toISOString(),
        },
      ],
    })
    expect(
      issueActivityTimeline(issue).map((entry) => [entry.kind, entry.id])
    ).toEqual([
      ["updates", "first"],
      ["comment", "root"],
      ["updates", "later"],
    ])
    expect(issue.activity.map((entry) => entry.id)).toEqual(["later", "first"])
  })
  it("groups nearby changes only for the same author and a bounded time window", () => {
    const timeline = issueActivityTimeline({
      comments: [],
      activity: [
        event("priority", 10),
        event("label", 20),
        event("project", 21, "Other"),
        event("status", 90, "Other"),
      ],
    })
    expect(
      timeline.map((entry) =>
        entry.kind === "updates" ? entry.events.map((item) => item.id) : []
      )
    ).toEqual([["priority", "label"], ["project"], ["status"]])
  })
})

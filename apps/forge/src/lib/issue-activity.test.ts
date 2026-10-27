import { describe, expect, it } from "vitest"
import {
  activityContextFilter,
  activityReferenceIssues,
  activityReferenceSearch,
  activitySegments,
  issueActivityTimeline,
  readActivitySearch,
} from "./issue-activity"
import {
  blankIssueDraft,
  initialIssueStore,
  issueDraftSchema,
  parseIssueStore,
} from "./team-issues"

const event = (id: string, seconds: number, author = "You") => ({
  id,
  author,
  text: "updated priority",
  createdAt: new Date(seconds * 1000).toISOString(),
})
describe("issue activity timeline", () => {
  it("keeps entity references separate from prose and preserves removed values", () => {
    expect(
      activitySegments(
        {
          ...event("project", 1),
          field: "project",
          from: "Former project",
          to: "",
        },
        "me"
      )
    ).toEqual([
      { text: "removed from project " },
      { kind: "project", value: "Former project" },
    ])
    expect(
      activitySegments(
        {
          ...event("label", 1),
          field: "labels",
          from: "Bug, API",
          to: "API, Improvement",
        },
        "me"
      )
    ).toEqual([
      { text: "added label " },
      { kind: "label", value: "Improvement" },
      { text: " and " },
      { text: "removed label " },
      { kind: "label", value: "Bug" },
    ])
    expect(activitySegments(event("legacy", 1), "me")).toEqual([
      { text: "updated priority" },
    ])
  })
  it("builds exact context filters and ignores malformed links", () => {
    expect(activityReferenceSearch("label", "Bug")).toEqual({
      view: "all",
      label: "Bug",
    })
    expect(activityReferenceSearch("member", "member-id")).toEqual({
      view: "all",
      assignee: "member-id",
    })
    expect(activityContextFilter({ project: " Story mapping " })).toMatchObject(
      { field: "project", operator: "is", value: "Story mapping" }
    )
    expect(activityContextFilter({ label: "Bug" })).toMatchObject({
      field: "labels",
      value: "Bug",
    })
    expect(
      readActivitySearch({
        label: ["Bug"],
        project: " ",
        assignee: "x".repeat(201),
      })
    ).toEqual({})
  })
  it("counts current linked issues exactly rather than substring matches or stored label totals", () => {
    const base = {
      ...blankIssueDraft(),
      title: "Task",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      statusChangedAt: new Date(0).toISOString(),
      creator: "You",
      suggestedLabel: "",
      completedAt: null,
      recurrenceSpawned: false,
    }
    const issues = parseIssueStore(
      JSON.stringify({
        ...initialIssueStore(),
        nextNumber: 3,
        issues: [
          {
            ...base,
            id: "a",
            number: 1,
            project: "Story mapping",
            assignee: "member-id",
            labels: "Bug, API",
          },
          { ...base, id: "b", number: 2, project: "Other", labels: "Bugfix" },
        ],
      })
    ).issues
    expect(
      activityReferenceIssues(issues, "label", "Bug").map((issue) => issue.id)
    ).toEqual(["a"])
    expect(
      activityReferenceIssues(issues, "project", "Story mapping")
    ).toHaveLength(1)
    expect(activityReferenceIssues(issues, "member", "member-id")).toHaveLength(
      1
    )
  })
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

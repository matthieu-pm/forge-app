import { beforeEach, describe, expect, it } from "vitest"
import {
  defaultMyIssuePreferences,
  isMyIssue,
  myIssueActivity,
  myIssuePreferencesKey,
  myIssuePreferencesSchema,
  readMyIssueSearch,
} from "./my-issues"
import { blankIssueDraft, saveTeamIssue } from "./team-issues"
import { productStorage } from "@/lib/product-storage"

beforeEach(() => productStorage.clear())
describe("My issues scope", () => {
  it("matches exact identities and separates assigned, created, and subscribed issues", () => {
    const issue = saveTeamIssue(
      "team",
      {
        ...blankIssueDraft(),
        title: "Issue",
        assignee: "other",
        subscribers: "user-long, user",
      },
      { creator: "creator" }
    )
    expect(isMyIssue(issue, "assigned", "user")).toBe(false)
    expect(isMyIssue(issue, "assigned", "other")).toBe(true)
    expect(isMyIssue(issue, "created", "creator")).toBe(true)
    expect(isMyIssue(issue, "created", "user")).toBe(false)
    expect(isMyIssue(issue, "subscribed", "user")).toBe(true)
    expect(
      isMyIssue({ ...issue, subscribers: "user-long" }, "subscribed", "user")
    ).toBe(false)
    expect(isMyIssue({ ...issue, creator: "You" }, "created", "")).toBe(false)
    expect(isMyIssue({ ...issue, creator: "You" }, "created", "user")).toBe(
      true
    )
  })
  it("returns the user's real events and comment anchors, excluding other authors and deleted comments", () => {
    const issue = saveTeamIssue(
      "team",
      { ...blankIssueDraft(), title: "Issue" },
      { creator: "other" }
    )
    const withActivity = {
      ...issue,
      activity: [
        {
          id: "one",
          author: "user",
          text: "set priority to High",
          createdAt: "2026-10-24T08:00:00Z",
        },
        {
          id: "two",
          author: "other",
          text: "set priority to Low",
          createdAt: "2026-10-24T09:00:00Z",
        },
      ],
      comments: [
        {
          id: "comment",
          author: "user",
          parentId: "",
          attachmentId: "",
          body: "Reply",
          createdAt: "2026-10-24T10:00:00Z",
          deleted: false,
          edited: false,
          resolved: false,
          reactions: [],
        },
        {
          id: "removed",
          author: "user",
          parentId: "",
          attachmentId: "",
          body: "Deleted",
          createdAt: "2026-10-24T11:00:00Z",
          deleted: true,
          edited: false,
          resolved: false,
          reactions: [],
        },
      ],
    }
    expect(isMyIssue(withActivity, "activity", "user")).toBe(true)
    expect(
      myIssueActivity(withActivity, "user").map((event) => event.id)
    ).toEqual(["update-one", "comment-comment"])
    expect(myIssueActivity(withActivity, "user")[0].at).toBe(
      "2026-10-24T08:00:00Z"
    )
  })
  it("validates URL tabs and scopes preferences separately from team and other user settings", () => {
    expect(readMyIssueSearch({ view: "unknown", issue: 123 })).toEqual({
      view: "assigned",
    })
    expect(readMyIssueSearch({ view: "subscribed", issue: "id" })).toEqual({
      view: "subscribed",
      issue: "id",
    })
    expect(myIssuePreferencesKey("workspace:user")).not.toBe(
      myIssuePreferencesKey("workspace:other")
    )
    expect(
      myIssuePreferencesSchema.parse(defaultMyIssuePreferences()).filters.rules
    ).toEqual([])
    expect(() => myIssuePreferencesSchema.parse({ version: 2 })).toThrow()
  })
})

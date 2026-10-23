import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  blankIssueDraft,
  defaultIssueDisplay,
  emptyIssueFilters,
  initialIssueStore,
  matchesIssueFilters,
  moveTeamIssue,
  parseIssueStore,
  readIssueStore,
  saveIssueDraft,
  saveTeamIssue,
  teamIssuesKey,
  visibleIssues,
  writeIssueStore,
} from "./team-issues"
import { initialTeamStatuses } from "./team-statuses"

const team = "issue-page-tests"
const statuses = initialTeamStatuses().statuses
beforeEach(() => localStorage.clear())
describe("team issues", () => {
  it("creates children atomically with unique numbers and consumes a draft", () => {
    const draft = {
      ...blankIssueDraft(),
      title: "Parent",
      subIssues: ["Child"],
    }
    const draftId = saveIssueDraft(team, draft)
    const parent = saveTeamIssue(team, draft, { draftId })
    const store = readIssueStore(team)
    expect(store.drafts).toEqual([])
    expect(store.issues.map((i) => i.number)).toEqual([1, 2])
    expect(store.issues[1].parentId).toBe(parent.id)
    expect(store.nextNumber).toBe(3)
  })
  it("moves issues between scopes without losing issue identity or contents", () => {
    const issue = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Task",
      description: "Details",
    })
    saveTeamIssue(team, { ...issue, status: "backlog" }, { id: issue.id })
    const issues = readIssueStore(team).issues
    expect(
      visibleIssues(
        issues,
        "active",
        statuses,
        emptyIssueFilters(),
        defaultIssueDisplay()
      )
    ).toHaveLength(0)
    expect(
      visibleIssues(
        issues,
        "backlog",
        statuses,
        emptyIssueFilters(),
        defaultIssueDisplay()
      )[0]
    ).toMatchObject({ id: issue.id, number: 1, description: "Details" })
  })
  it("preserves stored data when validation or quota fails", () => {
    saveTeamIssue(team, { ...blankIssueDraft(), title: "Keep me" })
    const original = localStorage.getItem(teamIssuesKey(team))
    expect(() => saveTeamIssue(team, blankIssueDraft())).toThrow()
    expect(localStorage.getItem(teamIssuesKey(team))).toBe(original)
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota")
      })
    expect(() =>
      saveTeamIssue(team, { ...blankIssueDraft(), title: "Failed" })
    ).toThrow()
    set.mockRestore()
    expect(localStorage.getItem(teamIssuesKey(team))).toBe(original)
  })
  it("does not overwrite corrupted stores", () => {
    localStorage.setItem(teamIssuesKey(team), "invalid")
    expect(() => writeIssueStore(team, () => initialIssueStore())).toThrow()
    expect(localStorage.getItem(teamIssuesKey(team))).toBe("invalid")
  })
  it("filters labels exactly and combines all/any conditions", () => {
    const issue = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Fix billing",
      labels: "Bug, Backend",
      priority: "High",
    })
    const rules = [
      {
        id: "a",
        field: "labels" as const,
        operator: "is" as const,
        value: "Bug",
      },
      {
        id: "b",
        field: "priority" as const,
        operator: "is" as const,
        value: "Low",
      },
    ]
    expect(matchesIssueFilters(issue, { match: "all", rules })).toBe(false)
    expect(matchesIssueFilters(issue, { match: "any", rules })).toBe(true)
    expect(
      matchesIssueFilters(issue, {
        match: "all",
        rules: [{ ...rules[0], value: "Back" }],
      })
    ).toBe(false)
  })
  it("sorts urgent work before unset priority and round-trips saved views", () => {
    saveTeamIssue(team, { ...blankIssueDraft(), title: "Unset" })
    saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Urgent",
      priority: "Urgent",
    })
    const store = writeIssueStore(team, (s) => ({
      ...s,
      views: [
        {
          id: "v",
          name: "My view",
          scope: "all",
          filters: emptyIssueFilters(),
          display: { ...defaultIssueDisplay(), layout: "board" },
        },
      ],
    }))
    expect(
      visibleIssues(
        store.issues,
        "all",
        statuses,
        emptyIssueFilters(),
        defaultIssueDisplay()
      )[0].title
    ).toBe("Urgent")
    expect(parseIssueStore(JSON.stringify(store)).views[0].display.layout).toBe(
      "board"
    )
  })
  it("spawns one recurring successor on completion and clamps month ends", () => {
    const issue = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Monthly",
      recurrence: "monthly",
      dueDate: "2026-01-31",
    })
    const done = saveTeamIssue(
      team,
      { ...issue, status: "done" },
      { id: issue.id }
    )
    saveTeamIssue(team, { ...done, description: "Updated" }, { id: done.id })
    const issues = readIssueStore(team).issues
    expect(issues).toHaveLength(2)
    expect(issues[1]).toMatchObject({
      status: "todo",
      dueDate: "2026-02-28",
      recurrence: "monthly",
      completedAt: null,
    })
  })
  it("keeps teams isolated", () => {
    saveTeamIssue(team, { ...blankIssueDraft(), title: "Private to this team" })
    expect(readIssueStore("another-team").issues).toEqual([])
  })
  it("preserves discussion and rich content through property edits and legacy migration", () => {
    const original = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Discussion",
      descriptionDoc: { type: "doc", content: [] },
      reactions: [{ emoji: "👍", users: ["member"] }],
      comments: [
        {
          id: "comment",
          parentId: "",
          attachmentId: "",
          resolved: false,
          author: "member",
          body: "Review",
          createdAt: new Date().toISOString(),
          edited: false,
          deleted: false,
          reactions: [],
        },
      ],
    })
    const edited = saveTeamIssue(
      team,
      { ...original, priority: "High" },
      { id: original.id }
    )
    expect(edited.comments).toEqual(original.comments)
    expect(edited.reactions).toEqual(original.reactions)
    expect(edited.descriptionDoc).toEqual(original.descriptionDoc)
    expect(edited.activity[0].text).toBe("updated priority")
    const legacy = JSON.parse(JSON.stringify(readIssueStore(team)))
    delete legacy.issues[0].comments
    delete legacy.issues[0].reactions
    expect(parseIssueStore(JSON.stringify(legacy)).issues[0].comments).toEqual(
      []
    )
  })
  it("persists attachment sizing and resolved image threads through subsequent edits", () => {
    const original = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Image review",
      attachments: [
        {
          id: "image",
          name: "image.png",
          data: "data:image/png;base64,YQ==",
          width: 45,
        },
      ],
      comments: [
        {
          id: "thread",
          parentId: "",
          attachmentId: "image",
          resolved: false,
          author: "member",
          body: "Review the image",
          createdAt: new Date().toISOString(),
          edited: false,
          deleted: false,
          reactions: [],
        },
      ],
    })
    saveTeamIssue(
      team,
      {
        ...original,
        priority: "High",
        comments: original.comments.map((comment) => ({
          ...comment,
          resolved: true,
        })),
      },
      { id: original.id }
    )
    const saved = readIssueStore(team).issues[0]
    expect(saved.attachments?.[0]).toMatchObject({ id: "image", width: 45 })
    expect(saved.comments[0]).toMatchObject({
      attachmentId: "image",
      resolved: true,
      body: "Review the image",
    })
    const legacy = JSON.parse(JSON.stringify(readIssueStore(team)))
    delete legacy.issues[0].comments[0].attachmentId
    delete legacy.issues[0].comments[0].resolved
    expect(
      parseIssueStore(JSON.stringify(legacy)).issues[0].comments[0]
    ).toMatchObject({ attachmentId: "", resolved: false })
  })
  it("moves parent and descendants together without losing discussion or colliding numbers", () => {
    const parent = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Move",
      subIssues: ["Child"],
    })
    saveTeamIssue("target", { ...blankIssueDraft(), title: "Existing" })
    moveTeamIssue(team, "target", parent.id)
    expect(readIssueStore(team).issues).toHaveLength(0)
    const target = readIssueStore("target")
    expect(target.issues.map((issue) => issue.number)).toEqual([1, 2, 3])
    expect(target.issues[2].parentId).toBe(parent.id)
  })
  it("rolls back a team move if the source write fails", () => {
    const issue = saveTeamIssue(team, {
      ...blankIssueDraft(),
      title: "Safe move",
    })
    const setItem = Storage.prototype.setItem
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === teamIssuesKey(team)) throw new Error("quota")
        setItem.call(this, key, value)
      })
    expect(() => moveTeamIssue(team, "target", issue.id)).toThrow()
    spy.mockRestore()
    expect(readIssueStore(team).issues[0].id).toBe(issue.id)
    expect(readIssueStore("target").issues).toHaveLength(0)
  })
})

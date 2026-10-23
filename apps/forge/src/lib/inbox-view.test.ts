import { describe, expect, it } from "vitest"
import {
  newInbox,
  parseInbox,
  receiveInboxUpdate,
  reduceInbox,
  visibleInboxEntries,
} from "./inbox-state"
import {
  arrangeInbox,
  emptyInboxFilters,
  inboxGroup,
  isPriorityEntry,
  matchesInboxFilters,
  defaultInboxPreferences as prefs,
} from "./inbox-view"
import { scope, update } from "@/components/inbox/inbox-test-fixtures"

function fixture() {
  let state = receiveInboxUpdate(
    newInbox(),
    scope,
    update({
      id: "assignment",
      actorId: "alex",
      createdAt: "2026-10-20T12:00:00Z",
    })
  )
  state = receiveInboxUpdate(
    state,
    scope,
    update({
      id: "mention",
      kind: "mention",
      actorId: "sam",
      createdAt: "2026-10-21T12:00:00Z",
    })
  )
  state = receiveInboxUpdate(
    state,
    scope,
    update({
      id: "comment",
      kind: "comment",
      issue: {
        ...update().issue,
        id: "second",
        status: "Done",
        project: null,
        priority: "Low",
      },
      createdAt: "2026-10-22T12:00:00Z",
    })
  )
  return state
}
describe("Inbox filtering and display", () => {
  it("matches all categories with OR within a category and requires actor/type to match one event", () => {
    const entries = fixture().entries
    const filters = {
      ...emptyInboxFilters(),
      type: ["mention", "comment"],
      from: ["sam"],
      project: ["Getting started"],
      status: ["started"],
      priority: ["high"],
    }
    expect(
      entries
        .filter((entry) => matchesInboxFilters(entry, filters))
        .map((entry) => entry.id)
    ).toEqual(["issue:issue-1"])
    expect(
      entries.filter((entry) =>
        matchesInboxFilters(entry, { ...filters, from: ["alex"] })
      )
    ).toEqual([])
    expect(
      entries
        .filter((entry) =>
          matchesInboxFilters(entry, {
            ...emptyInboxFilters(),
            type: ["system"],
          })
        )
        .map((entry) => entry.id)
    ).toEqual(["welcome"])
    expect(
      entries
        .filter((entry) =>
          matchesInboxFilters(entry, {
            ...emptyInboxFilters(),
            project: [""],
            status: ["completed"],
          })
        )
        .map((entry) => entry.id)
    ).toEqual(["issue:second"])
  })
  it("sorts both directions, puts unread first, and keeps unread groups contiguous", () => {
    const entries = fixture()
      .entries.filter((entry) => entry.issue)
      .map((entry) => ({ ...entry, unread: entry.id === "issue:issue-1" }))
    expect(arrangeInbox(entries, prefs).map((entry) => entry.id)).toEqual([
      "issue:second",
      "issue:issue-1",
    ])
    expect(
      arrangeInbox(entries, { ...prefs, ordering: "oldest" }).map(
        (entry) => entry.id
      )
    ).toEqual(["issue:issue-1", "issue:second"])
    expect(
      arrangeInbox(entries, { ...prefs, unreadFirst: true }).map(
        (entry) => entry.id
      )
    ).toEqual(["issue:issue-1", "issue:second"])
    expect(
      arrangeInbox(entries, { ...prefs, groupBy: "project" }).map((entry) =>
        inboxGroup(entry, "project")
      )
    ).toEqual(["Getting started", "Read"])
  })
  it("divides priority and other by direct updates and includes snoozed only on request", () => {
    const state = fixture()
    expect(
      state.entries
        .filter((entry) =>
          isPriorityEntry(entry, { ...prefs, priorityInclude: "direct" })
        )
        .map((entry) => entry.id)
    ).toEqual(["issue:issue-1"])
    const snoozed = reduceInbox(state, {
      type: "snooze",
      id: "issue:issue-1",
      until: 200,
    })
    const options = {
      view: "inbox" as const,
      filter: "all" as const,
      now: 100,
      unreadOnly: false,
    }
    expect(visibleInboxEntries(snoozed, options)).toHaveLength(2)
    expect(
      visibleInboxEntries(snoozed, { ...options, showSnoozed: true })
    ).toHaveLength(3)
  })
  it("migrates existing inboxes with default preferences without changing notifications", () => {
    const { preferences: _preferences, ...legacy } = fixture()
    const parsed = parseInbox(JSON.stringify(legacy))
    expect(parsed.preferences).toEqual(prefs)
    expect(parsed.entries).toEqual(legacy.entries)
  })
})

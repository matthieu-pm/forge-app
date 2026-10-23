import { describe, expect, it } from "vitest"
import {
  newInbox,
  receiveInboxUpdate,
  reduceInbox,
  visibleInboxEntries,
} from "./inbox-state"
import { scope, update } from "@/components/inbox/inbox-test-fixtures"

const options = {
  view: "inbox" as const,
  filter: "all" as const,
  unreadOnly: false,
  now: Date.parse("2026-10-23T12:00:00Z"),
}
describe("inbox update delivery", () => {
  it("groups the four update types by issue, deduplicates events and reopens read entries", () => {
    let state = receiveInboxUpdate(newInbox(), scope, update())
    state = reduceInbox(state, {
      type: "read",
      ids: ["issue:issue-1"],
      unread: false,
    })
    for (const kind of ["mention", "comment", "status"] as const)
      state = receiveInboxUpdate(state, scope, update({ id: kind, kind }))
    state = receiveInboxUpdate(
      state,
      scope,
      update({ id: "comment", kind: "comment" })
    )
    expect(state.entries).toHaveLength(2)
    expect(state.entries.find((entry) => entry.issue)?.events).toHaveLength(4)
    expect(state.entries.find((entry) => entry.issue)?.unread).toBe(true)
  })
  it("rejects other workspaces, unrelated recipients, own updates, and unsubscribed activity", () => {
    for (const event of [
      update({ workspaceId: "other" }),
      update({ recipientIds: [] }),
      update({ actorId: "me" }),
      update({ kind: "comment", subscriberIds: [] }),
      update({ kind: "status", subscriberIds: [] }),
    ])
      expect(receiveInboxUpdate(newInbox(), scope, event)).toEqual(newInbox())
    let state = receiveInboxUpdate(newInbox(), scope, update())
    state = reduceInbox(state, {
      type: "subscribe",
      id: "issue:issue-1",
      subscribed: false,
    })
    expect(
      receiveInboxUpdate(
        state,
        scope,
        update({ id: "comment", kind: "comment" })
      )
    ).toEqual(state)
    expect(
      receiveInboxUpdate(state, scope, update({ id: "status", kind: "status" }))
    ).toEqual(state)
    expect(
      receiveInboxUpdate(
        state,
        scope,
        update({ id: "mention", kind: "mention" })
      ).entries.at(-1)?.events
    ).toHaveLength(2)
    state = reduceInbox(state, {
      type: "subscribe",
      id: "issue:issue-1",
      subscribed: true,
    })
    expect(
      receiveInboxUpdate(
        state,
        scope,
        update({ id: "comment", kind: "comment" })
      ).entries.at(-1)?.events
    ).toHaveLength(2)
  })
  it("keeps the latest issue snapshot when events arrive out of order", () => {
    const newest = update({ id: "latest", createdAt: "2026-10-23T12:00:00Z" })
    let state = receiveInboxUpdate(newInbox(), scope, newest)
    state = receiveInboxUpdate(
      state,
      scope,
      update({ issue: { ...newest.issue, title: "Old title" } })
    )
    expect(state.entries.at(-1)?.issue?.title).toBe(newest.issue.title)
    expect(state.entries.at(-1)?.events.at(-1)?.id).toBe("latest")
  })
  it("returns snoozed notifications on time and supports restore without losing the issue", () => {
    let state = receiveInboxUpdate(newInbox(), scope, update())
    state = reduceInbox(state, {
      type: "snooze",
      id: "issue:issue-1",
      until: options.now + 1000,
    })
    expect(visibleInboxEntries(state, options)).toHaveLength(1)
    expect(
      visibleInboxEntries(state, { ...options, view: "snoozed" })
    ).toHaveLength(1)
    expect(
      visibleInboxEntries(state, { ...options, now: options.now + 1000 })
    ).toHaveLength(2)
    state = reduceInbox(state, {
      type: "delete",
      id: "issue:issue-1",
      deleted: true,
    })
    expect(
      visibleInboxEntries(state, { ...options, view: "deleted" })[0].issue
        ?.identifier
    ).toBe("FOR-42")
    state = reduceInbox(state, {
      type: "delete",
      id: "issue:issue-1",
      deleted: false,
    })
    expect(
      visibleInboxEntries(state, { ...options, now: options.now + 1000 })
    ).toHaveLength(2)
  })
  it("matches mentions anywhere in a group, even when the latest event is a comment", () => {
    let state = receiveInboxUpdate(
      newInbox(),
      scope,
      update({ id: "mention", kind: "mention" })
    )
    state = receiveInboxUpdate(
      state,
      scope,
      update({ kind: "comment", createdAt: "2026-10-23T11:00:00Z" })
    )
    expect(
      visibleInboxEntries(state, { ...options, filter: "mention" })
    ).toHaveLength(1)
  })
})

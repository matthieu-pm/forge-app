import { describe, expect, it } from "vitest"
import {
  projectMilestoneEvents,
  reconcileProjectEntries,
} from "./project-content"
import type { Actor } from "@/application/actor"

const member: Actor = {
  workspaceId: "w",
  userId: "bob",
  workspaceRole: "member",
  scopes: null,
  authentication: { kind: "session", sessionId: "s" },
}
const now = "2026-11-01T12:00:00.000Z"
const post = {
  id: "post",
  authorId: "alice",
  createdAt: "2026-10-01T12:00:00.000Z",
  text: "Original",
  attachments: [],
  reactions: [],
  comments: [],
}

describe("FOR-58 post and milestone authority", () => {
  it("ignores forged attribution and forbids another member's post edits/deletion", () => {
    expect(reconcileProjectEntries(member, [], [post], now)[0]).toMatchObject({
      authorId: "bob",
      createdAt: now,
    })
    expect(() =>
      reconcileProjectEntries(
        member,
        [post],
        [{ ...post, text: "Forged edit" }],
        now
      )
    ).toThrow()
    expect(() => reconcileProjectEntries(member, [post], [], now)).toThrow()
    expect(
      reconcileProjectEntries(
        { ...member, workspaceRole: "admin" },
        [post],
        [{ ...post, authorId: "bob", createdAt: now, text: "Moderated" }],
        now
      )[0]
    ).toMatchObject({
      authorId: "alice",
      createdAt: post.createdAt,
      text: "Moderated",
    })
  })
  it("allows own reactions and attributed replies without changing other reactions", () => {
    const existing = {
      ...post,
      reactions: [{ emoji: "👍", userIds: ["alice"] }],
    }
    expect(() =>
      reconcileProjectEntries(
        member,
        [existing],
        [{ ...existing, reactions: [{ emoji: "👍", userIds: ["bob"] }] }],
        now
      )
    ).toThrow()
    const result = reconcileProjectEntries(
      member,
      [existing],
      [
        {
          ...existing,
          reactions: [{ emoji: "👍", userIds: ["alice", "bob"] }],
          comments: [{ ...post, id: "reply" }],
        },
      ],
      now
    )
    expect(result[0].comments?.[0]).toMatchObject({
      authorId: "bob",
      createdAt: now,
    })
    expect(result[0].reactions[0].userIds).toEqual(["alice", "bob"])
  })
  it("rejects inline bytes and ambiguous milestone identities", () => {
    expect(() =>
      reconcileProjectEntries(
        member,
        [],
        [
          {
            ...post,
            attachments: [
              {
                id: "file",
                name: "x",
                mime: "text/plain",
                data: "data:text/plain,x",
              },
            ],
          },
        ],
        now
      )
    ).toThrow("private upload")
    expect(() =>
      projectMilestoneEvents(
        member,
        [],
        [
          { id: "a", name: "First", completed: false },
          { id: "b", name: "Second", completed: false, aliases: ["First"] },
        ],
        now
      )
    ).toThrow("unique")
  })
})

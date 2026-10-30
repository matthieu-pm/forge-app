import { describe, expect, it } from "vitest"
import {
  filterIssueCopy,
  issueCopyIds,
  retainHiddenIssueCopies,
} from "./issue-copies"

const a = "00000000-0000-4000-8000-000000000001",
  b = "00000000-0000-4000-8000-000000000002"
const key = "forge:team-issue-edit-drafts:v1:team:command"
const draft = JSON.stringify({
  commandKey: "command",
  teamId: "team",
  edits: [
    { issueId: a, changes: { description: "Private expired body" } },
    { issueId: b, changes: { title: "Live draft" } },
  ],
})
describe("FOR-45 durable issue copy policy", () => {
  it("normalizes UUID spellings and quarantines unavailable replay payloads on reads", () => {
    const lower = "abcdefab-0000-4000-8000-000000000001"
    const raw = JSON.stringify({
      commandKey: "original",
      edits: [
        { issueId: lower.toUpperCase(), changes: { description: "Secret" } },
        { issueId: b, changes: { title: "Live" } },
      ],
    })
    expect(issueCopyIds(key, raw)).toEqual([lower, b])
    expect(
      filterIssueCopy(key, raw, (id) => id !== lower, 0, "read")
    ).toBeNull()
    expect(
      JSON.parse(filterIssueCopy(key, raw, (id) => id !== lower)!)
    ).toMatchObject({
      requiresReview: true,
      commandKey: "original",
      edits: [{ issueId: b, changes: { title: "Live" } }],
    })
  })
  it("removes only the unavailable edit in a mixed batch", () => {
    const next = filterIssueCopy(key, draft, (id) => id === b)!
    expect(next).not.toContain("Private expired body")
    expect(JSON.parse(next).edits).toEqual([
      { issueId: b, changes: { title: "Live draft" } },
    ])
    expect(filterIssueCopy(key, draft, () => false)).toBeNull()
  })
  it("follows explicit nested recovery/conflict keys", () => {
    const inner = JSON.stringify({ key, value: draft, reason: "conflict" }),
      outer = JSON.stringify({
        key: "forge:legacy-conflict:v1:copy",
        value: inner,
        createdAt: "now",
      })
    const wrapper = "forge:pending-recovery:v1:copy"
    expect(issueCopyIds(wrapper, outer)).toEqual([a, b])
    expect(filterIssueCopy(wrapper, outer, (id) => id === b)).not.toContain(
      "Private expired body"
    )
    expect(filterIssueCopy(wrapper, outer, () => false)).toBeNull()
  })
  it("preserves unrelated rich text and legacy import sources", () => {
    const raw = JSON.stringify({
      id: a,
      description: "A separately owned local draft",
    })
    expect(filterIssueCopy("forge:team-issues:v1:team", raw, () => false)).toBe(
      raw
    )
  })
  it("retains hidden recoverable history when the visible projection is saved", () => {
    const projected = filterIssueCopy(key, draft, (id) => id === b)
    const retained = retainHiddenIssueCopies(
      key,
      projected,
      draft,
      new Set([a])
    )!
    expect(JSON.parse(retained).edits).toHaveLength(2)
    expect(filterIssueCopy(key, retained, () => true)).toContain(
      "Private expired body"
    )
  })
  it("drops a relationship draft if either endpoint is unavailable", () => {
    const raw = JSON.stringify({ input: { issueId: a, targetId: b } })
    expect(
      filterIssueCopy(
        "forge:team-relationship-draft:v1:team:source",
        raw,
        (id) => id !== a
      )
    ).toBeNull()
  })
  it("fails closed for malformed protocols and excessive wrapper nesting", () => {
    expect(() => filterIssueCopy(key, "bad copy", () => true)).toThrow()
    let value = draft,
      nestedKey = key
    for (let n = 0; n < 10; n++) {
      value = JSON.stringify({ key: nestedKey, value })
      nestedKey = "forge:pending-recovery:v1:copy"
    }
    expect(() => filterIssueCopy(nestedKey, value, () => true)).toThrow(
      "nesting"
    )
  })
})

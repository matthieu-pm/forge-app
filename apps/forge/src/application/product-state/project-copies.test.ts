import { describe, expect, it } from "vitest"
import { filterProjectCopy, projectCopyIds } from "./project-copies"

const a = "00000000-0000-4000-8000-000000000001"
const b = "00000000-0000-4000-8000-000000000002"
const key = "forge:project-command:v1:command"
const batch = JSON.stringify([
  { id: a, expectedRevision: 2, changes: { name: "Private project" } },
  { id: b, expectedRevision: 1, changes: { summary: "Other project" } },
])
describe("private project recovery projections", () => {
  it("hides the whole immutable batch when any existing project is unreadable", () => {
    expect(filterProjectCopy(key, batch, (id) => id === a)).toBeNull()
    expect(filterProjectCopy(key, batch, () => true)).toBe(batch)
    expect(projectCopyIds(key, batch)).toEqual([a, b])
  })
  it("follows nested recovery envelopes while retaining exact authorized bytes", () => {
    const outer = "forge:pending-recovery:v1:outer"
    const value = JSON.stringify({
      key: "forge:legacy-conflict:v1:inner",
      value: JSON.stringify({ key, value: batch }),
    })
    expect(filterProjectCopy(outer, value, () => false)).toBeNull()
    expect(filterProjectCopy(outer, value, () => true)).toBe(value)
    expect(projectCopyIds(outer, value)).toEqual([a, b])
  })
  it("keeps author-owned new-project drafts private and leaves unrelated protocols alone", () => {
    const value = JSON.stringify([
      { id: a, expectedRevision: null, changes: { name: "New draft" } },
    ])
    expect(filterProjectCopy(key, value, () => false)).toBe(value)
    expect(projectCopyIds(key, value)).toEqual([])
    expect(
      filterProjectCopy("forge:desktop-tabs", "unparsed bytes", () => false)
    ).toBe("unparsed bytes")
  })
})

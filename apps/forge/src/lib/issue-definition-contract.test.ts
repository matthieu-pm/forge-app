import { describe, expect, it } from "vitest"
import {
  canTransition,
  defaultDefinitionValue,
  definitionValueSchema,
} from "./issue-definition-contract"

describe("shared definition validation", () => {
  it("defaults to open transitions while distinguishing an explicit empty list", () => {
    expect(canTransition({}, "todo", "done")).toBe(true)
    expect(canTransition({ todo: [] }, "todo", "done")).toBe(false)
    expect(canTransition({ todo: [] }, "todo", "todo")).toBe(true)
  })
  it("rejects dangling transition and automation references", () => {
    const value = defaultDefinitionValue()
    value.transitions = { todo: ["missing"] }
    expect(() => definitionValueSchema.parse(value)).toThrow("current statuses")
    value.transitions = {}
    value.workflows.pullRequests.open = "missing"
    expect(() => definitionValueSchema.parse(value)).toThrow(
      "automation references"
    )
  })
  it("rejects duplicate names regardless of casing and unknown groups", () => {
    const value = defaultDefinitionValue()
    const label = {
      id: crypto.randomUUID(),
      name: "Mobile",
      description: "",
      color: "#5e6ad2",
      groupId: null,
      issues: 0,
      lastApplied: null,
      createdAt: new Date().toISOString(),
    }
    value.labels.labels = [
      label,
      { ...label, id: crypto.randomUUID(), name: "mobile" },
    ]
    expect(() => definitionValueSchema.parse(value)).toThrow("unique")
    value.labels.labels = [{ ...label, groupId: crypto.randomUUID() }]
    expect(() => definitionValueSchema.parse(value)).toThrow(
      "group from this scope"
    )
  })
  it("keeps required groups, one duplicate status, and a valid default", () => {
    const value = defaultDefinitionValue()
    value.statuses.defaultId = "duplicate"
    expect(() => definitionValueSchema.parse(value)).toThrow()
    value.statuses.defaultId = "backlog"
    value.statuses.statuses = value.statuses.statuses.filter(
      (s) => s.group !== "canceled"
    )
    expect(() => definitionValueSchema.parse(value)).toThrow()
  })
})

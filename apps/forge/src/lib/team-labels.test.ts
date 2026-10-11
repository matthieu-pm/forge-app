import { describe, expect, it } from "vitest"
import {
  initialTeamLabels,
  parseTeamLabels,
  restoreTeamLabelDeletion,
  teamLabelsStorageKey,
} from "./team-labels"

describe("local team labels", () => {
  it("isolates storage by team and keeps reference data out of other teams", () => {
    expect(teamLabelsStorageKey("one")).not.toBe(teamLabelsStorageKey("two"))
    expect(initialTeamLabels("other").labels).toEqual([])
    expect(initialTeamLabels("other").inheritedCount).toBe(0)
  })

  it("rejects malformed dates before they can reach the table formatter", () => {
    const directory = initialTeamLabels("forge")
    directory.labels[0].createdAt = "invalid"
    expect(() => parseTeamLabels(JSON.stringify(directory))).toThrow()
  })

  it("restores only the deleted label while preserving subsequent edits", () => {
    const previous = initialTeamLabels("forge")
    const current = {
      ...previous,
      labels: [
        { ...previous.labels[1], description: "Updated since deletion" },
      ],
    }
    const restored = restoreTeamLabelDeletion(
      current,
      previous,
      "desktop",
      "label"
    )
    expect(
      restored?.labels.find((label) => label.id === "preferences")?.description
    ).toBe("Updated since deletion")
    expect(restored?.labels.find((label) => label.id === "desktop")?.name).toBe(
      "Desktop"
    )
  })

  it("does not restore a duplicate name", () => {
    const previous = initialTeamLabels("forge")
    const current = {
      ...previous,
      labels: [{ ...previous.labels[0], id: "replacement", name: "DESKTOP" }],
    }
    expect(
      restoreTeamLabelDeletion(current, previous, "desktop", "label")
    ).toBeNull()
  })

  it("restores a deleted group without undoing a later label reassignment", () => {
    const previous = initialTeamLabels("forge")
    previous.groups = [
      { id: "platform", name: "Platform", color: "#5e6ad2", description: "" },
    ]
    previous.labels = previous.labels.map((label) => ({
      ...label,
      groupId: "platform",
    }))
    const current = {
      ...previous,
      groups: [{ id: "new", name: "New", color: "#5e6ad2", description: "" }],
      labels: previous.labels.map((label, index) => ({
        ...label,
        groupId: index === 0 ? "new" : null,
      })),
    }
    const restored = restoreTeamLabelDeletion(
      current,
      previous,
      "platform",
      "group"
    )
    expect(restored?.labels.map((label) => label.groupId)).toEqual([
      "new",
      "platform",
    ])
  })
})

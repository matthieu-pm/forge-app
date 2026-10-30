import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  deleteProjectStatus,
  initialProjectStatuses,
  moveProjectStatus,
  projectStatusGroups,
  projectStatusesStorageKey,
  readProjectStatuses,
  restoreProjectStatus,
  saveProjectStatus,
  writeProjectStatuses,
} from "./project-statuses"
import { productStorage } from "@/lib/product-storage"

const custom = {
  id: "review",
  group: "in-progress" as const,
  name: "In Review",
  color: "#4cb782",
  description: "Review before shipping",
}
beforeEach(() => productStorage.clear())
afterEach(() => vi.restoreAllMocks())
describe("project status settings", () => {
  it("initializes all five groups and keeps workspace settings isolated", () => {
    expect(
      initialProjectStatuses().statuses.map((status) => status.group)
    ).toEqual(projectStatusGroups.map((group) => group.id))
    writeProjectStatuses("a", 0, (current) =>
      saveProjectStatus(current, custom)
    )
    expect(readProjectStatuses("a").statuses).toHaveLength(6)
    expect(readProjectStatuses("b").statuses).toHaveLength(5)
  })
  it("validates unique names, meaningful content and colors", () => {
    const current = initialProjectStatuses()
    for (const patch of [{ name: " TO DO " }, { name: " " }, { color: "blue" }])
      expect(() =>
        saveProjectStatus(current, { ...custom, ...patch })
      ).toThrow()
    expect(
      saveProjectStatus(current, {
        ...custom,
        name: " In Review ",
      }).statuses.at(-1)?.name
    ).toBe("In Review")
  })
  it("moves only within a group and restores a deleted status in its original position", () => {
    let current = saveProjectStatus(initialProjectStatuses(), custom)
    current = moveProjectStatus(current, custom.id, -1)
    expect(
      current.statuses
        .filter((status) => status.group === custom.group)
        .map((status) => status.id)
    ).toEqual(["review", "in-progress"])
    const before = current.statuses
    current = deleteProjectStatus(current, "review")
    expect(current.deleted[0].id).toBe("review")
    current = restoreProjectStatus(current, "review")
    expect(current.statuses).toEqual(before)
    expect(current.deleted).toHaveLength(0)
    expect(() => deleteProjectStatus(current, "backlog")).toThrow(
      "at least one"
    )
  })
  it("rejects stale updates and preserves previous values on quota failure", () => {
    writeProjectStatuses("a", 0, (current) =>
      saveProjectStatus(current, custom)
    )
    expect(() =>
      writeProjectStatuses("a", 0, (current) =>
        deleteProjectStatus(current, "review")
      )
    ).toThrow("changed elsewhere")
    vi.spyOn(productStorage, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    expect(() =>
      writeProjectStatuses("a", 1, (current) =>
        deleteProjectStatus(current, "review")
      )
    ).toThrow("could not be saved")
    expect(readProjectStatuses("a").statuses.at(-1)?.name).toBe("In Review")
  })
  it("preserves corrupted saved data instead of replacing it with defaults", () => {
    productStorage.setItem(projectStatusesStorageKey("a"), "broken")
    expect(() => writeProjectStatuses("a", 0, (current) => current)).toThrow()
    expect(productStorage.getItem(projectStatusesStorageKey("a"))).toBe(
      "broken"
    )
  })
  it("keeps deleted data recoverable when restoration hits a duplicate name", () => {
    let current = saveProjectStatus(initialProjectStatuses(), custom)
    current = deleteProjectStatus(current, "review")
    current = saveProjectStatus(current, { ...custom, id: "other" })
    expect(() => restoreProjectStatus(current, "review")).toThrow(
      "already exists"
    )
    expect(current.deleted[0].id).toBe("review")
  })
})

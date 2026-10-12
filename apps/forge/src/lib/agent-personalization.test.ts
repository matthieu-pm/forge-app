import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  personalSkillSchema,
  personalizationStorageKey,
  readPersonalization,
  replacePersonalSkill,
  writePersonalization,
} from "./agent-personalization"

const skill = {
  id: "review",
  name: "Review",
  instructions: "Check accessibility",
  createdAt: "2026-10-12T12:00:00.000Z",
  revision: 0,
}
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())
describe("personal agent settings", () => {
  it("keeps accounts isolated and preserves guidance when skills change", () => {
    writePersonalization("a", () => ({
      guidance: "Be concise",
      skills: [skill],
    }))
    writePersonalization("b", () => ({ guidance: "Explain", skills: [] }))
    writePersonalization("a", (current) =>
      replacePersonalSkill(current, skill, {
        name: "Review UI",
        instructions: "Check keyboard access",
      })
    )
    expect(readPersonalization("a").guidance).toBe("Be concise")
    expect(readPersonalization("b")).toEqual({
      guidance: "Explain",
      skills: [],
    })
    expect(readPersonalization("a").skills[0]).toMatchObject({
      name: "Review UI",
      revision: 1,
    })
  })
  it("rejects stale edits and deletes without clobbering another skill", () => {
    writePersonalization("a", () => ({
      guidance: "",
      skills: [skill, { ...skill, id: "keep" }],
    }))
    writePersonalization("a", (current) =>
      replacePersonalSkill(current, skill, { ...skill, name: "Changed" })
    )
    expect(() =>
      writePersonalization("a", (current) =>
        replacePersonalSkill(current, skill, null)
      )
    ).toThrow("changed elsewhere")
    const saved = readPersonalization("a").skills[0]
    writePersonalization("a", (current) =>
      replacePersonalSkill(current, saved, null)
    )
    expect(readPersonalization("a").skills.map((item) => item.id)).toEqual([
      "keep",
    ])
  })
  it("preserves corrupted data and previous settings on a storage failure", () => {
    localStorage.setItem(personalizationStorageKey("a"), "broken")
    expect(() =>
      writePersonalization("a", () => ({ guidance: "", skills: [] }))
    ).toThrow()
    expect(localStorage.getItem(personalizationStorageKey("a"))).toBe("broken")
    localStorage.removeItem(personalizationStorageKey("a"))
    writePersonalization("a", () => ({ guidance: "Saved", skills: [] }))
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    expect(() =>
      writePersonalization("a", (current) => ({ ...current, guidance: "Lost" }))
    ).toThrow("quota")
    expect(readPersonalization("a").guidance).toBe("Saved")
  })
  it("requires meaningful skill content", () => {
    expect(
      personalSkillSchema.safeParse({ ...skill, name: "  " }).success
    ).toBe(false)
    expect(
      personalSkillSchema.safeParse({ ...skill, instructions: "  " }).success
    ).toBe(false)
    expect(personalSkillSchema.parse({ ...skill, name: " Review " }).name).toBe(
      "Review"
    )
  })
})

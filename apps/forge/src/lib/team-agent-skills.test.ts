import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  agentSkillSchema,
  agentSkillsStorageKey,
  readAgentSkills,
  replaceAgentSkill,
  writeAgentSkills,
} from "./team-agent-skills"
import { productStorage } from "@/lib/product-storage"

const skill = {
  id: "skill-a",
  teamId: "team-a",
  name: "Review",
  instructions: "Check accessibility.",
  createdAt: "2026-10-12T12:00:00.000Z",
  revision: 0,
}
beforeEach(() => productStorage.clear())
afterEach(() => vi.restoreAllMocks())
describe("agent skill persistence", () => {
  it("saves, edits and moves a skill without losing another team's records", () => {
    const other = { ...skill, id: "skill-b", teamId: "team-b" }
    writeAgentSkills(() => [skill, other])
    writeAgentSkills((current) =>
      replaceAgentSkill(current, skill, { name: "Review UI" })
    )
    const edited = readAgentSkills()[0]
    writeAgentSkills((current) =>
      replaceAgentSkill(current, edited, { teamId: "team-b" })
    )
    expect(readAgentSkills()).toEqual([
      { ...edited, teamId: "team-b", revision: 2 },
      other,
    ])
  })
  it("rejects stale updates, moves and deletions", () => {
    writeAgentSkills(() => [skill])
    writeAgentSkills((current) =>
      replaceAgentSkill(current, skill, { instructions: "New instructions" })
    )
    for (const patch of [null, { teamId: "other" }, { name: "Old name" }]) {
      expect(() =>
        writeAgentSkills((current) => replaceAgentSkill(current, skill, patch))
      ).toThrow("changed elsewhere")
    }
    expect(readAgentSkills()[0].instructions).toBe("New instructions")
  })
  it("preserves corrupt data and previous values when writes fail", () => {
    productStorage.setItem(agentSkillsStorageKey, "invalid")
    expect(() => writeAgentSkills(() => [skill])).toThrow()
    expect(productStorage.getItem(agentSkillsStorageKey)).toBe("invalid")
    productStorage.setItem(agentSkillsStorageKey, JSON.stringify([skill]))
    vi.spyOn(productStorage, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    expect(() =>
      writeAgentSkills((current) => replaceAgentSkill(current, skill, null))
    ).toThrow("quota")
    expect(readAgentSkills()).toEqual([skill])
  })
  it("validates required content and deletes only the selected skill", () => {
    expect(agentSkillSchema.safeParse({ ...skill, name: "  " }).success).toBe(
      false
    )
    expect(
      agentSkillSchema.safeParse({ ...skill, instructions: "  " }).success
    ).toBe(false)
    expect(agentSkillSchema.parse({ ...skill, name: " Review " }).name).toBe(
      "Review"
    )
    writeAgentSkills(() => [skill, { ...skill, id: "keep" }])
    writeAgentSkills((current) => replaceAgentSkill(current, skill, null))
    expect(readAgentSkills().map((item) => item.id)).toEqual(["keep"])
  })
})

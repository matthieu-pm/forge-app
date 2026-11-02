import { beforeEach, describe, expect, it } from "vitest"
import {
  recoveredTeamResources,
  retainTeamResources,
  retireTeamResources,
} from "./team-resources-journal"

const owner = { workspaceId: "workspace", userId: "alice" },
  teamId = "cdcb4271-1315-476b-a0da-bcbe6ec17ab5"
const request = () => ({
  key: crypto.randomUUID(),
  command: {
    teamId,
    expectedRevision: 0,
    fields: { sections: [], links: [], order: [] },
  },
})
beforeEach(() => localStorage.clear())
describe("durable resource retry identity", () => {
  it("survives a reload under the same owner and target", () => {
    const pending = request()
    retainTeamResources(owner, pending)
    expect(recoveredTeamResources(owner, teamId)).toEqual(pending)
    expect(
      recoveredTeamResources({ ...owner, userId: "bob" }, teamId)
    ).toBeNull()
    expect(
      recoveredTeamResources({ ...owner, workspaceId: "other" }, teamId)
    ).toBeNull()
    expect(recoveredTeamResources(owner, crypto.randomUUID())).toBeNull()
  })
  it("does not retire another tab's uncertain attempt", () => {
    const a = request(),
      b = request()
    retainTeamResources(owner, a)
    retainTeamResources(owner, b)
    retireTeamResources(owner, a)
    expect(recoveredTeamResources(owner, teamId)).toEqual(b)
  })
  it("rejects a recovery record altered to another target without deleting it", () => {
    const pending = request()
    retainTeamResources(owner, pending)
    const key = localStorage.key(0)!
    localStorage.setItem(
      key,
      JSON.stringify({
        ...pending,
        command: { ...pending.command, teamId: crypto.randomUUID() },
      })
    )
    expect(() => recoveredTeamResources(owner, teamId)).toThrow(
      "cannot be verified"
    )
    expect(localStorage.getItem(key)).not.toBeNull()
  })
})

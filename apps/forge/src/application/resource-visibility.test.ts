import { describe, expect, it } from "vitest"
import {
  canShareDocumentWithWorkspace,
  isDocumentVisible,
  isInitiativeVisible,
  isProjectVisible,
  isTeamVisible,
} from "./resource-visibility"
import type { Actor } from "./actor"
import type {
  DocumentVisibility,
  ProjectVisibility,
  TeamVisibility,
} from "./resource-visibility"

const actor: Actor = {
  userId: "alice",
  workspaceId: "w1",
  workspaceRole: "member",
  scopes: null,
  authentication: { kind: "session", sessionId: "s1" },
}
const publicTeam: TeamVisibility = {
  workspaceId: "w1",
  visibility: "workspace",
  memberUserIds: [],
}
const privateTeam: TeamVisibility = {
  workspaceId: "w1",
  visibility: "private",
  memberUserIds: ["bob"],
}
const sharedProject: ProjectVisibility = {
  workspaceId: "w1",
  teams: [publicTeam, privateTeam],
}
const privateProject: ProjectVisibility = {
  workspaceId: "w1",
  teams: [privateTeam],
}
const privateDocument: DocumentVisibility = {
  workspaceId: "w1",
  sharedWithWorkspace: false,
  source: { kind: "issue", team: privateTeam },
}

describe("confirmed workspace resource visibility matrix", () => {
  it("shows a shared project without granting its private-team content", () => {
    expect(isProjectVisible(actor, sharedProject)).toBe(true)
    expect(isTeamVisible(actor, privateTeam)).toBe(false)
    expect(isDocumentVisible(actor, privateDocument)).toBe(false)
  })
  it("hides private-only projects unless at least one participating team is readable", () => {
    expect(isProjectVisible(actor, privateProject)).toBe(false)
    expect(isProjectVisible({ ...actor, userId: "bob" }, privateProject)).toBe(
      true
    )
    expect(isProjectVisible(actor, { workspaceId: "w1", teams: [] })).toBe(true)
  })
  it.each(["owner", "admin", "member,admin"])(
    "grants %s private-team read visibility without requiring team membership",
    (workspaceRole) => {
      const admin = { ...actor, workspaceRole }
      expect(isTeamVisible(admin, privateTeam)).toBe(true)
      expect(isProjectVisible(admin, privateProject)).toBe(true)
      expect(isDocumentVisible(admin, privateDocument)).toBe(true)
      expect(canShareDocumentWithWorkspace(admin, privateDocument)).toBe(true)
    }
  )
  it("keeps initiative metadata visible even when all its private projects are hidden", () => {
    expect(isInitiativeVisible(actor, "w1")).toBe(true)
    expect(isProjectVisible(actor, privateProject)).toBe(false)
    expect(isInitiativeVisible(actor, "w2")).toBe(false)
  })
  it("requires an explicit document grant and never grants access to the private source issue", () => {
    expect(isDocumentVisible(actor, privateDocument)).toBe(false)
    expect(
      isDocumentVisible(actor, {
        ...privateDocument,
        sharedWithWorkspace: true,
      })
    ).toBe(true)
    expect(isTeamVisible(actor, privateTeam)).toBe(false)
    expect(
      canShareDocumentWithWorkspace(
        { ...actor, userId: "bob" },
        privateDocument
      )
    ).toBe(false)
  })
  it("inherits project document visibility until explicitly shared", () => {
    const document: DocumentVisibility = {
      workspaceId: "w1",
      sharedWithWorkspace: false,
      source: { kind: "project", project: privateProject },
    }
    expect(isDocumentVisible(actor, document)).toBe(false)
    expect(
      isDocumentVisible(actor, { ...document, sharedWithWorkspace: true })
    ).toBe(true)
  })
  it.each(["member", "owner", "admin"])(
    "never widens %s access across workspace boundaries",
    (workspaceRole) => {
      const foreign = { ...actor, workspaceId: "w2", workspaceRole }
      expect(isTeamVisible(foreign, publicTeam)).toBe(false)
      expect(isProjectVisible(foreign, sharedProject)).toBe(false)
      expect(
        isDocumentVisible(foreign, {
          ...privateDocument,
          sharedWithWorkspace: true,
        })
      ).toBe(false)
      expect(canShareDocumentWithWorkspace(foreign, privateDocument)).toBe(
        false
      )
    }
  )
  it("fails closed for malformed cross-workspace resource relationships", () => {
    const admin = { ...actor, workspaceRole: "owner" }
    expect(
      isProjectVisible(admin, {
        ...sharedProject,
        teams: [{ ...publicTeam, workspaceId: "w2" }],
      })
    ).toBe(false)
    expect(
      isDocumentVisible(admin, {
        ...privateDocument,
        sharedWithWorkspace: true,
        source: { kind: "issue", team: { ...privateTeam, workspaceId: "w2" } },
      })
    ).toBe(false)
  })
})

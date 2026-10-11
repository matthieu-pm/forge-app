import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  deleteTemplate,
  loadDirectory,
  saveTemplate,
  setDefault,
} from "./templates.server"
import type { Actor } from "@/application/actor"
import { emptyTemplate } from "@/lib/template-contract"

const mocks = vi.hoisted(() => ({
  getTeamDirectory: vi.fn(),
  people: vi.fn(),
  existing: vi.fn(),
  duplicates: vi.fn(),
  values: vi.fn(),
  returning: vi.fn(),
  updateWhere: vi.fn(),
  deleteWhere: vi.fn(),
  conflict: vi.fn(),
}))
vi.mock("@/application/teams/teams.server", () => ({
  getTeamDirectory: mocks.getTeamDirectory,
}))
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
  and: (...conditions: Array<unknown>) => conditions,
  desc: (column: unknown) => column,
}))
vi.mock("@/db", () => ({
  teamTemplates: {
    id: "id",
    workspaceId: "workspace",
    teamId: "team",
    updatedAt: "revision",
  },
  teamTemplateDefaults: { teamId: "team", audience: "audience" },
  users: {},
  members: { organizationId: "organization" },
  db: {
    query: {
      members: { findMany: mocks.people },
      teamTemplates: { findFirst: mocks.existing },
    },
    select: () => ({ from: () => ({ where: mocks.duplicates }) }),
    insert: () => ({
      values: (value: unknown) => {
        mocks.values(value)
        return {
          returning: mocks.returning,
          onConflictDoUpdate: mocks.conflict,
        }
      },
    }),
    update: () => ({
      set: () => ({
        where: (value: unknown) => {
          mocks.updateWhere(value)
          return { returning: mocks.returning }
        },
      }),
    }),
    delete: () => ({ where: mocks.deleteWhere }),
  },
}))
const teamId = "00000000-0000-4000-8000-000000000001"
const owner: Actor = {
  userId: "owner",
  workspaceId: "workspace-1",
  workspaceRole: "owner",
  authentication: { kind: "session", sessionId: "session-1" },
  scopes: null,
}
const payload = { ...emptyTemplate("issue", teamId), name: "Bug report" }
beforeEach(() => {
  mocks.getTeamDirectory.mockResolvedValue({
    items: [{ id: teamId, slug: "testing" }],
    nextCursor: null,
  })
  mocks.people.mockResolvedValue([{ userId: "owner" }])
  mocks.existing.mockResolvedValue(undefined)
  mocks.duplicates.mockResolvedValue([])
  mocks.returning.mockResolvedValue([{ id: "saved" }])
})
describe("Team template authorization and writes", () => {
  it("denies reads of teams omitted from the accessible directory", async () => {
    await expect(
      loadDirectory({ ...owner, workspaceRole: "member" }, "private")
    ).rejects.toThrow(/access/)
    expect(mocks.existing).not.toHaveBeenCalled()
    expect(mocks.people).not.toHaveBeenCalled()
  })
  it("derives workspace and creator from the session actor", async () => {
    await saveTemplate(owner, { slug: "testing", payload })
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId,
        workspaceId: "workspace-1",
        createdByUserId: "owner",
      })
    )
  })
  it.each([
    { ...owner, workspaceRole: "member" },
    { ...owner, scopes: ["teams:read" as const] },
  ])(
    "rejects writes without the management role and write scope",
    async (actor) => {
      await expect(
        saveTemplate(actor, { slug: "testing", payload })
      ).rejects.toThrow(/owners and admins/)
      expect(mocks.values).not.toHaveBeenCalled()
    }
  )
  it("rejects inaccessible teams and people outside the workspace", async () => {
    await expect(
      saveTemplate(owner, { slug: "private", payload })
    ).rejects.toThrow(/access/)
    await expect(
      saveTemplate(owner, {
        slug: "testing",
        payload: {
          ...payload,
          properties: { ...payload.properties, assignee: "outsider" },
        },
      })
    ).rejects.toThrow(/workspace/)
    expect(mocks.values).not.toHaveBeenCalled()
  })
  it("does not overwrite stale revisions, including a concurrent write during save", async () => {
    const updatedAt = new Date("2026-10-11T10:00:00Z")
    mocks.existing.mockResolvedValue({ id: "saved", updatedAt, payload })
    await expect(
      saveTemplate(owner, {
        slug: "testing",
        id: "saved",
        updatedAt: "old",
        payload,
      })
    ).rejects.toThrow(/another window/)
    mocks.returning.mockResolvedValue([])
    await expect(
      saveTemplate(owner, {
        slug: "testing",
        id: "saved",
        updatedAt: updatedAt.toISOString(),
        payload,
      })
    ).rejects.toThrow(/another window/)
    expect(mocks.updateWhere).toHaveBeenCalledWith(
      expect.arrayContaining([{ column: "revision", value: updatedAt }])
    )
  })
  it("limits edit and deletion queries to the workspace and team", async () => {
    await expect(
      saveTemplate(owner, { slug: "testing", id: "foreign", payload })
    ).rejects.toThrow(/not found/)
    expect(mocks.existing).toHaveBeenCalledWith({
      where: expect.arrayContaining([
        { column: "workspace", value: "workspace-1" },
        { column: "team", value: teamId },
      ]),
    })
    await deleteTemplate(owner, { slug: "testing", id: "saved" })
    expect(mocks.deleteWhere).toHaveBeenCalledWith(
      expect.arrayContaining([
        { column: "workspace", value: "workspace-1" },
        { column: "team", value: teamId },
      ])
    )
  })
  it("blocks custom forms as team-member defaults and non-issue defaults", async () => {
    mocks.existing.mockResolvedValue({
      payload: { ...payload, issueType: "form" },
    })
    await expect(
      setDefault(owner, {
        slug: "testing",
        audience: "members",
        templateId: "form",
      })
    ).rejects.toThrow(/eligible/)
    await setDefault(owner, {
      slug: "testing",
      audience: "nonMembers",
      templateId: "form",
    })
    expect(mocks.conflict).toHaveBeenCalled()
    mocks.existing.mockResolvedValue({
      payload: { ...payload, kind: "project" },
    })
    await expect(
      setDefault(owner, {
        slug: "testing",
        audience: "nonMembers",
        templateId: "project",
      })
    ).rejects.toThrow(/eligible/)
  })
})

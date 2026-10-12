import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  deleteRecurringIssue,
  loadRecurringIssues,
  saveRecurringIssue,
} from "./recurring-issues.server"
import type { Actor } from "@/application/actor"
import { emptyRecurringIssue } from "@/lib/recurring-issue-contract"

const mocks = vi.hoisted(() => ({
  directory: vi.fn(),
  people: vi.fn(),
  existing: vi.fn(),
  values: vi.fn(),
  returning: vi.fn(),
  updateWhere: vi.fn(),
  deleteWhere: vi.fn(),
  readWhere: vi.fn(),
  records: vi.fn(),
}))
vi.mock("@/application/teams/teams.server", () => ({
  getTeamDirectory: mocks.directory,
}))
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
  and: (...conditions: Array<unknown>) => conditions,
  desc: (column: unknown) => column,
}))
vi.mock("@/db", () => ({
  teamRecurringIssues: {
    id: "id",
    workspaceId: "workspace",
    teamId: "team",
    updatedAt: "revision",
  },
  members: { organizationId: "organization" },
  db: {
    query: {
      members: { findMany: mocks.people },
      teamRecurringIssues: { findFirst: mocks.existing },
    },
    select: () => ({
      from: () => ({
        where: (value: unknown) => {
          mocks.readWhere(value)
          return { orderBy: mocks.records }
        },
      }),
    }),
    insert: () => ({
      values: (value: unknown) => {
        mocks.values(value)
        return { returning: mocks.returning }
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
    delete: () => ({
      where: (value: unknown) => {
        mocks.deleteWhere(value)
        return { returning: mocks.returning }
      },
    }),
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
const payload = {
  ...emptyRecurringIssue(teamId, "UTC"),
  title: "Weekly review",
}
beforeEach(() => {
  mocks.directory.mockResolvedValue({
    items: [{ id: teamId, slug: "testing" }],
    nextCursor: null,
  })
  mocks.people.mockResolvedValue([{ userId: "owner" }])
  mocks.existing.mockResolvedValue(undefined)
  mocks.returning.mockResolvedValue([{ id: "saved" }])
  mocks.records.mockResolvedValue([])
})
describe("Recurring issue access and persistence", () => {
  it("denies private and inaccessible teams before querying schedules", async () => {
    await expect(loadRecurringIssues(owner, "private")).rejects.toThrow(
      /access/
    )
    expect(mocks.readWhere).not.toHaveBeenCalled()
  })
  it("scopes reads to the active workspace and team", async () => {
    await loadRecurringIssues(owner, "testing")
    expect(mocks.readWhere).toHaveBeenCalledWith([
      { column: "workspace", value: "workspace-1" },
      { column: "team", value: teamId },
    ])
  })
  it("derives the workspace and creator from the authenticated actor", async () => {
    await saveRecurringIssue(owner, { slug: "testing", payload })
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId,
        workspaceId: owner.workspaceId,
        createdByUserId: owner.userId,
      })
    )
  })
  it.each([
    { ...owner, workspaceRole: "member" },
    { ...owner, scopes: ["teams:read" as const] },
  ])("rejects writes without management access", async (actor) => {
    await expect(
      saveRecurringIssue(actor, { slug: "testing", payload })
    ).rejects.toThrow(/owners and admins/)
    await expect(
      deleteRecurringIssue(actor, {
        slug: "testing",
        id: "saved",
        updatedAt: new Date().toISOString(),
      })
    ).rejects.toThrow(/owners and admins/)
    expect(mocks.values).not.toHaveBeenCalled()
    expect(mocks.deleteWhere).not.toHaveBeenCalled()
  })
  it("rejects foreign assignees, nested team references, and a parent outside this team", async () => {
    for (const invalid of [
      {
        ...payload,
        properties: { ...payload.properties, assignee: "outsider" },
      },
      {
        ...payload,
        properties: { ...payload.properties, teamIds: ["foreign"] },
      },
      {
        ...payload,
        subIssues: [
          {
            id: "sub",
            title: "Sub",
            content: null,
            properties: { ...payload.properties, teamIds: ["foreign"] },
          },
        ],
      },
    ])
      await expect(
        saveRecurringIssue(owner, { slug: "testing", payload: invalid })
      ).rejects.toThrow(/workspace/)
    expect(mocks.values).not.toHaveBeenCalled()
  })
  it("rejects stale revisions and concurrent writes atomically", async () => {
    const updatedAt = new Date("2026-10-11T10:00:00Z")
    mocks.existing.mockResolvedValue({ id: "saved", updatedAt, payload })
    await expect(
      saveRecurringIssue(owner, {
        slug: "testing",
        id: "saved",
        updatedAt: "old",
        payload,
      })
    ).rejects.toThrow(/another window/)
    expect(mocks.updateWhere).not.toHaveBeenCalled()
    mocks.returning.mockResolvedValue([])
    await expect(
      saveRecurringIssue(owner, {
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
  it("scopes edits and deletes and protects a changed schedule from deletion", async () => {
    await expect(
      saveRecurringIssue(owner, { slug: "testing", id: "foreign", payload })
    ).rejects.toThrow(/not found/)
    expect(mocks.existing).toHaveBeenCalledWith({
      where: expect.arrayContaining([
        { column: "workspace", value: owner.workspaceId },
        { column: "team", value: teamId },
      ]),
    })
    mocks.returning.mockResolvedValue([])
    await expect(
      deleteRecurringIssue(owner, {
        slug: "testing",
        id: "saved",
        updatedAt: "2026-10-11T10:00:00Z",
      })
    ).rejects.toThrow(/another window/)
    expect(mocks.deleteWhere).toHaveBeenCalledWith(
      expect.arrayContaining([
        { column: "workspace", value: owner.workspaceId },
        { column: "team", value: teamId },
        { column: "revision", value: new Date("2026-10-11T10:00:00Z") },
      ])
    )
  })
})

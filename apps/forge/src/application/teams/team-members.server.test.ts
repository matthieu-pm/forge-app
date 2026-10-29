import { beforeEach, describe, expect, it, vi } from "vitest"
import { addTeamMembers, getTeamMemberDirectory } from "./team-members.server"
import type { Actor } from "@/application/actor"

const mocks = vi.hoisted(() => ({
  team: vi.fn(),
  member: vi.fn(),
  directory: vi.fn(),
  values: vi.fn(),
  conflict: vi.fn(),
}))
vi.mock("@/db", () => ({
  db: {
    query: {
      teams: { findFirst: mocks.team },
      members: { findFirst: mocks.member, findMany: mocks.directory },
    },
    insert: () => ({
      values: (value: unknown) => {
        mocks.values(value)
        return { onConflictDoNothing: mocks.conflict }
      },
    }),
  },
  teams: {
    workspaceId: "team.workspaceId",
    slug: "team.slug",
    deletedAt: "team.deletedAt",
  },
  members: {
    organizationId: "member.organizationId",
    userId: "member.userId",
    createdAt: "member.createdAt",
  },
  teamMembers: { teamId: "membership.teamId", userId: "membership.userId" },
}))
vi.mock("drizzle-orm", () => ({
  and: (...conditions: Array<unknown>) => conditions,
  eq: (field: unknown, value: unknown) => ({ field, value }),
  inArray: (field: unknown, values: unknown) => ({ field, values }),
  isNull: (field: unknown) => ({ field, isNull: true }),
  asc: (field: unknown) => field,
}))

const owner: Actor = {
  userId: "owner",
  workspaceId: "workspace",
  workspaceRole: "owner",
  authentication: { kind: "session", sessionId: "session" },
  scopes: null,
}
beforeEach(() => {
  mocks.team.mockResolvedValue({
    id: "team",
    visibility: "workspace",
    members: [{ userId: "owner", role: "member" }],
  })
  mocks.member.mockResolvedValue({ userId: "new-user" })
  mocks.directory.mockResolvedValue([
    {
      userId: "owner",
      role: "owner",
      user: {
        name: "Admin",
        email: "admin@example.com",
        username: "admin",
        image: null,
      },
    },
    {
      userId: "new-user",
      role: "member",
      user: {
        name: "New member",
        email: "new@example.com",
        username: null,
        image: null,
      },
    },
  ])
  mocks.conflict.mockResolvedValue(undefined)
})

describe("team membership boundaries", () => {
  it("splits team members from eligible workspace members and scopes both queries", async () => {
    const directory = await getTeamMemberDirectory(owner, "forge")
    expect(directory.members.map((member) => member.userId)).toEqual(["owner"])
    expect(directory.availableMembers.map((member) => member.userId)).toEqual([
      "new-user",
    ])
    expect(mocks.team.mock.calls[0][0].where).toContainEqual({
      field: "team.workspaceId",
      value: "workspace",
    })
    expect(mocks.directory.mock.calls[0][0].where).toEqual({
      field: "member.organizationId",
      value: "workspace",
    })
  })
  it("rejects additions without team management permission", async () => {
    expect(
      await addTeamMembers(
        { ...owner, workspaceRole: "member" },
        { slug: "forge", userIds: ["new-user"] }
      )
    ).toMatchObject({ ok: false })
    expect(mocks.values).not.toHaveBeenCalled()
  })
  it("rejects users outside the active workspace", async () => {
    mocks.directory.mockResolvedValue([])
    expect(
      await addTeamMembers(owner, { slug: "forge", userIds: ["foreign-user"] })
    ).toMatchObject({ ok: false })
    expect(mocks.directory.mock.calls[0][0].where).toContainEqual({
      field: "member.organizationId",
      value: "workspace",
    })
    expect(mocks.values).not.toHaveBeenCalled()
  })
  it("saves membership in this team and makes repeated additions idempotent", async () => {
    expect(
      await addTeamMembers(owner, { slug: "forge", userIds: ["new-user"] })
    ).toEqual({ ok: true })
    expect(mocks.values).toHaveBeenCalledWith([
      {
        workspaceId: "workspace",
        teamId: "team",
        userId: "new-user",
        role: "member",
      },
    ])
    expect(mocks.conflict).toHaveBeenCalledWith({
      target: ["membership.teamId", "membership.userId"],
    })
  })
  it("does not expose a private team's directory to nonmembers", async () => {
    mocks.team.mockResolvedValue(undefined)
    await expect(
      getTeamMemberDirectory({ ...owner, workspaceRole: "member" }, "private")
    ).rejects.toThrow("You do not have access to this team.")
    expect(mocks.directory).not.toHaveBeenCalled()
  })
  it("inserts a deduplicated selection in one batch", async () => {
    mocks.directory.mockResolvedValue([
      { userId: "first" },
      { userId: "second" },
    ])
    expect(
      await addTeamMembers(owner, {
        slug: "forge",
        userIds: ["first", "second", "first"],
      })
    ).toEqual({ ok: true })
    expect(mocks.values).toHaveBeenCalledTimes(1)
    expect(mocks.values).toHaveBeenCalledWith([
      {
        workspaceId: "workspace",
        teamId: "team",
        userId: "first",
        role: "member",
      },
      {
        workspaceId: "workspace",
        teamId: "team",
        userId: "second",
        role: "member",
      },
    ])
  })
  it("rejects the entire selection if any user is outside the workspace", async () => {
    mocks.directory.mockResolvedValue([{ userId: "new-user" }])
    expect(
      await addTeamMembers(owner, {
        slug: "forge",
        userIds: ["new-user", "foreign-user"],
      })
    ).toMatchObject({ ok: false })
    expect(mocks.values).not.toHaveBeenCalled()
  })
  it("hides the available-member directory from readers", async () => {
    const directory = await getTeamMemberDirectory(
      { ...owner, workspaceRole: "member" },
      "forge"
    )
    expect(directory.canManage).toBe(false)
    expect(directory.availableMembers).toEqual([])
  })
})

// Persistence policy is verified with real PostgreSQL in resource-authorization.postgres.test.ts.
vi.mock("@/application/resource-policy.server", () => ({
  requireCurrentActor: async (actor: Actor) => actor,
  currentMemberCondition: vi.fn(),
  readableTeamCondition: vi.fn(),
}))

vi.mock("./team-visibility.server", () => ({
  visibleTeamCondition: () => ({
    field: "team.workspaceId",
    value: "workspace",
  }),
}))

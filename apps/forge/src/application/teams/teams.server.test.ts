import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Actor } from "@/application/actor"
import type { CreateTeamInput } from "@/application/teams/team-schemas"
import {
  archiveTeam,
  createTeam,
  getTeam,
  getTeamDirectory,
  leaveTeam,
  listTeams,
  restoreTeam,
  updateTeam,
} from "@/application/teams/teams.server"

const mocks = vi.hoisted(() => ({
  deleteWhere: vi.fn(),
  directoryFindMany: vi.fn(),
  directoryFindFirst: vi.fn(),
  insertValues: vi.fn(),
  returning: vi.fn(),
  selectLimit: vi.fn(),
  updateSet: vi.fn(),
}))

vi.mock("@/db", () => ({
  db: {
    transaction: vi.fn((callback: (transaction: unknown) => unknown) =>
      callback({
        insert: () => ({
          values: (values: unknown) => {
            mocks.insertValues(values)
            return { returning: mocks.returning }
          },
        }),
      })
    ),
    insert: vi.fn(() => ({
      values: (values: unknown) => {
        mocks.insertValues(values)
        return { returning: mocks.returning }
      },
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: mocks.selectLimit,
          orderBy: () => ({ limit: mocks.selectLimit }),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (values: unknown) => {
        mocks.updateSet(values)
        return {
          where: () => ({ returning: mocks.returning }),
        }
      },
    })),
    delete: vi.fn(() => ({ where: mocks.deleteWhere })),
    query: {
      teams: {
        findMany: mocks.directoryFindMany,
        findFirst: mocks.directoryFindFirst,
      },
    },
  },
  teamMembers: {},
  teams: {},
}))

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: Array<unknown>) => conditions),
  asc: vi.fn((column: unknown) => column),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  gt: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  isNotNull: vi.fn((column: unknown) => ({ column, isNotNull: true })),
  isNull: vi.fn((column: unknown) => ({ column, isNull: true })),
  or: vi.fn((...conditions: Array<unknown>) => conditions),
}))

const owner: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  workspaceRole: "owner",
  authentication: { kind: "session", sessionId: "session-1" },
  scopes: null,
}

const input: CreateTeamInput = {
  name: "Engineering",
  identifier: "ENG",
  icon: {
    kind: "icon",
    value: "UserGroup03Icon",
    color: "#818cf8",
  },
  timezone: "Europe/Paris",
}

function persistedTeam(workspaceId = "workspace-1") {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId,
    slug: "engineering",
    identifier: "ENG",
    name: "Engineering",
    iconKind: "icon",
    iconValue: "UserGroup03Icon",
    color: "#818cf8",
    timezone: "Europe/Paris",
    description: "",
    visibility: "workspace",
    estimationScheme: "none",
    issueEmailEnabled: false,
    detailedHistoryEnabled: false,
    createdByUserId: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  }
}

describe("Teams application module", () => {
  beforeEach(() => {
    mocks.returning.mockResolvedValue([persistedTeam()])
    mocks.selectLimit.mockResolvedValue([persistedTeam()])
    mocks.directoryFindMany.mockResolvedValue([])
    mocks.directoryFindFirst.mockResolvedValue(undefined)
  })

  it.each(["owner", "admin", "owner,member"])(
    "allows the %s role to create a team",
    async (workspaceRole) => {
      await expect(
        createTeam({ ...owner, workspaceRole }, input)
      ).resolves.toMatchObject({ ok: true, team: { slug: "engineering" } })
    }
  )

  it("derives workspace and creator from the actor", async () => {
    await createTeam(owner, input)

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        createdByUserId: "user-1",
        slug: "engineering",
      })
    )
  })

  it.each([
    [{ ...owner, workspaceRole: "member" }, "role"],
    [
      {
        ...owner,
        authentication: { kind: "apiKey" as const, credentialId: "key-1" },
        scopes: ["teams:read" as const],
      },
      "scope",
    ],
  ])("rejects create when constrained by %s", async (actor) => {
    await expect(createTeam(actor as Actor, input)).resolves.toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    })
    expect(mocks.insertValues).not.toHaveBeenCalled()
  })

  it.each([
    ["teams_workspace_slug_unique", "SLUG_TAKEN", "name"],
    ["teams_workspace_identifier_unique", "IDENTIFIER_TAKEN", "identifier"],
  ] as const)("maps the %s constraint", async (constraint, code, field) => {
    mocks.returning.mockRejectedValue({
      message: "Failed query",
      cause: { constraint },
    })

    await expect(createTeam(owner, input)).resolves.toMatchObject({
      ok: false,
      code,
      field,
    })
  })

  it("isolates writes by actor workspace", async () => {
    await createTeam(owner, input)
    await createTeam({ ...owner, workspaceId: "workspace-2" }, input)

    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ workspaceId: "workspace-1" })
    )
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ workspaceId: "workspace-2" })
    )
  })

  it("requires read scope for API-key lookups", async () => {
    const actor: Actor = {
      ...owner,
      authentication: { kind: "apiKey", credentialId: "key-1" },
      scopes: ["teams:write"],
    }

    await expect(getTeam(actor, { id: persistedTeam().id })).rejects.toThrow(
      "cannot read teams"
    )
  })

  it("returns a cursor page through the module interface", async () => {
    mocks.selectLimit.mockResolvedValue([
      persistedTeam(),
      { ...persistedTeam(), id: "00000000-0000-4000-8000-000000000002" },
    ])

    const page = await listTeams(owner, { limit: 1 })

    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toEqual(expect.any(String))
  })

  it("rejects malformed cursors instead of restarting pagination", async () => {
    await expect(listTeams(owner, { cursor: "not-a-cursor" })).rejects.toThrow(
      "cursor is invalid"
    )
  })

  it("builds the active directory from persisted visibility and memberships", async () => {
    mocks.directoryFindMany.mockResolvedValue([
      {
        ...persistedTeam(),
        visibility: "private",
        members: [
          {
            id: "membership-1",
            workspaceId: "workspace-1",
            teamId: persistedTeam().id,
            userId: "user-1",
            role: "lead",
            createdAt: new Date(),
          },
        ],
      },
    ])

    await expect(getTeamDirectory(owner, "active")).resolves.toMatchObject({
      canCreateTeam: true,
      items: [
        {
          visibility: "private",
          memberCount: 1,
          issueCount: null,
          lifecycle: "active",
          capabilities: {
            canOpenSettings: true,
            canLeave: false,
            canDelete: true,
            canRestore: false,
          },
        },
      ],
    })
  })

  it("allows eligible members to leave and protects the last lead", async () => {
    const membership = {
      id: "membership-1",
      workspaceId: "workspace-1",
      teamId: persistedTeam().id,
      userId: "user-1",
      role: "member",
      createdAt: new Date(),
    }
    mocks.directoryFindFirst.mockResolvedValue({
      ...persistedTeam(),
      members: [membership],
    })

    await expect(
      leaveTeam({ ...owner, workspaceRole: "member" }, { slug: "engineering" })
    ).resolves.toMatchObject({ ok: true })
    expect(mocks.deleteWhere).toHaveBeenCalled()

    mocks.directoryFindFirst.mockResolvedValue({
      ...persistedTeam(),
      members: [{ ...membership, role: "lead" }],
    })
    await expect(
      leaveTeam(owner, { slug: "engineering" })
    ).resolves.toMatchObject({ ok: false, code: "LAST_LEAD" })
  })

  it("restores archived teams and reports active-name conflicts", async () => {
    mocks.returning.mockResolvedValue([
      { ...persistedTeam(), deletedAt: new Date() },
    ])
    await expect(
      restoreTeam(owner, { slug: "engineering" })
    ).resolves.toMatchObject({ ok: true })

    mocks.returning.mockRejectedValue({
      constraint: "teams_workspace_slug_unique",
    })
    await expect(
      restoreTeam(owner, { slug: "engineering" })
    ).resolves.toMatchObject({ ok: false, code: "RESTORE_CONFLICT" })
  })

  it("supports UI-confirmed and public ID archive operations", async () => {
    mocks.returning.mockResolvedValue([
      { name: "Engineering", slug: "engineering" },
    ])

    await expect(
      archiveTeam(owner, { slug: "engineering" }, "Engineering")
    ).resolves.toMatchObject({ ok: true })
    await expect(
      archiveTeam(owner, { id: persistedTeam().id })
    ).resolves.toMatchObject({ ok: true })
  })

  it("does not reveal whether an unarchived team exists", async () => {
    mocks.returning.mockResolvedValue([])

    await expect(
      archiveTeam(owner, { slug: "engineering" }, "Wrong")
    ).resolves.toMatchObject({
      ok: false,
      code: "TEAM_NOT_FOUND_OR_NAME_MISMATCH",
    })
  })

  it("updates settings and maps identifier conflicts", async () => {
    await expect(
      updateTeam(owner, { id: persistedTeam().id }, { description: "Core" })
    ).resolves.toMatchObject({ ok: true })

    await updateTeam(
      owner,
      { id: persistedTeam().id },
      {
        icon: {
          kind: "emoji",
          value: "🛠️",
          color: "#38bdf8",
        },
      }
    )
    expect(mocks.updateSet).toHaveBeenLastCalledWith(
      expect.objectContaining({
        iconKind: "emoji",
        iconValue: "🛠️",
        color: "#38bdf8",
      })
    )
    expect(mocks.updateSet.mock.lastCall?.[0]).not.toHaveProperty("icon")

    mocks.returning.mockRejectedValue({
      constraint: "teams_workspace_identifier_unique",
    })
    await expect(
      updateTeam(owner, { id: persistedTeam().id }, { identifier: "PLT" })
    ).resolves.toMatchObject({
      ok: false,
      code: "IDENTIFIER_TAKEN",
    })
  })
})

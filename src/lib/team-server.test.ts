import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  createTeamForRequest,
  deleteTeamForRequest,
  updateTeamForRequest,
} from "./team-server"
import type { CreateTeamInput, DeleteTeamInput } from "./team-contract"
import { WorkspaceAccessError } from "@/lib/auth-server"

const mocks = vi.hoisted(() => ({
  actor: {
    userId: "user-1",
    workspace: {
      id: "workspace-1",
      name: "Forge",
      slug: "forge",
      logo: null,
    },
    role: "owner",
  },
  deleteReturning: vi.fn(),
  insertValues: vi.fn(),
  requireActiveWorkspaceMember: vi.fn(),
  returning: vi.fn(),
  updateSet: vi.fn(),
}))

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: (values: unknown) => {
        mocks.insertValues(values)
        return { returning: mocks.returning }
      },
    })),
    update: vi.fn(() => ({
      set: (values: unknown) => {
        mocks.updateSet(values)
        return {
          where: () => ({ returning: mocks.deleteReturning }),
        }
      },
    })),
  },
  teams: {},
}))

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: Array<unknown>) => conditions),
  asc: vi.fn((column: unknown) => column),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  isNull: vi.fn((column: unknown) => ({ column, isNull: true })),
}))

vi.mock("@/lib/auth-server", () => {
  class MockWorkspaceAccessError extends Error {
    constructor(
      readonly code: "UNAUTHENTICATED" | "NO_ACTIVE_WORKSPACE" | "FORBIDDEN"
    ) {
      super(code)
    }
  }

  return {
    WorkspaceAccessError: MockWorkspaceAccessError,
    requireActiveWorkspaceMember: mocks.requireActiveWorkspaceMember,
  }
})

const request = new Request("https://forge.test/settings/teams/new")
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
    estimationScheme: "none",
    issueEmailEnabled: false,
    detailedHistoryEnabled: false,
    createdByUserId: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  }
}

describe("createTeamForRequest", () => {
  beforeEach(() => {
    mocks.requireActiveWorkspaceMember.mockResolvedValue(mocks.actor)
    mocks.returning.mockResolvedValue([persistedTeam()])
  })

  it.each(["owner", "admin", "owner,member"])(
    "allows the %s role to create a team",
    async (role) => {
      mocks.requireActiveWorkspaceMember.mockResolvedValue({
        ...mocks.actor,
        role,
      })

      const result = await createTeamForRequest(request, input)

      expect(result).toEqual({
        ok: true,
        team: {
          id: "00000000-0000-4000-8000-000000000001",
          slug: "engineering",
          identifier: "ENG",
          name: "Engineering",
          icon: {
            kind: "icon",
            value: "UserGroup03Icon",
            color: "#818cf8",
          },
          timezone: "Europe/Paris",
          description: "",
          estimationScheme: "none",
          issueEmailEnabled: false,
          detailedHistoryEnabled: false,
        },
      })
    }
  )

  it("derives workspace, creator, and slug instead of trusting the caller", async () => {
    await createTeamForRequest(request, input)

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        createdByUserId: "user-1",
        slug: "engineering",
      })
    )
  })

  it("rejects ordinary members", async () => {
    mocks.requireActiveWorkspaceMember.mockResolvedValue({
      ...mocks.actor,
      role: "member",
    })

    await expect(createTeamForRequest(request, input)).resolves.toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    })
    expect(mocks.returning).not.toHaveBeenCalled()
  })

  it.each([
    ["UNAUTHENTICATED", "UNAUTHENTICATED"],
    ["NO_ACTIVE_WORKSPACE", "NO_ACTIVE_WORKSPACE"],
    ["FORBIDDEN", "FORBIDDEN"],
  ] as const)(
    "maps %s workspace access errors",
    async (accessCode, resultCode) => {
      mocks.requireActiveWorkspaceMember.mockRejectedValue(
        new WorkspaceAccessError(accessCode)
      )

      await expect(createTeamForRequest(request, input)).resolves.toMatchObject(
        {
          ok: false,
          code: resultCode,
        }
      )
    }
  )

  it.each([
    ["teams_workspace_slug_unique", "SLUG_TAKEN", "name"],
    ["teams_workspace_identifier_unique", "IDENTIFIER_TAKEN", "identifier"],
  ] as const)("maps the %s constraint", async (constraint, code, field) => {
    mocks.returning.mockRejectedValue({ constraint })

    await expect(createTeamForRequest(request, input)).resolves.toMatchObject({
      ok: false,
      code,
      field,
    })
  })

  it.each([
    ["teams_workspace_slug_unique", "SLUG_TAKEN", "name"],
    ["teams_workspace_identifier_unique", "IDENTIFIER_TAKEN", "identifier"],
  ] as const)(
    "maps the wrapped Neon %s constraint",
    async (constraint, code, field) => {
      mocks.returning.mockRejectedValue({
        message: "Failed query: insert into teams",
        cause: {
          code: "23505",
          constraint,
          message: `duplicate key value violates unique constraint "${constraint}"`,
        },
      })

      await expect(createTeamForRequest(request, input)).resolves.toMatchObject(
        {
          ok: false,
          code,
          field,
        }
      )
    }
  )

  it("allows the same identifier to be submitted in another workspace", async () => {
    await createTeamForRequest(request, input)
    mocks.requireActiveWorkspaceMember.mockResolvedValue({
      ...mocks.actor,
      workspace: { ...mocks.actor.workspace, id: "workspace-2" },
    })
    mocks.returning.mockResolvedValue([persistedTeam("workspace-2")])
    await createTeamForRequest(request, input)

    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ workspaceId: "workspace-1", identifier: "ENG" })
    )
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workspaceId: "workspace-2", identifier: "ENG" })
    )
  })
})

describe("deleteTeamForRequest", () => {
  const deleteInput: DeleteTeamInput = {
    slug: "engineering",
    confirmationName: "Engineering",
  }

  beforeEach(() => {
    mocks.requireActiveWorkspaceMember.mockResolvedValue(mocks.actor)
    mocks.deleteReturning.mockResolvedValue([
      { name: "Engineering", slug: "engineering" },
    ])
  })

  it.each(["owner", "admin", "owner,member"])(
    "allows the %s role to delete a team",
    async (role) => {
      mocks.requireActiveWorkspaceMember.mockResolvedValue({
        ...mocks.actor,
        role,
      })

      const beforeDeletion = Date.now()
      const result = await deleteTeamForRequest(request, deleteInput)

      expect(result).toMatchObject({
        ok: true,
        team: { name: "Engineering", slug: "engineering" },
      })
      if (result.ok) {
        expect(Date.parse(result.recoverableUntil)).toBeGreaterThanOrEqual(
          beforeDeletion + 30 * 24 * 60 * 60 * 1000
        )
      }
      expect(mocks.updateSet).toHaveBeenCalledWith({
        deletedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      })
    }
  )

  it("rejects ordinary members", async () => {
    mocks.requireActiveWorkspaceMember.mockResolvedValue({
      ...mocks.actor,
      role: "member",
    })

    await expect(
      deleteTeamForRequest(request, deleteInput)
    ).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" })
    expect(mocks.updateSet).not.toHaveBeenCalled()
  })

  it("rejects a mismatched confirmation name without revealing the team", async () => {
    mocks.deleteReturning.mockResolvedValue([])

    await expect(
      deleteTeamForRequest(request, {
        ...deleteInput,
        confirmationName: "Wrong team",
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "TEAM_NOT_FOUND_OR_NAME_MISMATCH",
    })
  })

  it.each(["UNAUTHENTICATED", "NO_ACTIVE_WORKSPACE", "FORBIDDEN"] as const)(
    "maps the %s workspace access error",
    async (accessCode) => {
      mocks.requireActiveWorkspaceMember.mockRejectedValue(
        new WorkspaceAccessError(accessCode)
      )

      await expect(
        deleteTeamForRequest(request, deleteInput)
      ).resolves.toMatchObject({ ok: false, code: accessCode })
    }
  )
})

describe("updateTeamForRequest", () => {
  beforeEach(() => {
    mocks.requireActiveWorkspaceMember.mockResolvedValue(mocks.actor)
    mocks.deleteReturning.mockResolvedValue([
      {
        ...persistedTeam(),
        name: "Platform",
        description: "Core systems",
        estimationScheme: "fibonacci",
      },
    ])
  })

  it.each(["owner", "admin", "owner,member"])(
    "allows the %s role to update team settings",
    async (role) => {
      mocks.requireActiveWorkspaceMember.mockResolvedValue({
        ...mocks.actor,
        role,
      })

      const result = await updateTeamForRequest(request, {
        slug: "engineering",
        settings: {
          name: "Platform",
          description: "Core systems",
          estimationScheme: "fibonacci",
        },
      })

      expect(result).toMatchObject({
        ok: true,
        team: {
          name: "Platform",
          description: "Core systems",
          estimationScheme: "fibonacci",
        },
      })
      expect(mocks.updateSet).toHaveBeenCalledWith({
        name: "Platform",
        description: "Core systems",
        estimationScheme: "fibonacci",
        updatedAt: expect.any(Date),
      })
    }
  )

  it("rejects ordinary members", async () => {
    mocks.requireActiveWorkspaceMember.mockResolvedValue({
      ...mocks.actor,
      role: "member",
    })

    await expect(
      updateTeamForRequest(request, {
        slug: "engineering",
        settings: { description: "Core systems" },
      })
    ).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" })
    expect(mocks.updateSet).not.toHaveBeenCalled()
  })

  it("maps identifier uniqueness errors", async () => {
    mocks.deleteReturning.mockRejectedValue({
      constraint: "teams_workspace_identifier_unique",
    })

    await expect(
      updateTeamForRequest(request, {
        slug: "engineering",
        settings: { identifier: "PLT" },
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "IDENTIFIER_TAKEN",
      field: "identifier",
    })
  })
})

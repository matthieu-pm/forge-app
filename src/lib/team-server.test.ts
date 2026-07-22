import { beforeEach, describe, expect, it, vi } from "vitest"

import { createTeamForRequest } from "./team-server"
import type { CreateTeamInput } from "./team-contract"
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
  insertValues: vi.fn(),
  requireActiveWorkspaceMember: vi.fn(),
  returning: vi.fn(),
}))

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: (values: unknown) => {
        mocks.insertValues(values)
        return { returning: mocks.returning }
      },
    })),
  },
  teams: {},
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
    createdByUserId: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
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

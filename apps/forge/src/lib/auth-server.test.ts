import { beforeEach, describe, expect, it, vi } from "vitest"

import { PgDialect } from "drizzle-orm/pg-core"
import { buildAuthState, requireActiveWorkspaceMember } from "@/lib/auth-server"

const mocks = vi.hoisted(() => ({
  getFullOrganization: vi.fn(),
  getSession: vi.fn(),
  listOrganizations: vi.fn(),
  setActiveOrganization: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  innerJoin: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getFullOrganization: mocks.getFullOrganization,
      getSession: mocks.getSession,
      listOrganizations: mocks.listOrganizations,
      setActiveOrganization: mocks.setActiveOrganization,
    },
  },
}))

vi.mock("@/db", async () => ({
  ...(await import("@/db/auth-schema")),
  db: { select: mocks.select },
}))

const request = new Request("https://forge.test/login")
const firstWorkspaceSummary = {
  id: "workspace-1",
  name: "Original workspace",
  slug: "original",
  logo: null,
}
const firstWorkspace = {
  ...firstWorkspaceSummary,
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
}
const secondWorkspaceSummary = {
  id: "workspace-2",
  name: "Duplicate workspace",
  slug: "duplicate",
  logo: null,
}
const secondWorkspace = {
  ...secondWorkspaceSummary,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
}

describe("buildAuthState", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSession.mockResolvedValue({
      session: {
        id: "session-1",
        activeOrganizationId: null,
      },
      user: {
        id: "user-1",
        email: "person@forge.test",
        name: "Person",
        image: null,
      },
    })
    mocks.listOrganizations.mockResolvedValue([secondWorkspace, firstWorkspace])
    mocks.setActiveOrganization.mockResolvedValue(firstWorkspace)
    mocks.getFullOrganization.mockResolvedValue(firstWorkspace)
    const query = {
      from: mocks.from,
      innerJoin: mocks.innerJoin,
      where: mocks.where,
      limit: mocks.limit,
    }
    for (const method of [
      mocks.select,
      mocks.from,
      mocks.innerJoin,
      mocks.where,
    ]) {
      method.mockReturnValue(query)
    }
    mocks.limit.mockResolvedValue([{ ...firstWorkspaceSummary, role: "owner" }])
  })

  it("recovers an existing account with memberships but no active workspace", async () => {
    await expect(buildAuthState(request)).resolves.toMatchObject({
      session: {
        id: "session-1",
        activeOrganizationId: "workspace-1",
      },
      workspace: firstWorkspaceSummary,
    })
    expect(mocks.setActiveOrganization).toHaveBeenCalledWith({
      body: { organizationId: "workspace-1" },
      headers: request.headers,
    })
  })

  it("keeps using a valid active workspace without listing alternatives", async () => {
    mocks.getSession.mockResolvedValue({
      session: {
        id: "session-1",
        activeOrganizationId: "workspace-2",
      },
      user: {
        id: "user-1",
        email: "person@forge.test",
        name: "Person",
        image: null,
      },
    })
    mocks.getFullOrganization.mockResolvedValue(secondWorkspace)
    mocks.limit.mockResolvedValue([
      { ...secondWorkspaceSummary, role: "member" },
    ])

    await expect(buildAuthState(request)).resolves.toMatchObject({
      session: {
        activeOrganizationId: "workspace-2",
      },
      workspace: secondWorkspaceSummary,
    })
    expect(mocks.listOrganizations).not.toHaveBeenCalled()
    expect(mocks.setActiveOrganization).not.toHaveBeenCalled()
    expect(mocks.getFullOrganization).not.toHaveBeenCalled()
    expect(mocks.select).toHaveBeenCalledOnce()
    expect(mocks.innerJoin).toHaveBeenCalledOnce()
    expect(
      new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]).params
    ).toEqual(["workspace-2", "user-1"])
  })

  it("recovers when the session points at a workspace that is no longer valid", async () => {
    mocks.getSession.mockResolvedValue({
      session: {
        id: "session-1",
        activeOrganizationId: "deleted-workspace",
      },
      user: {
        id: "user-1",
        email: "person@forge.test",
        name: "Person",
        image: null,
      },
    })
    mocks.getFullOrganization.mockRejectedValue(
      new Error("Organization not found")
    )
    mocks.limit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...firstWorkspaceSummary, role: "owner" }])

    await expect(buildAuthState(request)).resolves.toMatchObject({
      session: {
        activeOrganizationId: "workspace-1",
      },
      workspace: firstWorkspaceSummary,
    })
  })

  it("authorizes an active workspace with the same single summary query", async () => {
    mocks.getSession.mockResolvedValue({
      session: { id: "session-1", activeOrganizationId: "workspace-1" },
      user: { id: "user-1" },
    })
    await expect(requireActiveWorkspaceMember(request)).resolves.toEqual({
      userId: "user-1",
      sessionId: "session-1",
      workspace: firstWorkspaceSummary,
      role: "owner",
    })
    expect(mocks.select).toHaveBeenCalledOnce()
    expect(mocks.getFullOrganization).not.toHaveBeenCalled()
  })

  it("does not authorize a workspace without a matching membership", async () => {
    mocks.getSession.mockResolvedValue({
      session: { id: "session-1", activeOrganizationId: "other-workspace" },
      user: { id: "user-1" },
    })
    mocks.limit.mockResolvedValue([])
    mocks.listOrganizations.mockResolvedValue([])
    await expect(requireActiveWorkspaceMember(request)).rejects.toMatchObject({
      code: "NO_ACTIVE_WORKSPACE",
    })
  })

  it("rechecks revoked membership on the next server request", async () => {
    mocks.getSession.mockResolvedValue({
      session: { id: "session-1", activeOrganizationId: "workspace-1" },
      user: { id: "user-1" },
    })
    await requireActiveWorkspaceMember(request)
    mocks.limit.mockResolvedValue([])
    mocks.listOrganizations.mockResolvedValue([])
    await expect(
      requireActiveWorkspaceMember(new Request(request.url))
    ).rejects.toMatchObject({
      code: "NO_ACTIVE_WORKSPACE",
    })
    expect(mocks.select).toHaveBeenCalledTimes(2)
  })

  it("rejects a membership without a role", async () => {
    mocks.limit.mockResolvedValue([{ ...firstWorkspaceSummary, role: "" }])
    await expect(requireActiveWorkspaceMember(request)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("rechecks fallback membership before returning a workspace", async () => {
    mocks.limit.mockResolvedValue([])
    await expect(buildAuthState(request)).resolves.toMatchObject({
      workspace: null,
    })
    expect(mocks.setActiveOrganization).not.toHaveBeenCalled()
  })

  it("rejects unauthenticated requests without a workspace query", async () => {
    mocks.getSession.mockResolvedValue(null)
    await expect(requireActiveWorkspaceMember(request)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    })
    expect(mocks.select).not.toHaveBeenCalled()
  })
})

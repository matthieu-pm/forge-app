import { beforeEach, describe, expect, it, vi } from "vitest"

import { buildAuthState } from "@/lib/auth-server"

const mocks = vi.hoisted(() => ({
  getFullOrganization: vi.fn(),
  getSession: vi.fn(),
  listOrganizations: vi.fn(),
  setActiveOrganization: vi.fn(),
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

vi.mock("@/db", () => ({
  db: {},
  members: {},
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

    await expect(buildAuthState(request)).resolves.toMatchObject({
      session: {
        activeOrganizationId: "workspace-2",
      },
      workspace: secondWorkspaceSummary,
    })
    expect(mocks.listOrganizations).not.toHaveBeenCalled()
    expect(mocks.setActiveOrganization).not.toHaveBeenCalled()
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

    await expect(buildAuthState(request)).resolves.toMatchObject({
      session: {
        activeOrganizationId: "workspace-1",
      },
      workspace: firstWorkspaceSummary,
    })
  })
})

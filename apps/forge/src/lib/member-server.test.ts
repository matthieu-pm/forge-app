import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  inviteWorkspaceMemberForRequest,
  retryInvitationDeliveryForRequest,
} from "@/lib/member-server"

const mocks = vi.hoisted(() => ({
  createInvitation: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  isInvitationWorkflowEnabled: vi.fn(),
  requireSessionActor: vi.fn(),
  retryInvitationWorkflow: vi.fn(),
  startInvitationWorkflow: vi.fn(),
  assertWorkspaceActionAllowed: vi.fn(),
}))

vi.mock("@/application/workspaces/members.server", () => ({
  getWorkspaceAccess: mocks.getWorkspaceAccess,
}))

vi.mock("@/adapters/auth/session-actor.server", () => ({
  requireSessionActor: mocks.requireSessionActor,
}))

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      createInvitation: mocks.createInvitation,
    },
  },
}))

vi.mock("@/application/workflows/workflow-feature-flags.server", () => ({
  isInvitationWorkflowEnabled: mocks.isInvitationWorkflowEnabled,
}))

vi.mock("@/application/workflows/invitation-workflow-start.server", () => ({
  retryInvitationWorkflow: mocks.retryInvitationWorkflow,
  startInvitationWorkflow: mocks.startInvitationWorkflow,
}))

vi.mock("@/application/workspace-security/workspace-security.server", () => ({
  assertWorkspaceActionAllowed: mocks.assertWorkspaceActionAllowed,
}))

const request = new Request("https://forge.test/settings/members")
const businessRunId = "d07e1242-b665-4c43-974f-a9459a1c12e4"

function actor(workspaceRole: string) {
  return {
    userId: "user-1",
    workspaceId: "workspace-1",
    workspaceRole,
    authentication: { kind: "session" as const, sessionId: "session-1" },
    scopes: null,
  }
}

describe("workspace invitation request adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireSessionActor.mockResolvedValue(actor("admin"))
    mocks.isInvitationWorkflowEnabled.mockReturnValue(true)
    mocks.createInvitation.mockResolvedValue({
      id: "invitation-1",
      email: "invitee@forge.test",
      role: "member",
    })
    mocks.startInvitationWorkflow.mockResolvedValue({
      state: "failed-to-start",
      businessRunId,
    })
    mocks.retryInvitationWorkflow.mockResolvedValue({
      state: "queued",
      businessRunId,
    })
  })

  it("returns invitation partial success without exposing an SDK run id", async () => {
    await expect(
      inviteWorkspaceMemberForRequest(request, {
        email: "invitee@forge.test",
        role: "member",
      })
    ).resolves.toEqual({
      ok: true,
      invitation: {
        id: "invitation-1",
        email: "invitee@forge.test",
        role: "member",
        url: "https://forge.test/accept-invitation?id=invitation-1",
      },
      delivery: {
        state: "failed-to-start",
        businessRunId,
      },
    })
  })

  it("allows workspace administrators to retry the same business run", async () => {
    await expect(
      retryInvitationDeliveryForRequest(request, { businessRunId })
    ).resolves.toEqual({
      ok: true,
      state: "queued",
      businessRunId,
    })
    expect(mocks.retryInvitationWorkflow).toHaveBeenCalledWith({
      businessRunId,
      workspaceId: "workspace-1",
    })
  })

  it("rejects retry attempts from regular workspace members", async () => {
    mocks.requireSessionActor.mockResolvedValue(actor("member"))

    await expect(
      retryInvitationDeliveryForRequest(request, { businessRunId })
    ).resolves.toEqual({
      ok: false,
      message:
        "Only a workspace owner or administrator can retry invitation delivery.",
    })
    expect(mocks.retryInvitationWorkflow).not.toHaveBeenCalled()
  })
})

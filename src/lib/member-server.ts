import "@tanstack/react-start/server-only"

import type {
  InviteWorkspaceMemberInput,
  InviteWorkspaceMemberResult,
  ManageWorkspaceAccessInput,
  ManageWorkspaceAccessResult,
  WorkspaceAccessSummary,
} from "@/lib/member-contract"
import { getWorkspaceAccess } from "@/application/workspaces/members.server"
import { requireSessionActor } from "@/adapters/auth/session-actor.server"
import { auth } from "@/lib/auth"

export async function getWorkspaceAccessForRequest(
  request: Request
): Promise<WorkspaceAccessSummary> {
  return getWorkspaceAccess(await requireSessionActor(request))
}

export async function inviteWorkspaceMemberForRequest(
  request: Request,
  input: InviteWorkspaceMemberInput
): Promise<InviteWorkspaceMemberResult> {
  const actor = await requireSessionActor(request)

  try {
    const invitation = await auth.api.createInvitation({
      headers: request.headers,
      body: {
        email: input.email,
        role: input.role,
        organizationId: actor.workspaceId,
      },
    })

    return {
      ok: true,
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        url: new URL(
          `/accept-invitation?id=${encodeURIComponent(invitation.id)}`,
          request.url
        ).toString(),
      },
    }
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "The invitation could not be sent.",
    }
  }
}

export async function manageWorkspaceAccessForRequest(
  request: Request,
  input: ManageWorkspaceAccessInput
): Promise<ManageWorkspaceAccessResult> {
  const actor = await requireSessionActor(request)

  try {
    switch (input.action) {
      case "update-role":
        await auth.api.updateMemberRole({
          headers: request.headers,
          body: {
            memberId: input.memberId,
            role: input.role,
            organizationId: actor.workspaceId,
          },
        })
        break
      case "remove-member":
        await auth.api.removeMember({
          headers: request.headers,
          body: {
            memberIdOrEmail: input.memberId,
            organizationId: actor.workspaceId,
          },
        })
        break
      case "cancel-invitation":
        await auth.api.cancelInvitation({
          headers: request.headers,
          body: { invitationId: input.invitationId },
        })
        break
      case "renew-invitation":
        await auth.api.createInvitation({
          headers: request.headers,
          body: {
            email: input.email,
            role: input.role,
            organizationId: actor.workspaceId,
            resend: true,
          },
        })
        break
    }

    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Workspace access could not be updated.",
    }
  }
}

import "@tanstack/react-start/server-only"

import type {
  InviteWorkspaceMemberInput,
  InviteWorkspaceMemberResult,
  WorkspaceMemberSummary,
} from "@/lib/member-contract"
import { listWorkspaceMembers } from "@/application/workspaces/members.server"
import { requireSessionActor } from "@/adapters/auth/session-actor.server"
import { auth } from "@/lib/auth"

export async function listWorkspaceMembersForRequest(
  request: Request
): Promise<Array<WorkspaceMemberSummary>> {
  return listWorkspaceMembers(await requireSessionActor(request))
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

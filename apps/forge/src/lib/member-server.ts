import "@tanstack/react-start/server-only"

import type {
  InviteWorkspaceMemberInput,
  InviteWorkspaceMemberResult,
  ManageWorkspaceAccessInput,
  ManageWorkspaceAccessResult,
  RetryInvitationDeliveryInput,
  RetryInvitationDeliveryResult,
  WorkspaceAccessSummary,
} from "@/lib/member-contract"
import { getWorkspaceAccess } from "@/application/workspaces/members.server"
import { requireSessionActor } from "@/adapters/auth/session-actor.server"
import { auth } from "@/lib/auth"
import { isInvitationWorkflowEnabled } from "@/application/workflows/workflow-feature-flags.server"
import {
  retryInvitationWorkflow,
  startInvitationWorkflow,
} from "@/application/workflows/invitation-workflow-start.server"
import { hasWorkspaceRole } from "@/application/authorization"
import { assertWorkspaceActionAllowed } from "@/application/workspace-security/workspace-security.server"

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
    await assertWorkspaceActionAllowed(actor, "members.invite")
    const invitation = await auth.api.createInvitation({
      headers: request.headers,
      body: {
        email: input.email,
        role: input.role,
        organizationId: actor.workspaceId,
      },
    })
    const workflowEnabled = isInvitationWorkflowEnabled(actor.workspaceId)
    const delivery = workflowEnabled
      ? await startInvitationWorkflow(invitation.id)
      : ({ state: "sent-synchronously" } as const)

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
      delivery,
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

export async function retryInvitationDeliveryForRequest(
  request: Request,
  input: RetryInvitationDeliveryInput
): Promise<RetryInvitationDeliveryResult> {
  const actor = await requireSessionActor(request)

  try {
    if (!hasWorkspaceRole(actor, ["owner", "admin"])) {
      throw new Error(
        "Only a workspace owner or administrator can retry invitation delivery."
      )
    }
    const result = await retryInvitationWorkflow({
      businessRunId: input.businessRunId,
      workspaceId: actor.workspaceId,
    })
    return { ok: true, ...result }
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Invitation delivery could not be retried.",
    }
  }
}

export async function manageWorkspaceAccessForRequest(
  request: Request,
  input: ManageWorkspaceAccessInput
): Promise<ManageWorkspaceAccessResult> {
  const actor = await requireSessionActor(request)

  try {
    let delivery:
      | Awaited<ReturnType<typeof startInvitationWorkflow>>
      | undefined

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
        {
          const invitation = await auth.api.createInvitation({
            headers: request.headers,
            body: {
              email: input.email,
              role: input.role,
              organizationId: actor.workspaceId,
              resend: true,
            },
          })
          if (isInvitationWorkflowEnabled(actor.workspaceId)) {
            delivery = await startInvitationWorkflow(invitation.id)
          }
        }
        break
    }

    return { ok: true, delivery }
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

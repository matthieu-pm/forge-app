import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import { ApplicationAccessError, hasWorkspaceRole } from "../authorization"
import { getWorkspaceSecuritySettings } from "../workspace-security/workspace-security.server"
import { isWorkspaceActionAllowed } from "../workspace-security/security-policy"
import { db, invitations, members } from "@/db"

/** A durable subject ID is never an authorization grant. Resolve the live inviter. */
export async function authorizeInvitationDelivery(
  workspaceId: string,
  invitationId: string
) {
  const invitation = await db.query.invitations.findFirst({
    where: and(
      eq(invitations.id, invitationId),
      eq(invitations.organizationId, workspaceId)
    ),
  })
  if (
    !invitation ||
    invitation.status !== "pending" ||
    invitation.expiresAt <= new Date()
  )
    throw new ApplicationAccessError()
  const membership = await db.query.members.findFirst({
    where: and(
      eq(members.organizationId, workspaceId),
      eq(members.userId, invitation.inviterId)
    ),
  })
  if (!membership) throw new ApplicationAccessError()
  // Internal workflow identity is resolved from the persisted subject, never supplied by a client.
  const actor = {
    userId: invitation.inviterId,
    workspaceId,
    workspaceRole: membership.role,
    authentication: {
      kind: "session" as const,
      sessionId: "internal-invitation-workflow",
    },
    scopes: null,
  }
  // Match the enabled Better Auth organization's owner/admin invitation authority.
  if (!hasWorkspaceRole(actor, ["owner", "admin"]))
    throw new ApplicationAccessError()
  if (
    !isWorkspaceActionAllowed(
      actor,
      await getWorkspaceSecuritySettings(workspaceId),
      "members.invite"
    )
  )
    throw new ApplicationAccessError()
}

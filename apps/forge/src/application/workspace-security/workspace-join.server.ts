import "@tanstack/react-start/server-only"

import { randomUUID } from "node:crypto"
import { domainToASCII } from "node:url"

import { and, eq, isNotNull } from "drizzle-orm"

import type {
  ApprovedDomainWorkspace,
  WorkspaceInvitePreview,
} from "@/application/workspace-security/workspace-join-contract"
import { verifyWorkspaceInviteLink } from "@/application/workspace-security/invite-link-token.server"
import {
  db,
  members,
  organizations,
  users,
  workspaceApprovedDomains,
  workspaceSecurityAuditEvents,
  workspaceSecuritySettings,
} from "@/db"

export class WorkspaceInviteError extends Error {
  constructor(
    readonly code: "EMAIL_NOT_VERIFIED" | "INVALID" | "NOT_FOUND" | "REVOKED",
    message: string
  ) {
    super(message)
    this.name = "WorkspaceInviteError"
  }
}

async function resolveInvite(token: string) {
  let claims: Awaited<ReturnType<typeof verifyWorkspaceInviteLink>>
  try {
    claims = await verifyWorkspaceInviteLink(token)
  } catch {
    throw new WorkspaceInviteError(
      "INVALID",
      "This workspace invite link is invalid."
    )
  }

  const rows = await db
    .select({
      workspaceId: organizations.id,
      workspaceName: organizations.name,
      workspaceSlug: organizations.slug,
      enabled: workspaceSecuritySettings.inviteLinksEnabled,
      generation: workspaceSecuritySettings.inviteLinkVersion,
    })
    .from(organizations)
    .innerJoin(
      workspaceSecuritySettings,
      eq(workspaceSecuritySettings.workspaceId, organizations.id)
    )
    .where(eq(organizations.id, claims.workspaceId))
    .limit(1)
  const invite = rows.at(0)
  if (!invite) {
    throw new WorkspaceInviteError(
      "NOT_FOUND",
      "This workspace invite link is no longer available."
    )
  }
  if (!invite.enabled || invite.generation !== claims.generation) {
    throw new WorkspaceInviteError(
      "REVOKED",
      "This workspace invite link was disabled or reset."
    )
  }
  return invite
}

export async function previewWorkspaceInvite(
  token: string
): Promise<WorkspaceInvitePreview> {
  const invite = await resolveInvite(token)
  return {
    workspaceName: invite.workspaceName,
    workspaceSlug: invite.workspaceSlug,
  }
}

export async function joinWorkspaceWithInvite(input: {
  token: string
  userId: string
  requestId?: string
}) {
  const invite = await resolveInvite(input.token)
  const userRows = await db
    .select({
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)
  const user = userRows.at(0)
  if (!user) {
    throw new WorkspaceInviteError("NOT_FOUND", "The account was not found.")
  }
  if (!user.emailVerified) {
    throw new WorkspaceInviteError(
      "EMAIL_NOT_VERIFIED",
      "Verify your email address before joining this workspace."
    )
  }

  await db.transaction(async (transaction) => {
    const currentRows = await transaction
      .select({
        enabled: workspaceSecuritySettings.inviteLinksEnabled,
        generation: workspaceSecuritySettings.inviteLinkVersion,
      })
      .from(workspaceSecuritySettings)
      .where(
        and(
          eq(workspaceSecuritySettings.workspaceId, invite.workspaceId),
          eq(workspaceSecuritySettings.inviteLinksEnabled, true),
          eq(workspaceSecuritySettings.inviteLinkVersion, invite.generation)
        )
      )
      .limit(1)
    if (!currentRows.at(0)) {
      throw new WorkspaceInviteError(
        "REVOKED",
        "This workspace invite link was disabled or reset."
      )
    }

    await transaction
      .insert(members)
      .values({
        id: randomUUID(),
        organizationId: invite.workspaceId,
        userId: input.userId,
        role: "member",
      })
      .onConflictDoNothing()
    await transaction.insert(workspaceSecurityAuditEvents).values({
      workspaceId: invite.workspaceId,
      actorUserId: input.userId,
      action: "security.invite-link.used",
      target: null,
      outcome: "succeeded",
      before: null,
      after: { membershipRole: "member" },
      requestId: input.requestId,
    })
  })

  return {
    workspaceId: invite.workspaceId,
    workspaceName: invite.workspaceName,
    workspaceSlug: invite.workspaceSlug,
  }
}

function emailDomain(email: string) {
  const separator = email.lastIndexOf("@")
  if (separator <= 0 || separator === email.length - 1) return null
  return (
    domainToASCII(
      email
        .slice(separator + 1)
        .trim()
        .toLowerCase()
    ) || null
  )
}

export async function findApprovedDomainWorkspace(input: {
  email: string
  emailVerified: boolean
}): Promise<ApprovedDomainWorkspace | null> {
  if (!input.emailVerified) return null
  const domain = emailDomain(input.email)
  if (!domain) return null

  const rows = await db
    .select({
      workspaceId: organizations.id,
      workspaceName: organizations.name,
      workspaceSlug: organizations.slug,
      domain: workspaceApprovedDomains.domain,
    })
    .from(workspaceApprovedDomains)
    .innerJoin(
      organizations,
      eq(organizations.id, workspaceApprovedDomains.workspaceId)
    )
    .where(
      and(
        eq(workspaceApprovedDomains.domain, domain),
        isNotNull(workspaceApprovedDomains.verifiedAt)
      )
    )
    .limit(1)
  return rows.at(0) ?? null
}

export async function joinWorkspaceWithApprovedDomain(input: {
  email: string
  emailVerified: boolean
  userId: string
  workspaceId: string
  requestId?: string
}) {
  const eligible = await findApprovedDomainWorkspace(input)
  if (!eligible || eligible.workspaceId !== input.workspaceId) {
    throw new WorkspaceInviteError(
      "INVALID",
      "Your verified email domain is not approved for this workspace."
    )
  }

  await db.transaction(async (transaction) => {
    await transaction
      .insert(members)
      .values({
        id: randomUUID(),
        organizationId: eligible.workspaceId,
        userId: input.userId,
        role: "member",
      })
      .onConflictDoNothing()
    await transaction.insert(workspaceSecurityAuditEvents).values({
      workspaceId: eligible.workspaceId,
      actorUserId: input.userId,
      action: "security.approved-domain.used",
      target: eligible.domain,
      outcome: "succeeded",
      before: null,
      after: { membershipRole: "member" },
      requestId: input.requestId,
    })
  })

  return eligible
}

import "@tanstack/react-start/server-only"

import { and, desc, eq, isNull, max } from "drizzle-orm"

import type { Actor } from "@/application/actor"
import type { WorkspaceAccessSummary } from "@/lib/member-contract"
import { hasWorkspaceRole, requireTeamRead } from "@/application/authorization"
import { db, invitations, members, sessions, teams, users } from "@/db"

const ONLINE_WINDOW_MS = 5 * 60 * 1000

export async function getWorkspaceAccess(
  actor: Actor
): Promise<WorkspaceAccessSummary> {
  requireTeamRead(actor)

  const [memberRows, invitationRows, workspaceTeams] = await Promise.all([
    db
      .select({
        id: members.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
        username: users.username,
        title: users.title,
        role: members.role,
        joinedAt: members.createdAt,
        lastSeenAt: max(sessions.updatedAt),
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .leftJoin(
        sessions,
        and(
          eq(sessions.userId, users.id),
          eq(sessions.activeOrganizationId, actor.workspaceId)
        )
      )
      .where(eq(members.organizationId, actor.workspaceId))
      .groupBy(
        members.id,
        users.id,
        users.name,
        users.email,
        users.image,
        users.username,
        users.title,
        members.role,
        members.createdAt
      ),
    db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        createdAt: invitations.createdAt,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, actor.workspaceId),
          eq(invitations.status, "pending")
        )
      )
      .orderBy(desc(invitations.createdAt)),
    db
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(eq(teams.workspaceId, actor.workspaceId), isNull(teams.deletedAt))
      ),
  ])

  const now = Date.now()

  return {
    members: memberRows.map((member) => ({
      ...member,
      joinedAt: member.joinedAt.toISOString(),
      lastSeenAt: member.lastSeenAt?.toISOString() ?? null,
      teamCount: workspaceTeams.length,
      isOnline:
        member.lastSeenAt !== null &&
        now - member.lastSeenAt.getTime() <= ONLINE_WINDOW_MS,
    })),
    invitations: invitationRows.map((invitation) => ({
      ...invitation,
      role: invitation.role ?? "member",
      createdAt: invitation.createdAt.toISOString(),
      expiresAt: invitation.expiresAt.toISOString(),
      expired: invitation.expiresAt.getTime() <= now,
    })),
    currentUserId: actor.userId,
    canManage: hasWorkspaceRole(actor, ["owner", "admin"]),
  }
}

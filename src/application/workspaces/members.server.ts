import "@tanstack/react-start/server-only"

import { and, eq, isNull, max } from "drizzle-orm"

import type { Actor } from "@/application/actor"
import type { WorkspaceMemberSummary } from "@/lib/member-contract"
import { requireTeamRead } from "@/application/authorization"
import { db, members, sessions, teams, users } from "@/db"

export async function listWorkspaceMembers(
  actor: Actor
): Promise<Array<WorkspaceMemberSummary>> {
  requireTeamRead(actor)

  const [memberRows, workspaceTeams] = await Promise.all([
    db
      .select({
        id: members.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
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
        members.role,
        members.createdAt
      ),
    db
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(eq(teams.workspaceId, actor.workspaceId), isNull(teams.deletedAt))
      ),
  ])

  return memberRows.map((member) => ({
    ...member,
    joinedAt: member.joinedAt.toISOString(),
    lastSeenAt: member.lastSeenAt?.toISOString() ?? null,
    teamCount: workspaceTeams.length,
    isOnline: member.userId === actor.userId,
  }))
}

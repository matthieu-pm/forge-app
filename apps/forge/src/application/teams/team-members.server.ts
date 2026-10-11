import "@tanstack/react-start/server-only"

import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { TeamMemberDirectory } from "@/lib/team-member-contract"
import {
  ApplicationAccessError,
  canManageTeams,
  requireTeamRead,
} from "@/application/authorization"
import { db, members, teamMembers, teams } from "@/db"

async function requireVisibleTeam(actor: Actor, slug: string) {
  requireTeamRead(actor)
  const team = await db.query.teams.findFirst({
    where: and(
      eq(teams.workspaceId, actor.workspaceId),
      eq(teams.slug, slug),
      isNull(teams.deletedAt)
    ),
    with: { members: true },
  })
  if (!team) throw new Error("The team no longer exists.")
  if (
    team.visibility === "private" &&
    !canManageTeams(actor) &&
    !team.members.some((member) => member.userId === actor.userId)
  ) {
    throw new ApplicationAccessError("You do not have access to this team.")
  }
  return team
}

export async function getTeamMemberDirectory(
  actor: Actor,
  slug: string
): Promise<TeamMemberDirectory> {
  const team = await requireVisibleTeam(actor, slug)
  const canManage = canManageTeams(actor)
  const workspaceMembers = await db.query.members.findMany({
    where: eq(members.organizationId, actor.workspaceId),
    with: { user: true },
    orderBy: [asc(members.createdAt)],
  })
  const teamRoles = new Map(
    team.members.map((member) => [member.userId, member.role])
  )
  const directory = workspaceMembers.map((member) => ({
    userId: member.userId,
    name: member.user.name,
    email: member.user.email,
    image: member.user.image,
    username: member.user.username,
    workspaceRole: member.role,
    teamRole: teamRoles.get(member.userId) ?? null,
  }))
  return {
    canManage,
    members: directory.filter((member) => member.teamRole !== null),
    availableMembers: canManage
      ? directory.filter((member) => member.teamRole === null)
      : [],
  }
}

export async function addTeamMembers(
  actor: Actor,
  input: { slug: string; userIds: Array<string> }
) {
  if (!canManageTeams(actor))
    return {
      ok: false as const,
      message: "Only workspace owners and admins can add team members.",
    }
  const team = await requireVisibleTeam(actor, input.slug)
  const userIds = [...new Set(input.userIds)]
  if (!userIds.length)
    return { ok: false as const, message: "Select at least one member." }
  const eligibleMembers = await db.query.members.findMany({
    where: and(
      eq(members.organizationId, actor.workspaceId),
      inArray(members.userId, userIds)
    ),
  })
  const eligibleUserIds = new Set(
    eligibleMembers.map((member) => member.userId)
  )
  if (userIds.some((userId) => !eligibleUserIds.has(userId)))
    return {
      ok: false as const,
      message: "Choose existing members of this workspace.",
    }
  await db
    .insert(teamMembers)
    .values(
      userIds.map((userId) => ({
        workspaceId: actor.workspaceId,
        teamId: team.id,
        userId,
        role: "member",
      }))
    )
    .onConflictDoNothing({ target: [teamMembers.teamId, teamMembers.userId] })
  return { ok: true as const }
}

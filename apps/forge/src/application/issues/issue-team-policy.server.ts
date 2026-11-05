import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import { teams, teamMembers } from "@/db"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import {
  readableTeamCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"

export async function requireIssueTeam(
  tx: Transaction,
  actor: Actor,
  teamId: string
) {
  requireResourceScope(actor, "issues:read")
  requireResourceScope(actor, "issues:write")
  const team = (
    await tx
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), readableTeamCondition(actor, teams.id)))
      .for("share")
  )[0]
  if (!team) throw new ApplicationAccessError()
  if (
    team.visibility === "private" &&
    !hasWorkspaceRole(actor, ["owner", "admin"])
  ) {
    const membership = (
      await tx
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.workspaceId, actor.workspaceId),
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.userId, actor.userId)
          )
        )
        .for("share")
    )[0]
    if (!membership) throw new ApplicationAccessError()
  }
  return team
}

import "@tanstack/react-start/server-only"
import { and, eq, isNull } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { TeamSummary } from "./team-schemas"
import { teamMembers, teams, workspaceSecuritySettings } from "@/db"
import {
  ApplicationAccessError,
  canReadAllPrivateTeams,
  hasScope,
} from "@/application/authorization"
import { canWorkspaceAction } from "@/application/workspace-security/workspace-security.server"

export async function authorizeTeamCreation(
  tx: Transaction,
  actor: Actor,
  value?: TeamSummary
) {
  if (!hasScope(actor, "teams:write") || !hasScope(actor, "teams:read"))
    throw new ApplicationAccessError()
  if (!value) {
    if (!(await canWorkspaceAction(actor, "teams.create", tx)))
      throw new ApplicationAccessError()
    // Serialize a policy revocation with the accepted command's authorization.
    await tx
      .select()
      .from(workspaceSecuritySettings)
      .where(eq(workspaceSecuritySettings.workspaceId, actor.workspaceId))
      .for("share")
    if (!(await canWorkspaceAction(actor, "teams.create", tx)))
      throw new ApplicationAccessError()
    return
  }
  const team = (
    await tx
      .select()
      .from(teams)
      .where(
        and(
          eq(teams.workspaceId, actor.workspaceId),
          eq(teams.id, value.id),
          isNull(teams.deletedAt)
        )
      )
      .for("share")
  ).at(0)
  if (!team) throw new ApplicationAccessError()
  if (team.visibility === "workspace" || canReadAllPrivateTeams(actor)) return
  const membership = (
    await tx
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.workspaceId, actor.workspaceId),
          eq(teamMembers.teamId, team.id),
          eq(teamMembers.userId, actor.userId)
        )
      )
      .for("share")
  ).at(0)
  if (!membership) throw new ApplicationAccessError()
}

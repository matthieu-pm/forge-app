import "@tanstack/react-start/server-only"
import { and, eq, isNull } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { TeamSummary } from "./team-schemas"
import { teamMembers, teams, workspaceSecuritySettings } from "@/db"
import { ApplicationAccessError, hasScope } from "@/application/authorization"
import { readableTeamCondition } from "@/application/resource-policy.server"
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
  // Hold any existing private-team membership before evaluating visibility.
  await tx
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.workspaceId, actor.workspaceId),
        eq(teamMembers.teamId, value.id),
        eq(teamMembers.userId, actor.userId)
      )
    )
    .for("share")
  const team = (
    await tx
      .select()
      .from(teams)
      .where(
        and(
          readableTeamCondition(actor, teams.id),
          eq(teams.id, value.id),
          isNull(teams.deletedAt)
        )
      )
      .for("share")
  ).at(0)
  if (!team) throw new ApplicationAccessError()
}

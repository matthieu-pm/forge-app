import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import { ApplicationAccessError } from "../authorization"
import { requireIssueTeam } from "../issues/issues.server"
import { requireFeatureWrite } from "../features/features.server"
import type { Actor } from "../actor"
import type { Transaction } from "@/db"
import { members, teamRecurringIssues } from "@/db"

export async function currentRecurringActor(
  tx: Transaction,
  actor: Actor,
  scheduleId: string
): Promise<Actor> {
  requireFeatureWrite(actor, "recurringIssues")
  const schedule = (
    await tx
      .select()
      .from(teamRecurringIssues)
      .where(
        and(
          eq(teamRecurringIssues.id, scheduleId),
          eq(teamRecurringIssues.workspaceId, actor.workspaceId),
          eq(teamRecurringIssues.createdByUserId, actor.userId),
          eq(teamRecurringIssues.state, "active")
        )
      )
      .for("share")
  )[0]
  if (!schedule) throw new ApplicationAccessError()
  const member = (
    await tx
      .select()
      .from(members)
      .where(
        and(
          eq(members.organizationId, actor.workspaceId),
          eq(members.userId, actor.userId)
        )
      )
      .for("share")
  )[0]
  if (!member) throw new ApplicationAccessError()
  const current: Actor = {
    ...actor,
    workspaceRole: member.role,
    scopes: ["issues:read", "issues:write", "projects:read", "teams:read"],
  }
  await requireIssueTeam(tx, current, schedule.teamId)
  return current
}

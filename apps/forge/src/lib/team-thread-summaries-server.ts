import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import { requireSessionActor } from "@/adapters/auth/session-actor.server"
import { getTeam } from "@/application/teams/teams.server"
import { hasWorkspaceRole } from "@/application/authorization"
import { db, teamMembers, workspaceEntitlements } from "@/db"

export async function getTeamThreadSummariesAccess(
  request: Request,
  slug: string
) {
  const actor = await requireSessionActor(request)
  const team = await getTeam(actor, { slug })
  if (!team) throw new Error("Team not found.")
  const [entitlement, membership] = await Promise.all([
    db.query.workspaceEntitlements.findFirst({
      where: eq(workspaceEntitlements.workspaceId, actor.workspaceId),
    }),
    db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.workspaceId, actor.workspaceId),
        eq(teamMembers.teamId, team.id),
        eq(teamMembers.userId, actor.userId)
      ),
    }),
  ])
  return {
    available:
      !!entitlement &&
      ["active", "trialing"].includes(entitlement.status) &&
      ["business", "enterprise"].includes(entitlement.plan),
    canManage: hasWorkspaceRole(actor, ["owner", "admin"]) || !!membership,
  }
}

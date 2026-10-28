import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import { requireSessionActor } from "@/adapters/auth/session-actor.server"
import { getTeam } from "@/application/teams/teams.server"
import { hasWorkspaceRole } from "@/application/authorization"
import { db, teamMembers } from "@/db"
import { readSubscriptionAccessState } from "@/application/billing/subscription-access-state.server"
import { subscriptionAccess } from "@/application/billing/subscription-access"

export async function getTeamThreadSummariesAccess(
  request: Request,
  slug: string
) {
  const actor = await requireSessionActor(request)
  const team = await getTeam(actor, { slug })
  if (!team) throw new Error("Team not found.")
  const [entitlement, membership] = await Promise.all([
    readSubscriptionAccessState(actor.workspaceId),
    db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.workspaceId, actor.workspaceId),
        eq(teamMembers.teamId, team.id),
        eq(teamMembers.userId, actor.userId)
      ),
    }),
  ])
  return {
    available: ["business", "enterprise"].includes(
      subscriptionAccess(entitlement).plan
    ),
    canManage: hasWorkspaceRole(actor, ["owner", "admin"]) || !!membership,
  }
}

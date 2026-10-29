import "@tanstack/react-start/server-only"
import { count, eq } from "drizzle-orm"
import { requireSessionActor } from "@/adapters/auth/session-actor.server"
import { readSubscriptionAccessState } from "@/application/billing/subscription-access-state.server"
import { subscriptionAccess } from "@/application/billing/subscription-access"
import { db, members } from "@/db"

export async function getWorkspaceBillingForRequest(request: Request) {
  const actor = await requireSessionActor(request)
  const [state, counts] = await Promise.all([
    readSubscriptionAccessState(actor.workspaceId),
    db
      .select({ members: count() })
      .from(members)
      .where(eq(members.organizationId, actor.workspaceId)),
  ])
  const access = subscriptionAccess(state)
  return {
    plan: access.plan,
    phase: access.phase,
    activeMembers: counts.at(0)?.members ?? 0,
    trialExpiresAt:
      access.phase === "trial"
        ? (state?.currentPeriodEnd?.toISOString() ?? null)
        : null,
  }
}

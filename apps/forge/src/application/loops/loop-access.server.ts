import "@tanstack/react-start/server-only"
import { and, eq, isNull } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import { organizations, teamMembers, teams } from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import { readableTeamCondition } from "@/application/resource-policy.server"
import { teamContentFeatureEnabled } from "@/application/team-content-feature-policy"

export function loopsEnabled() {
  return teamContentFeatureEnabled("FORGE_LOOPS_ENABLED")
}
export async function loopTeamAccess(
  tx: Transaction,
  actor: Actor,
  teamId: string
) {
  if (
    !loopsEnabled() ||
    actor.authentication.kind !== "session" ||
    actor.scopes !== null
  )
    throw new ApplicationAccessError(
      "Team Loops require an enabled first-party session."
    )
  await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, actor.workspaceId))
    .for("no key update")
  await tx
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.workspaceId, actor.workspaceId),
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
          eq(teams.id, teamId),
          eq(teams.workspaceId, actor.workspaceId),
          isNull(teams.deletedAt),
          readableTeamCondition(actor, teams.id)
        )
      )
      .for("share")
  )[0]
  if (!team) throw new ApplicationAccessError()
  return team
}

export class LoopPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LoopPolicyError"
  }
}

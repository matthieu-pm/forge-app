import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import { requireTeamRead } from "@/application/authorization"
import {
  currentMemberCondition,
  readableTeamCondition,
} from "@/application/resource-policy.server"
import { teams } from "@/db"

/** Filter in SQL using current membership/role, before LIMIT or aggregation. */
export function visibleTeamCondition(actor: Actor) {
  requireTeamRead(actor)
  return and(
    eq(teams.workspaceId, actor.workspaceId),
    currentMemberCondition(actor),
    readableTeamCondition(actor, teams.id, true)
  )
}

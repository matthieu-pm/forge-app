import "@tanstack/react-start/server-only"

import { and, eq, exists, or, sql } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import {
  canReadAllPrivateTeams,
  requireTeamRead,
} from "@/application/authorization"
import { db, teamMembers, teams } from "@/db"

/** Apply before LIMIT, cursors and aggregation, never after a page is selected. */
export function visibleTeamCondition(actor: Actor) {
  requireTeamRead(actor)
  return and(
    eq(teams.workspaceId, actor.workspaceId),
    canReadAllPrivateTeams(actor)
      ? undefined
      : or(
          eq(teams.visibility, "workspace"),
          exists(
            db
              .select({ present: sql`1` })
              .from(teamMembers)
              .where(
                and(
                  eq(teamMembers.workspaceId, actor.workspaceId),
                  eq(teamMembers.teamId, teams.id),
                  eq(teamMembers.userId, actor.userId)
                )
              )
          )
        )
  )
}

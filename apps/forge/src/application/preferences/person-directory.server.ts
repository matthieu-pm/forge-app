import "@tanstack/react-start/server-only"
import { eq } from "drizzle-orm"
import { assertPreferenceSession } from "./preferences.server"
import type { Actor } from "@/application/actor"
import { db, members, users } from "@/db"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import {
  ApplicationAccessError,
  requireTeamRead,
} from "@/application/authorization"

export async function readPersonDirectory(
  actor: Actor,
  scope: { workspaceId: string; sessionId: string }
) {
  assertPreferenceSession(actor, scope.sessionId)
  if (actor.workspaceId !== scope.workspaceId)
    throw new ApplicationAccessError()
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    assertPreferenceSession(current, scope.sessionId)
    if (current.workspaceId !== scope.workspaceId)
      throw new ApplicationAccessError()
    requireTeamRead(current)
    const enabled =
      process.env.FORGE_PERSON_NAME_FORMATTING_ENABLED === "true" &&
      process.env.FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED === "true"
    const people = enabled
      ? await tx
          .select({ id: users.id, name: users.name, username: users.username })
          .from(members)
          .innerJoin(users, eq(users.id, members.userId))
          .where(eq(members.organizationId, current.workspaceId))
      : []
    return { enabled, people }
  })
}

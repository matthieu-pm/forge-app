import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type {
  TeamResourcesResult,
  TeamResourcesSnapshot,
} from "@/lib/team-resources-contract"
import { db, organizations, teamMembers, teamResourceBoards, teams } from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import { readableTeamCondition } from "@/application/resource-policy.server"
import {
  emptyTeamResources,
  teamResourceCommandSchema,
  teamResourceFieldsSchema,
} from "@/lib/team-resources-contract"

export function teamResourcesEnabled() {
  return (
    (process.env.FORGE_TEAM_RESOURCES_ENABLED ??
      (process.env.FORGE_SERVICE_ENVIRONMENT === "production"
        ? "false"
        : "true")) === "true"
  )
}
async function authorize(tx: Transaction, actor: Actor, teamId: string) {
  if (!teamResourcesEnabled())
    throw new ApplicationAccessError(
      "Shared team resources are not enabled in this environment."
    )
  if (actor.authentication.kind !== "session" || actor.scopes !== null)
    throw new ApplicationAccessError(
      "Team resources require a first-party session."
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
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, teamId), readableTeamCondition(actor, teams.id)))
      .for("share")
  )[0]
  if (!team) throw new ApplicationAccessError()
}
async function snapshot(
  tx: Transaction,
  teamId: string
): Promise<TeamResourcesSnapshot> {
  const row = (
    await tx
      .select()
      .from(teamResourceBoards)
      .where(eq(teamResourceBoards.teamId, teamId))
  )[0]
  return row
    ? { ...teamResourceFieldsSchema.parse(row.fields), revision: row.revision }
    : emptyTeamResources()
}
export async function readTeamResources(actor: Actor, teamId: string) {
  z.uuid().parse(teamId)
  return db.transaction(async (tx) => {
    actor = await currentCommandActor(tx, actor)
    await authorize(tx, actor, teamId)
    return snapshot(tx, teamId)
  })
}
class ResourceConflict extends Error {}
export async function commandTeamResources(
  actor: Actor,
  commandKey: string,
  raw: unknown
): Promise<TeamResourcesResult> {
  z.uuid().parse(commandKey)
  const input = teamResourceCommandSchema.parse(raw)
  try {
    const result = await executeCommand({
      actor,
      commandKey,
      operation: "team-resources.write@1",
      input,
      status: 200,
      parse: (value) =>
        z
          .object({ revision: z.number().int().positive() })
          .strict()
          .parse(value),
      authorize: (tx, current) => authorize(tx, current, input.teamId),
      run: async (tx, current) => {
        const old = await snapshot(tx, input.teamId)
        if (old.revision !== input.expectedRevision)
          throw new ResourceConflict()
        const revision = old.revision + 1
        await tx
          .insert(teamResourceBoards)
          .values({
            teamId: input.teamId,
            workspaceId: current.workspaceId,
            fields: input.fields,
            revision,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: teamResourceBoards.teamId,
            set: { fields: input.fields, revision, updatedAt: new Date() },
          })
        return {
          value: { revision },
          resource: { type: "team-resources", id: input.teamId },
          events: [
            {
              topic: "team.resources.updated",
              payload: { teamId: input.teamId, revision },
            },
          ],
        }
      },
    })
    return { status: "saved", revision: result.value.revision }
  } catch (error) {
    if (!(error instanceof ResourceConflict)) throw error
    return {
      status: "conflict",
      current: await readTeamResources(actor, input.teamId),
    }
  }
}

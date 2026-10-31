import "@tanstack/react-start/server-only"
import { and, eq, inArray, notInArray } from "drizzle-orm"
import { z } from "zod"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { ProjectChanges } from "@/lib/shared-project-contract"
import {
  issues,
  members,
  organizations,
  projectTeams,
  projects,
  teamMembers,
  teams,
} from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import { executeCommand } from "@/application/commands/execute-command.server"
import {
  readableProjectCondition,
  readableTeamCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"
import {
  projectChangesSchema,
  projectFields,
} from "@/lib/shared-project-contract"
import { targetTimestamp } from "@/lib/initiatives"

async function requireProjectTeam(
  tx: Transaction,
  actor: Actor,
  teamId: string
) {
  // Lock the actor's membership before checking visibility so revocation cannot
  // race a successful relation write. Project scopes do not imply issue scopes.
  await tx
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.workspaceId, actor.workspaceId),
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, actor.userId)
      )
    )
    .for("share")
  const row = (
    await tx
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, teamId), readableTeamCondition(actor, teams.id)))
      .for("share")
  )[0]
  if (!row) throw new ApplicationAccessError()
}

async function authorize(
  tx: Transaction,
  actor: Actor,
  changes: ProjectChanges,
  replay = false
) {
  requireResourceScope(actor, "projects:read")
  requireResourceScope(actor, "projects:write")
  for (const change of changes) {
    if (change.expectedRevision !== null || replay) {
      const row = (
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, change.id),
              readableProjectCondition(actor, projects.id)
            )
          )
      )[0]
      if (!row) throw new ApplicationAccessError()
    }
  }
}

/** Used by the authenticated save queue. Receipts contain identities, never drafts. */
export async function saveCanonicalProjects(
  actor: Actor,
  commandKey: string,
  raw: unknown
) {
  const changes = projectChangesSchema.parse(raw)
  return executeCommand({
    actor,
    commandKey,
    operation: "projects.save@1",
    input: changes,
    status: 200,
    parse: (value) =>
      z
        .object({ revision: z.literal(1) })
        .strict()
        .parse(value),
    authorize: (tx, current, value) =>
      authorize(tx, current, changes, Boolean(value)),
    run: async (tx, current) => {
      // Same lock order as canonical issue writes: relation changes and linking
      // cannot race, and bulk saves either all commit or all roll back.
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, current.workspaceId))
        .for("no key update")
      for (const change of changes) {
        const old = (
          await tx
            .select()
            .from(projects)
            .where(
              and(
                eq(projects.workspaceId, current.workspaceId),
                eq(projects.id, change.id)
              )
            )
            .for("update")
        )[0]
        if (
          change.expectedRevision === null
            ? Boolean(old)
            : !old || old.revision !== change.expectedRevision
        )
          throw new Error(
            "This project changed in another session. Your draft is preserved. Load the latest shared version and review your changes."
          )
        const core = projectFields.strip().parse({
          status: "Backlog",
          teamIds: [],
          ...old?.properties,
          ...change.changes,
          name: change.changes.name ?? old?.name,
        })
        if (
          core.startDate &&
          core.targetDate &&
          targetTimestamp(core.startDate) > targetTimestamp(core.targetDate)
        )
          throw new Error("The target date must be on or after the start date.")
        for (const userId of new Set(
          [change.changes.leadId, ...(change.changes.memberIds ?? [])].filter(
            Boolean
          )
        )) {
          if (
            !(
              await tx
                .select({ id: members.id })
                .from(members)
                .where(
                  and(
                    eq(members.organizationId, current.workspaceId),
                    eq(members.userId, userId!)
                  )
                )
                .for("share")
            )[0]
          )
            throw new Error(
              "Choose a current workspace member for the project."
            )
        }
        const links = old
          ? await tx
              .select({ teamId: projectTeams.teamId })
              .from(projectTeams)
              .where(eq(projectTeams.projectId, old.id))
          : []
        const visible = old
          ? await tx
              .select({ teamId: projectTeams.teamId })
              .from(projectTeams)
              .where(
                and(
                  eq(projectTeams.projectId, old.id),
                  readableTeamCondition(current, projectTeams.teamId)
                )
              )
          : []
        const visibleIds = new Set(visible.map((l) => l.teamId))
        const desired = [
          ...new Set(change.changes.teamIds ?? visible.map((l) => l.teamId)),
        ]
        const added = desired.filter(
          (id) => !links.some((l) => l.teamId === id)
        )
        // A submitted hidden ID must not be accepted merely because it is already linked.
        for (const id of desired)
          if (!visibleIds.has(id)) await requireProjectTeam(tx, current, id)
        const removed = visible
          .filter((l) => !desired.includes(l.teamId))
          .map((l) => l.teamId)
        for (const id of removed) await requireProjectTeam(tx, current, id)
        if (
          removed.length &&
          (
            await tx
              .select({ id: issues.id })
              .from(issues)
              .where(
                and(
                  eq(issues.projectId, change.id),
                  inArray(issues.teamId, removed)
                )
              )
              .limit(1)
          )[0]
        )
          throw new Error(
            "Move this team's issues out of the project before removing the team."
          )
        const effectiveTeams = [
          ...new Set([
            ...links
              .filter((l) => !visibleIds.has(l.teamId))
              .map((l) => l.teamId),
            ...desired,
          ]),
        ]
        if (
          change.changes.teamIds &&
          effectiveTeams.length &&
          (
            await tx
              .select({ id: issues.id })
              .from(issues)
              .where(
                and(
                  eq(issues.projectId, change.id),
                  notInArray(issues.teamId, effectiveTeams)
                )
              )
              .limit(1)
          )[0]
        )
          throw new ApplicationAccessError()
        const now = new Date().toISOString()
        const properties = {
          ...old?.properties,
          ...core,
          teamIds: undefined,
          creatorId: old?.properties.creatorId ?? current.userId,
          createdAt: old?.properties.createdAt ?? now,
          updatedAt: now,
        }
        if (old)
          await tx
            .update(projects)
            .set({ name: core.name, properties })
            .where(eq(projects.id, old.id))
        else
          await tx.insert(projects).values({
            id: change.id,
            workspaceId: current.workspaceId,
            name: core.name,
            properties,
          })
        if (removed.length)
          await tx
            .delete(projectTeams)
            .where(
              and(
                eq(projectTeams.projectId, change.id),
                inArray(projectTeams.teamId, removed)
              )
            )
        if (added.length)
          await tx.insert(projectTeams).values(
            added.map((teamId) => ({
              workspaceId: current.workspaceId,
              projectId: change.id,
              teamId,
            }))
          )
      }
      return {
        value: { revision: 1 as const },
        resource: { type: "project", id: changes[0].id },
        events: changes.map((c) => ({
          topic:
            c.expectedRevision === null ? "project.created" : "project.updated",
          payload: { projectId: c.id },
        })),
      }
    },
  })
}

import "@tanstack/react-start/server-only"
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { initiativeSettings } from "./initiative-gate.server"
import { reconcileProjectEntries } from "./project-content"
import type { CommandOptions } from "@/application/commands/execute-command.server"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { Initiative, InitiativeStore } from "@/lib/initiatives"
import type { InitiativeChanges } from "@/lib/shared-initiative-contract"
import {
  db,
  initiativeProjects,
  initiatives,
  issues,
  members,
  organizations,
  projectTeams,
  projects,
  teamMembers,
  teams,
} from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import {
  readableIssueCondition,
  readableProjectCondition,
  readableTeamCondition,
} from "@/application/resource-policy.server"
import {
  blankInitiative,
  emptyInitiatives,
  initiativeProjectSchema,
  initiativeSchema,
} from "@/lib/initiatives"
import {
  initiativeChangesSchema,
  initiativeFields,
} from "@/lib/shared-initiative-contract"

function session(actor: Actor) {
  if (actor.authentication.kind !== "session" || actor.scopes !== null)
    throw new ApplicationAccessError()
}
async function authorize(
  tx: Transaction,
  actor: Actor,
  changes: InitiativeChanges
) {
  session(actor)
  if (!(await initiativeSettings(tx, actor)).enabled)
    throw new ApplicationAccessError(
      "Shared initiatives are not enabled for this workspace."
    )
  for (const change of changes) {
    if (
      change.expectedRevision !== null &&
      !(
        await tx
          .select({ id: initiatives.id })
          .from(initiatives)
          .where(
            and(
              eq(initiatives.id, change.id),
              eq(initiatives.workspaceId, actor.workspaceId)
            )
          )
      )[0]
    )
      throw new ApplicationAccessError()
    for (const id of new Set([
      ...change.addProjectIds,
      ...change.removeProjectIds,
    ])) {
      if (
        !(
          await tx
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.id, id),
                readableProjectCondition(actor, projects.id)
              )
            )
        )[0]
      )
        throw new ApplicationAccessError()
    }
  }
}
/** A relation write must retain live visibility until commit, including private-team revocation. */
export async function lockProject(tx: Transaction, actor: Actor, id: string) {
  await tx
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.id, id), eq(projects.workspaceId, actor.workspaceId))
    )
    .for("share")
  const links = await tx
    .select({ teamId: projectTeams.teamId })
    .from(projectTeams)
    .where(eq(projectTeams.projectId, id))
  for (const teamId of links.map((l) => l.teamId).sort()) {
    await tx
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, actor.userId)
        )
      )
      .for("share")
    await tx
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.id, teamId))
      .for("share")
  }
  if (
    !(
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(eq(projects.id, id), readableProjectCondition(actor, projects.id))
        )
    )[0]
  )
    throw new ApplicationAccessError()
}
export function canonicalInitiativeSaveCommand(
  actor: Actor,
  commandKey: string,
  raw: unknown
) {
  const changes = initiativeChangesSchema.parse(raw)
  return {
    actor,
    commandKey,
    operation: "initiatives.save@1",
    input: changes,
    status: 200,
    parse: (value) =>
      z
        .object({ revision: z.literal(1) })
        .strict()
        .parse(value),
    authorize: (tx, current) => authorize(tx, current, changes),
    run: async (tx, current) => {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, current.workspaceId))
        .for("no key update")
      // Recheck the administrative gate under the same serialization lock as settings writes.
      await authorize(tx, current, changes)
      for (const change of changes) {
        const [old] = await tx
          .select()
          .from(initiatives)
          .where(
            and(
              eq(initiatives.id, change.id),
              eq(initiatives.workspaceId, current.workspaceId)
            )
          )
          .for("update")
        if (
          change.expectedRevision === null
            ? Boolean(old)
            : !old || old.revision !== change.expectedRevision
        )
          throw new Error(
            "This initiative changed in another session. Your draft is preserved. Load the latest shared version and review your changes."
          )
        const now = new Date().toISOString()
        const before = old?.properties as Partial<Initiative> | undefined
        const properties = initiativeFields.strip().parse({
          ...blankInitiative(current.userId),
          ...before,
          ...change.changes,
          name: change.changes.name ?? old?.name,
        })
        if (
          properties.ownerId &&
          (!old || change.changes.ownerId !== undefined) &&
          !(
            await tx
              .select({ id: members.id })
              .from(members)
              .where(
                and(
                  eq(members.organizationId, current.workspaceId),
                  eq(members.userId, properties.ownerId)
                )
              )
              .for("share")
          )[0]
        )
          throw new ApplicationAccessError()
        if (
          [
            ...properties.updates,
            ...properties.comments,
            ...properties.updates.flatMap((e) => e.comments),
          ].some((e) => e.attachments.length)
        )
          throw new Error("Initiative attachments are not available yet.")
        properties.updates = initiativeFields.shape.updates.parse(
          reconcileProjectEntries(
            current,
            before?.updates ?? [],
            properties.updates,
            now
          ).reverse()
        )
        properties.comments = initiativeFields.shape.comments.parse(
          reconcileProjectEntries(
            current,
            before?.comments ?? [],
            properties.comments,
            now
          ).reverse()
        )
        const stored = {
          ...properties,
          creatorId: before?.creatorId ?? current.userId,
          createdAt: before?.createdAt ?? now,
          updatedAt: now,
          completedAt:
            properties.status === "Completed"
              ? (before?.completedAt ?? now)
              : null,
        }
        if (old)
          await tx
            .update(initiatives)
            .set({ name: properties.name, properties: stored })
            .where(eq(initiatives.id, old.id))
        else {
          const [next] = await tx
            .select({
              number: sql<number>`coalesce(max(${initiatives.number}), 0)::int + 1`,
            })
            .from(initiatives)
            .where(eq(initiatives.workspaceId, current.workspaceId))
          await tx.insert(initiatives).values({
            id: change.id,
            workspaceId: current.workspaceId,
            name: properties.name,
            number: next.number,
            revision: 1,
            properties: stored,
          })
        }
        for (const projectId of [
          ...new Set([...change.addProjectIds, ...change.removeProjectIds]),
        ].sort())
          await lockProject(tx, current, projectId)
        if (
          change.addProjectIds.some((id) =>
            change.removeProjectIds.includes(id)
          )
        )
          throw new Error("A project cannot be added and removed together.")
        // Deltas preserve unreadable links; never replace memberships with a filtered client list.
        if (change.removeProjectIds.length)
          await tx
            .delete(initiativeProjects)
            .where(
              and(
                eq(initiativeProjects.initiativeId, change.id),
                inArray(initiativeProjects.projectId, change.removeProjectIds)
              )
            )
        for (const projectId of new Set(change.addProjectIds))
          await tx
            .insert(initiativeProjects)
            .values({
              workspaceId: current.workspaceId,
              initiativeId: change.id,
              projectId,
            })
            .onConflictDoNothing()
      }
      return {
        value: { revision: 1 as const },
        resource: { type: "initiative", id: changes[0].id },
        events: changes.map((c) => ({
          topic: "initiative.updated",
          payload: { initiativeId: c.id },
        })),
      }
    },
  } satisfies CommandOptions<{
    revision: 1
  }>
}

export async function saveCanonicalInitiatives(
  actor: Actor,
  commandKey: string,
  raw: unknown
) {
  return executeCommand(canonicalInitiativeSaveCommand(actor, commandKey, raw))
}

/** SQL visibility precedes every child/aggregate query. This transaction supplies directory and detail together. */
export async function initiativeSnapshot(
  tx: Transaction,
  actor: Actor
): Promise<InitiativeStore> {
  session(actor)
  if (!(await initiativeSettings(tx, actor)).enabled) return emptyInitiatives()
  const rows = await tx
    .select()
    .from(initiatives)
    .where(eq(initiatives.workspaceId, actor.workspaceId))
    .orderBy(asc(initiatives.number))
  const childRows = await tx
    .select({
      initiativeId: initiativeProjects.initiativeId,
      project: projects,
    })
    .from(initiativeProjects)
    .innerJoin(projects, eq(projects.id, initiativeProjects.projectId))
    .where(
      and(
        eq(initiativeProjects.workspaceId, actor.workspaceId),
        readableProjectCondition(actor, projects.id)
      )
    )
  const teamLinks = await tx
    .select({ projectId: projectTeams.projectId, teamId: projectTeams.teamId })
    .from(projectTeams)
    .where(
      and(
        eq(projectTeams.workspaceId, actor.workspaceId),
        readableTeamCondition(actor, projectTeams.teamId)
      )
    )
  const counts = await tx
    .select({
      projectId: issues.projectId,
      count: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) FILTER (WHERE EXISTS (SELECT 1 FROM issue_statuses s WHERE s.workspace_id = ${issues.workspaceId} AND s.team_id = ${issues.teamId} AND s.id = ${issues.statusId} AND s.status_group = 'completed'))::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.workspaceId, actor.workspaceId),
        readableProjectCondition(actor, issues.projectId),
        readableIssueCondition(actor, issues.id),
        isNull(issues.archivedAt),
        isNull(issues.deletedAt)
      )
    )
    .groupBy(issues.projectId)
  const visibleDependencyProjects = new Set(
    (
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, actor.workspaceId),
            readableProjectCondition(actor, projects.id)
          )
        )
    ).map((p) => p.id)
  )
  const items = rows.map((row) => {
    const children = childRows
      .filter((c) => c.initiativeId === row.id)
      .map(({ project: p }) =>
        initiativeProjectSchema.parse({
          ...p.properties,
          id: p.id,
          name: p.name,
          revision: p.revision,
          status: p.properties.status ?? "Backlog",
          health: p.properties.health ?? "Update missing",
          dependencyIds: Array.isArray(p.properties.dependencyIds)
            ? p.properties.dependencyIds.filter(
                (id: unknown) =>
                  typeof id === "string" && visibleDependencyProjects.has(id)
              )
            : [],
          teamIds: teamLinks
            .filter((t) => t.projectId === p.id)
            .map((t) => t.teamId),
        })
      )
    const visibleCounts = counts.filter((c) =>
      children.some((p) => p.id === c.projectId)
    )
    const issueCount = visibleCounts.reduce((n, c) => n + c.count, 0),
      completedIssues = visibleCounts.reduce((n, c) => n + c.completed, 0)
    return initiativeSchema.parse({
      ...blankInitiative(""),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      ...row.properties,
      id: row.id,
      number: row.number,
      revision: row.revision,
      name: row.name,
      projects: children,
      teamIds: [],
      labelIds: [],
      resources: [],
      views: [],
      rollup: {
        projectCount: children.length,
        completedProjects: children.filter((p) => p.status === "Completed")
          .length,
        issueCount,
        completedIssues,
        percent: issueCount
          ? Math.round((completedIssues / issueCount) * 100)
          : 0,
      },
    })
  })
  return {
    version: 1,
    nextNumber: Math.max(1, ...rows.map((r) => r.number + 1)),
    initiatives: items,
    workspaceProjects: [],
  }
}
export async function readCanonicalInitiatives(actor: Actor) {
  session(actor)
  return db.transaction(
    async (tx) => initiativeSnapshot(tx, await currentCommandActor(tx, actor)),
    { isolationLevel: "repeatable read" }
  )
}

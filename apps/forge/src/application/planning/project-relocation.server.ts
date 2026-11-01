import "@tanstack/react-start/server-only"
import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { assertUniqueMilestones } from "./project-content"
import type { Transaction } from "@/db"
import type { Actor } from "@/application/actor"
import type { ProjectChanges } from "@/lib/shared-project-contract"
import type { InitiativeProject } from "@/lib/initiatives"
import { issues, projectTeams, projects, teams } from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import {
  readableIssueCondition,
  readableProjectCondition,
  readableTeamCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"

export async function relocateMilestone(
  tx: Transaction,
  actor: Actor,
  source: typeof projects.$inferSelect,
  relocation: NonNullable<ProjectChanges[number]["relocation"]>,
  now: string
) {
  requireResourceScope(actor, "issues:read")
  requireResourceScope(actor, "issues:write")
  const milestones = (source.properties.milestones ?? []) as NonNullable<
    InitiativeProject["milestones"]
  >
  const milestone = milestones.find((m) => m.id === relocation.milestoneId)
  if (!milestone)
    throw new Error(
      "This milestone is no longer available. Load the latest project."
    )
  if (
    relocation.targetId === source.id ||
    (relocation.targetId && relocation.convertId)
  )
    throw new Error("Choose another destination project.")
  const sourceLinks = await tx
    .select()
    .from(projectTeams)
    .where(eq(projectTeams.projectId, source.id))
  let target = relocation.targetId
    ? (
        await tx
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, relocation.targetId),
              readableProjectCondition(actor, projects.id)
            )
          )
          .for("update")
      )[0]
    : undefined
  if (
    relocation.targetId &&
    (!target || target.revision !== relocation.targetRevision)
  )
    throw new Error(
      "The destination is unavailable or changed. Load the latest project before retrying."
    )
  if (relocation.convertId) {
    // Creating a project cannot copy invisible team identities into a new relation.
    for (const link of sourceLinks) {
      if (
        !(
          await tx
            .select({ id: teams.id })
            .from(teams)
            .where(
              and(
                eq(teams.id, link.teamId),
                readableTeamCondition(actor, teams.id)
              )
            )
        )[0]
      )
        throw new ApplicationAccessError()
    }
    target = (
      await tx
        .insert(projects)
        .values({
          id: relocation.convertId,
          workspaceId: actor.workspaceId,
          name: milestone.name,
          properties: {
            status: "Backlog",
            health: "Update missing",
            description: milestone.description,
            targetDate: milestone.targetDate,
            creatorId: actor.userId,
            createdAt: now,
            updatedAt: now,
          },
        })
        .returning()
    )[0]
    if (sourceLinks.length)
      await tx.insert(projectTeams).values(
        sourceLinks.map((l) => ({
          workspaceId: actor.workspaceId,
          projectId: target!.id,
          teamId: l.teamId,
        }))
      )
  }
  const targetLinks = target
    ? await tx
        .select()
        .from(projectTeams)
        .where(eq(projectTeams.projectId, target.id))
    : []
  const values = [
    ...new Set([milestone.id, milestone.name, ...(milestone.aliases ?? [])]),
  ]
  // Include archived/recoverable issues: restoring one must not revive a dangling assignment.
  const affected = await tx
    .select({
      row: issues,
      readable: sql<boolean>`${readableIssueCondition(actor, issues.id, true)}`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.workspaceId, actor.workspaceId),
        eq(issues.projectId, source.id),
        sql`${issues.properties}->>'milestone' IN (${sql.join(
          values.map((v) => sql`${v}`),
          sql`, `
        )})`
      )
    )
    .orderBy(issues.id)
    .for("update")
  if (
    affected.some(
      ({ row, readable }) =>
        !readable ||
        row.purgeStartedAt ||
        (targetLinks.length &&
          !targetLinks.some((l) => l.teamId === row.teamId))
    )
  )
    throw new ApplicationAccessError(
      "The milestone cannot be changed with your current access or destination."
    )
  const events: Array<{ topic: string; payload: Record<string, unknown> }> = []
  for (const { row } of affected) {
    const nextMilestone = target && !relocation.convertId ? milestone.id : ""
    const nextProject = target?.id ?? source.id
    await tx
      .update(issues)
      .set({
        projectId: nextProject,
        properties: {
          ...row.properties,
          project: nextProject,
          milestone: nextMilestone,
        },
      })
      .where(eq(issues.id, row.id))
    events.push({
      topic: "issue.updated",
      payload: {
        issueId: row.id,
        teamId: row.teamId,
        history: {
          version: 1,
          changes: [
            {
              field: "milestone",
              from: String(row.properties.milestone ?? ""),
              to: nextMilestone,
            },
            ...(nextProject !== source.id
              ? [{ field: "project", from: source.id, to: nextProject }]
              : []),
          ],
        },
      },
    })
  }
  if (target && !relocation.convertId) {
    const targetMilestones = (target.properties.milestones ??
      []) as typeof milestones
    assertUniqueMilestones([...targetMilestones, milestone])
    await tx
      .update(projects)
      .set({
        properties: {
          ...target.properties,
          milestones: [...targetMilestones, milestone],
          updatedAt: now,
        },
      })
      .where(eq(projects.id, target.id))
  }
  if (target)
    events.push({
      topic: relocation.convertId ? "project.created" : "project.updated",
      payload: { projectId: target.id },
    })
  return {
    milestones: milestones.filter((m) => m.id !== milestone.id),
    event: {
      id: randomUUID(),
      authorId: actor.userId,
      createdAt: now,
      text: `${target ? (relocation.convertId ? "converted" : "moved") : "deleted"} milestone ${milestone.name}`,
    },
    events,
  }
}

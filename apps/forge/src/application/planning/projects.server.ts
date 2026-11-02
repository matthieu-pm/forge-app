import "@tanstack/react-start/server-only"
import { and, eq, inArray, notInArray } from "drizzle-orm"
import { z } from "zod"
import { bindProjectPostFiles } from "./project-files.server"
import {
  projectMilestoneEvents,
  reconcileProjectEntries,
} from "./project-content"
import { relocateMilestone } from "./project-relocation.server"
import {
  projectStatusValue,
  readProjectCatalog,
} from "./project-catalog.server"
import type { InitiativeProject } from "@/lib/initiatives"
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
    const targetId =
      change.relocation?.targetId ??
      (replay ? change.relocation?.convertId : undefined)
    if (
      targetId &&
      !(
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, targetId),
              readableProjectCondition(actor, projects.id)
            )
          )
      )[0]
    )
      throw new ApplicationAccessError()
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
      const events: Array<{ topic: string; payload: Record<string, unknown> }> =
        []
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
        const now = new Date().toISOString()
        const relocated =
          change.relocation && old
            ? await relocateMilestone(tx, current, old, change.relocation, now)
            : undefined
        if (change.relocation && (!old || Object.keys(change.changes).length))
          throw new Error("Relocate a saved milestone in a separate command.")
        const core = projectFields.strip().parse({
          status: "Backlog",
          teamIds: [],
          ...old?.properties,
          ...change.changes,
          name: change.changes.name ?? old?.name,
        })
        const previous = (old?.properties ?? {}) as Partial<InitiativeProject>
        if (
          !relocated &&
          change.changes.milestones &&
          previous.milestones?.some(
            (m) => !core.milestones?.some((n) => n.id === m.id)
          )
        )
          throw new Error(
            "Use the milestone deletion command to update all issue assignments together."
          )
        if (relocated) {
          core.milestones = relocated.milestones
          events.push(...relocated.events)
        }
        // Keep canonical identities stable when editing a milestone name.
        if (core.milestones)
          for (const milestone of core.milestones) {
            const prior = previous.milestones?.find(
              (m) => m.id === milestone.id
            )
            milestone.aliases = [
              ...new Set([
                ...(prior?.aliases ?? []),
                ...(prior && prior.name !== milestone.name ? [prior.name] : []),
              ]),
            ]
            milestone.descriptionHistory = prior?.descriptionHistory ?? []
            if (
              prior &&
              JSON.stringify(prior.description) !==
                JSON.stringify(milestone.description) &&
              prior.description
            )
              milestone.descriptionHistory = [
                ...milestone.descriptionHistory,
                { description: prior.description, createdAt: now },
              ].slice(-50)
          }
        const catalog = await readProjectCatalog(tx, current)
        if (change.changes.statusId) {
          const status = catalog.statuses.statuses.find(
            (s) => s.id === core.statusId
          )
          if (!status) throw new Error("Choose an active project status.")
          core.status = projectStatusValue[status.group]
        } else if (change.changes.status !== undefined) core.statusId = ""
        for (const id of change.changes.labelIds ?? [])
          if (
            !(previous.labelIds ?? []).includes(id) &&
            !catalog.labels.labels.some((l) => l.id === id && !l.archived) &&
            !catalog.labels.groups.some((g) => g.id === id)
          )
            throw new Error("Choose an active project label.")
        if (change.changes.updates)
          core.updates = reconcileProjectEntries(
            current,
            previous.updates ?? [],
            core.updates ?? [],
            now
          ) as InitiativeProject["updates"]
        if (change.changes.comments)
          core.comments = reconcileProjectEntries(
            current,
            previous.comments ?? [],
            core.comments ?? [],
            now
          ).map((entry) => ({ ...entry, comments: entry.comments ?? [] }))
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
        const properties = {
          ...old?.properties,
          ...core,
          teamIds: undefined,
          health: core.updates?.[0]?.health ?? "Update missing",
          milestoneEvents: [
            ...(previous.milestoneEvents ?? []),
            ...(relocated
              ? [relocated.event]
              : projectMilestoneEvents(
                  current,
                  previous.milestones,
                  core.milestones,
                  now
                )),
          ].slice(-1000),
          creatorId: old?.properties.creatorId ?? current.userId,
          createdAt: old?.properties.createdAt ?? now,
          updatedAt: now,
        }
        await bindProjectPostFiles(
          tx,
          current,
          change.id,
          old?.properties ?? {},
          properties
        )
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
        events: [
          ...events,
          ...changes.map((c) => ({
            topic:
              c.expectedRevision === null
                ? "project.created"
                : "project.updated",
            payload: {
              projectId: c.id,
              version: 1,
              fields: Object.keys(c.changes),
              actorUserId: current.userId,
            },
          })),
        ],
      }
    },
  })
}

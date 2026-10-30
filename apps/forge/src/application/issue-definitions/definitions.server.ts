import "@tanstack/react-start/server-only"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type {
  DefinitionCommand,
  DefinitionSnapshot,
} from "@/lib/issue-definition-contract"
import {
  db,
  issueDefinitionScopes,
  issueLabels,
  issueStatuses,
  issues,
  resourceLabels,
  teamRecurringIssues,
  teamTemplates,
  teams,
} from "@/db"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import {
  readableIssueCondition,
  readableTeamCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import {
  defaultDefinitionValue,
  definitionCommandSchema,
  definitionValueSchema,
} from "@/lib/issue-definition-contract"

export class DefinitionConflictError extends Error {
  readonly code = "DEFINITION_CONFLICT"
  constructor(
    message = "Definitions changed in another session. Reload and try again."
  ) {
    super(message)
  }
}
const scopeCondition = (workspaceId: string, teamId: string | null) =>
  and(
    eq(issueDefinitionScopes.workspaceId, workspaceId),
    eq(issueDefinitionScopes.scopeKey, teamId ?? "workspace")
  )
const labelCondition = (workspaceId: string, teamId: string | null) =>
  and(
    eq(resourceLabels.workspaceId, workspaceId),
    teamId ? eq(resourceLabels.teamId, teamId) : isNull(resourceLabels.teamId)
  )
async function authorize(
  tx: Transaction,
  actor: Actor,
  teamId: string | null,
  write = false
) {
  requireResourceScope(actor, "issues:read")
  if (write) {
    requireResourceScope(actor, "issues:write")
    if (!hasWorkspaceRole(actor, ["owner", "admin"]))
      throw new ApplicationAccessError(
        "Only workspace owners and admins can change issue definitions."
      )
  }
  if (teamId) {
    const row = (
      await tx
        .select()
        .from(teams)
        .where(
          and(eq(teams.id, teamId), readableTeamCondition(actor, teams.id))
        )
        .for("share")
    )[0]
    if (!row) throw new ApplicationAccessError()
  }
}
async function read(
  tx: Transaction,
  actor: Actor,
  teamId: string | null
): Promise<DefinitionSnapshot> {
  const row = (
    await tx
      .select()
      .from(issueDefinitionScopes)
      .where(scopeCondition(actor.workspaceId, teamId))
  )[0]
  const value = row
    ? definitionValueSchema.parse(row.value)
    : defaultDefinitionValue()
  if (teamId) {
    const statuses = await tx
      .select()
      .from(issueStatuses)
      .where(
        and(
          eq(issueStatuses.workspaceId, actor.workspaceId),
          eq(issueStatuses.teamId, teamId)
        )
      )
      .orderBy(asc(issueStatuses.position))
    value.statuses.statuses = statuses.map(
      ({ id, name, group, description, color }) => ({
        id,
        name,
        group: group as (typeof value.statuses.statuses)[number]["group"],
        description,
        color,
      })
    )
  }
  const labels = await tx
    .select()
    .from(resourceLabels)
    .where(labelCondition(actor.workspaceId, teamId))
    .orderBy(asc(resourceLabels.name))
  // Counts come from canonical assignments, never from client-supplied counters.
  const counts = await tx
    .select({ id: issueLabels.labelId, count: sql<number>`count(*)::int` })
    .from(issueLabels)
    .innerJoin(resourceLabels, eq(resourceLabels.id, issueLabels.labelId))
    .where(
      and(
        labelCondition(actor.workspaceId, teamId),
        readableIssueCondition(actor, issueLabels.issueId)
      )
    )
    .groupBy(issueLabels.labelId)
  value.labels.labels = labels.map((l) => ({
    id: l.id,
    name: l.name,
    description: l.definition?.description ?? "",
    color: l.definition?.color ?? "#5e6ad2",
    groupId: l.definition?.groupId ?? null,
    createdAt: l.definition?.createdAt ?? "2026-10-30T00:00:00.000Z",
    lastApplied: null,
    archived: l.definition?.archived ?? false,
    issues: counts.find((c) => c.id === l.id)?.count ?? 0,
  }))
  return {
    workspaceId: actor.workspaceId,
    teamId,
    revision: row?.revision ?? 0,
    canManage:
      hasWorkspaceRole(actor, ["owner", "admin"]) &&
      (actor.scopes === null || actor.scopes.includes("issues:write")),
    value: definitionValueSchema.parse(value),
  }
}
export async function readIssueDefinitions(
  actor: Actor,
  teamId: string | null
) {
  return db.transaction(
    async (tx) => {
      const current = await currentCommandActor(tx, actor)
      await authorize(tx, current, teamId)
      return read(tx, current, teamId)
    },
    { isolationLevel: "repeatable read" }
  )
}
export async function readAllIssueDefinitions(actor: Actor) {
  return db.transaction(
    async (tx) => {
      const current = await currentCommandActor(tx, actor)
      await authorize(tx, current, null)
      const visible = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(readableTeamCondition(current, teams.id))
      const snapshots = [await read(tx, current, null)]
      for (const team of visible)
        snapshots.push(await read(tx, current, team.id))
      return {
        userId: current.userId,
        sessionId:
          current.authentication.kind === "session"
            ? current.authentication.sessionId
            : "",
        workspaceId: current.workspaceId,
        snapshots,
      }
    },
    { isolationLevel: "repeatable read" }
  )
}
export async function saveIssueDefinitions(
  actor: Actor,
  raw: DefinitionCommand
) {
  const input = definitionCommandSchema.parse(raw)
  if (
    actor.workspaceId !== input.workspaceId ||
    actor.authentication.kind !== "session" ||
    actor.authentication.sessionId !== input.sessionId
  )
    throw new ApplicationAccessError()
  const { commandKey, sessionId: _sessionId, ...commandInput } = input
  await executeCommand({
    actor,
    commandKey,
    operation: "issueDefinitions.save@1",
    input: commandInput,
    status: 200,
    parse: (value) =>
      z
        .object({ teamId: z.uuid().nullable(), revision: z.number().int() })
        .parse(value),
    authorize: async (tx, current) =>
      authorize(tx, current, input.teamId, true),
    run: async (tx, current) => {
      // Template writes take the same transaction fence in their validation trigger.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${current.workspaceId},4040))`
      )
      await tx
        .insert(issueDefinitionScopes)
        .values({
          workspaceId: current.workspaceId,
          teamId: input.teamId,
          scopeKey: input.teamId ?? "workspace",
          value: defaultDefinitionValue(),
        })
        .onConflictDoNothing()
      const scope = (
        await tx
          .select()
          .from(issueDefinitionScopes)
          .where(scopeCondition(current.workspaceId, input.teamId))
          .for("update")
      )[0]
      if (scope.revision !== input.expectedRevision)
        throw new DefinitionConflictError()
      const previous = await read(tx, current, input.teamId)
      const next = input.value
      if (
        !input.teamId &&
        (JSON.stringify(next.statuses) !==
          JSON.stringify(previous.value.statuses) ||
          JSON.stringify(next.workflows) !==
            JSON.stringify(previous.value.workflows) ||
          JSON.stringify(next.transitions) !==
            JSON.stringify(previous.value.transitions))
      )
        throw new Error("Statuses and workflows belong to a team.")
      const removedStatuses = previous.value.statuses.statuses.filter(
        (s) => !next.statuses.statuses.some((n) => n.id === s.id)
      )
      for (const [source, target] of Object.entries(input.statusReplacements))
        if (
          !removedStatuses.some((s) => s.id === source) ||
          !next.statuses.statuses.some((s) => s.id === target)
        )
          throw new Error("Choose a replacement status from this team.")
      const removedLabels = previous.value.labels.labels.filter(
        (l) => !next.labels.labels.some((n) => n.id === l.id)
      )
      for (const [source, target] of Object.entries(input.labelReplacements))
        if (
          !removedLabels.some((l) => l.id === source) ||
          !next.labels.labels.some((l) => l.id === target && !l.archived)
        )
          throw new Error(
            "Choose an active replacement label from the same scope."
          )
      const templates = await tx
        .select()
        .from(teamTemplates)
        .where(eq(teamTemplates.workspaceId, current.workspaceId))
      const recurring = await tx
        .select()
        .from(teamRecurringIssues)
        .where(eq(teamRecurringIssues.workspaceId, current.workspaceId))
      for (const record of [...templates, ...recurring]) {
        const payload = record.payload
        const properties = [
          ...("kind" in payload && payload.kind === "project"
            ? []
            : [payload.properties]),
          ...("issues" in payload
            ? payload.issues.map((i) => i.properties)
            : []),
          ...payload.subIssues.map((i) => i.properties),
        ]
        for (const property of properties) {
          const propertyTeam = property.teamIds[0] ?? record.teamId
          if (
            propertyTeam === input.teamId &&
            input.teamId &&
            previous.value.statuses.statuses.some(
              (old) =>
                (property.status === old.id || property.status === old.name) &&
                (!next.statuses.statuses.some((n) => n.id === old.id) ||
                  (property.status === old.name &&
                    next.statuses.statuses.find((n) => n.id === old.id)
                      ?.name !== old.name))
            )
          )
            throw new DefinitionConflictError(
              "This status is used by a saved template or recurring issue. Update it there before renaming or deleting it."
            )
          if (removedLabels.some((label) => property.labels.includes(label.id)))
            throw new DefinitionConflictError(
              "This label is used by a saved template or recurring issue. Update it there before deleting it."
            )
        }
      }
      if (input.teamId) {
        for (const [position, status] of next.statuses.statuses.entries())
          await tx
            .insert(issueStatuses)
            .values({
              ...status,
              position,
              workspaceId: current.workspaceId,
              teamId: input.teamId,
            })
            .onConflictDoUpdate({
              target: [
                issueStatuses.workspaceId,
                issueStatuses.teamId,
                issueStatuses.id,
              ],
              set: {
                name: status.name,
                group: status.group,
                description: status.description,
                color: status.color,
                position,
              },
            })
        // Migration is an explicit administrative operation, independent of ordinary transition rules.
        await tx.execute(
          sql`SELECT set_config('forge.definition_migration', 'true', true)`
        )
        for (const removed of removedStatuses) {
          const target = input.statusReplacements[removed.id]
          if (target)
            await tx
              .update(issues)
              .set({ statusId: target })
              .where(
                and(
                  eq(issues.workspaceId, current.workspaceId),
                  eq(issues.teamId, input.teamId),
                  eq(issues.statusId, removed.id)
                )
              )
          else if (
            (
              await tx
                .select({ id: issues.id })
                .from(issues)
                .where(
                  and(
                    eq(issues.workspaceId, current.workspaceId),
                    eq(issues.teamId, input.teamId),
                    eq(issues.statusId, removed.id)
                  )
                )
                .limit(1)
            ).length
          )
            throw new DefinitionConflictError(
              "This status is assigned to issues. Choose a replacement before deleting it."
            )
          await tx
            .delete(issueStatuses)
            .where(
              and(
                eq(issueStatuses.workspaceId, current.workspaceId),
                eq(issueStatuses.teamId, input.teamId),
                eq(issueStatuses.id, removed.id)
              )
            )
        }
      }
      for (const label of next.labels.labels) {
        const old = (
          await tx
            .select()
            .from(resourceLabels)
            .where(eq(resourceLabels.id, label.id))
        )[0]
        if (
          old &&
          (old.workspaceId !== current.workspaceId ||
            old.teamId !== input.teamId)
        )
          throw new ApplicationAccessError()
        const definition = { ...label, issues: 0, lastApplied: null }
        await tx
          .insert(resourceLabels)
          .values({
            id: label.id,
            workspaceId: current.workspaceId,
            teamId: input.teamId,
            name: label.name,
            definition,
          })
          .onConflictDoUpdate({
            target: resourceLabels.id,
            set: { name: label.name, definition },
            setWhere: labelCondition(current.workspaceId, input.teamId),
          })
      }
      for (const removed of removedLabels) {
        const target = input.labelReplacements[removed.id]
        if (target) {
          await tx.execute(
            sql`INSERT INTO issue_labels(workspace_id,issue_id,label_id) SELECT workspace_id,issue_id,${target}::uuid FROM issue_labels WHERE workspace_id=${current.workspaceId} AND label_id=${removed.id}::uuid ON CONFLICT(issue_id,label_id) DO NOTHING`
          )
          await tx
            .delete(issueLabels)
            .where(
              and(
                eq(issueLabels.workspaceId, current.workspaceId),
                eq(issueLabels.labelId, removed.id)
              )
            )
        } else if (
          (
            await tx
              .select({ id: issueLabels.id })
              .from(issueLabels)
              .where(
                and(
                  eq(issueLabels.workspaceId, current.workspaceId),
                  eq(issueLabels.labelId, removed.id)
                )
              )
              .limit(1)
          ).length
        )
          throw new DefinitionConflictError(
            "This label is assigned to issues. Choose a replacement or archive it."
          )
        await tx
          .delete(resourceLabels)
          .where(
            and(
              eq(resourceLabels.workspaceId, current.workspaceId),
              eq(resourceLabels.id, removed.id)
            )
          )
      }
      await tx
        .update(issueDefinitionScopes)
        .set({ revision: scope.revision + 1, value: next })
        .where(eq(issueDefinitionScopes.id, scope.id))
      return {
        value: { teamId: input.teamId, revision: scope.revision + 1 },
        resource: { type: "issueDefinitions", id: scope.id },
        events: [],
      }
    },
  })
  return readIssueDefinitions(actor, input.teamId)
}

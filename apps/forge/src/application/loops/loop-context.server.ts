import "@tanstack/react-start/server-only"
import { and, eq, inArray, sql } from "drizzle-orm"
import { LoopPolicyError } from "./loop-access.server"
import type { Actor } from "@/application/actor"
import type { Transaction, teamLoops } from "@/db"
import type { LoopEntity } from "@/lib/loop-contract"
import type { LoopEntitySnapshot, LoopEvent } from "@/lib/loop-matching"
import { initiatives, issueCycles, issues, projects, teams } from "@/db"
import {
  readableIssueCondition,
  readableProjectCondition,
  readableTeamCondition,
} from "@/application/resource-policy.server"
import {
  commentDocumentSchema,
  commentMentionIds,
  commentPlainText,
} from "@/lib/comment-rich-text"
import { ApplicationAccessError } from "@/application/authorization"

const list = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value
        .map((x) =>
          typeof x === "string"
            ? x
            : typeof x === "object" && x !== null
              ? String((x as { id?: unknown }).id ?? "")
              : String(x)
        )
        .filter(Boolean)
    : typeof value === "string"
      ? value
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : []
export function normalizeLoopSnapshot(
  _entity: LoopEntity,
  raw: Record<string, unknown>
): LoopEntitySnapshot {
  const p =
    typeof raw.properties === "object" && raw.properties !== null
      ? (raw.properties as Record<string, unknown>)
      : {}
  const r = { ...p, ...raw }
  const value = (...keys: Array<string>) =>
    keys.map((k) => r[k]).find((v) => v !== undefined && v !== null) ?? null
  const scalar = (...keys: Array<string>) => {
    const v = value(...keys)
    return v === null
      ? null
      : typeof v === "object"
        ? JSON.stringify(v)
        : (v as string | boolean | number | null)
  }
  return {
    id: scalar("id"),
    title: scalar("title", "name"),
    name: scalar("name", "title"),
    status:
      _entity === "issue"
        ? scalar("status_id", "statusId", "status", "state")
        : scalar("status", "statusId", "status_id"),
    priority: scalar("priority"),
    assignee: scalar("assignee_id", "assigneeId", "assignee"),
    creator: scalar(
      "creator_id",
      "creatorId",
      "created_by_user_id",
      "createdByUserId",
      "creator"
    ),
    agent: scalar("delegate_id", "agent"),
    project: scalar("project_id", "projectId", "project"),
    cycle: scalar("cycle_id", "cycleId", "cycle"),
    team:
      value("team_id", "teamId", "team") === null
        ? list(value("teamIds"))
        : scalar("team_id", "teamId", "team"),
    labels: list(value("labelIds", "labels")),
    owner: scalar("ownerId", "owner"),
    lead: scalar("leadId", "lead"),
    targetDate: scalar("targetDate", "target_date"),
    description: scalar("description", "content"),
    projects: list(value("projectIds", "projects")),
    members: list(value("memberIds", "members")),
    triage: value("triage") === true,
    milestones: JSON.stringify(value("milestones")),
  }
}
export async function authorizedLoopEntity(
  tx: Transaction,
  actor: Actor,
  entity: LoopEntity,
  id: string,
  owningTeam: string,
  allPublic = false
) {
  if (entity === "issue") {
    const row = (
      await tx
        .select()
        .from(issues)
        .where(and(eq(issues.id, id), readableIssueCondition(actor, issues.id)))
    )[0]
    if (!row) throw new ApplicationAccessError()
    return row as unknown as Record<string, unknown>
  }
  if (entity === "project") {
    const row = (
      await tx
        .select()
        .from(projects)
        .where(
          and(eq(projects.id, id), readableProjectCondition(actor, projects.id))
        )
    )[0]
    if (!row) throw new ApplicationAccessError()
    return row as unknown as Record<string, unknown>
  }
  if (entity === "initiative") {
    const row = (
      await tx
        .select()
        .from(initiatives)
        .where(
          and(
            eq(initiatives.id, id),
            eq(initiatives.workspaceId, actor.workspaceId),
            sql`EXISTS (SELECT 1 FROM initiative_projects ip JOIN project_teams pt ON pt.project_id=ip.project_id AND pt.workspace_id=ip.workspace_id WHERE ip.initiative_id=${initiatives.id} AND ${(actor.loopScope?.allPublic ?? allPublic) ? and(readableTeamCondition(actor, sql`pt.team_id`),sql`EXISTS(SELECT 1 FROM teams t WHERE t.id=pt.team_id AND t.visibility='workspace')`) : sql`pt.team_id=${owningTeam}`})`
          )
        )
    )[0]
    if (!row) throw new ApplicationAccessError()
    return row as unknown as Record<string, unknown>
  }
  if (entity === "cycle") {
    const row = (
      await tx
        .select()
        .from(issueCycles)
        .where(
          and(
            eq(issueCycles.id, id),
            eq(issueCycles.workspaceId, actor.workspaceId),
            readableTeamCondition(actor, issueCycles.teamId)
          )
        )
    )[0]
    if (!row) throw new ApplicationAccessError()
    return row as unknown as Record<string, unknown>
  }
  const row = (
    await tx
      .select()
      .from(teams)
      .where(and(eq(teams.id, id), readableTeamCondition(actor, teams.id)))
  )[0]
  if (!row) throw new ApplicationAccessError()
  return row as unknown as Record<string, unknown>
}
export async function manualLoopContext(
  tx: Transaction,
  actor: Actor,
  loop: typeof teamLoops.$inferSelect,
  id?: string
) {
  if (loop.fields.trigger.kind !== "event")
    return { kind: "manual", teamId: loop.teamId }
  if (!id) throw new LoopPolicyError("Choose the item to run this Loop on.")
  const raw = await authorizedLoopEntity(
    tx,
    actor,
    loop.fields.trigger.entity,
    id,
    loop.teamId,
    loop.fields.teamAccess === "all-public-teams"
  )
  const teamIds = (
    await tx.execute(
      sql`SELECT forge_loop_snapshot(${loop.fields.trigger.entity},${id}::uuid,${actor.workspaceId}) AS snapshot`
    )
  ).rows[0]?.snapshot as Record<string, unknown> | undefined
  const ids = list(teamIds?.teamIds)
  if (loop.fields.teamAccess === "this-team" && !ids.includes(loop.teamId))
    throw new ApplicationAccessError()
  if (loop.fields.teamAccess === "all-public-teams") {
    const visible = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(
          eq(teams.workspaceId, actor.workspaceId),
          eq(teams.visibility, "workspace"),
          inArray(teams.id, ids)
        )
      )
    if (!visible.length) throw new ApplicationAccessError()
  }
  return {
    kind: "manual",
    entity: loop.fields.trigger.entity,
    entityId: id,
    context: normalizeLoopSnapshot(loop.fields.trigger.entity, {
      ...raw,
      ...teamIds,
    }),
  }
}
export function loopMatchEvents(
  entity: LoopEntity,
  event: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>
): Array<LoopEvent> {
  const previous = before ? normalizeLoopSnapshot(entity, before) : null,
    current = normalizeLoopSnapshot(entity, after)
  const result: Array<LoopEvent> = []
  if (
    event === "created" ||
    event === "started" ||
    event === "completed" ||
    JSON.stringify(previous) !== JSON.stringify(current)
  )
    result.push({
      entity,
      event: event as LoopEvent["event"],
      before: previous,
      after: current,
    })
  const properties = (raw: Record<string, unknown> | null) =>
    (raw?.properties ?? {}) as Record<string, unknown>
  const entries = (p: Record<string, unknown>) => {
    const comments = Array.isArray(p.comments) ? p.comments : [],
      updates = Array.isArray(p.updates) ? p.updates : []
    return [
      ...comments.map((entry) => ({
        entry,
        kind: "comment" as const,
        parentId: entry.parentId,
      })),
      ...updates.flatMap((entry) => [
        { entry, kind: "update" as const, parentId: null },
        ...(Array.isArray(entry.comments)
          ? entry.comments.map((comment: Record<string, unknown>) => ({
              entry: comment,
              kind: "comment" as const,
              parentId: entry.id,
            }))
          : []),
      ]),
    ]
  }
  const oldIds = new Set(
    entries(properties(before)).map((x) => String(x.entry.id))
  )
  for (const { entry, kind, parentId } of entries(properties(after))) {
    if (
      !entry ||
      typeof entry !== "object" ||
      oldIds.has(String(entry.id)) ||
      entry.deletedAt
    )
      continue
    const body = commentDocumentSchema.safeParse(entry.document ?? entry.body)
    const text = body.success
      ? commentPlainText(body.data)
      : typeof entry.body === "string"
        ? entry.body
        : typeof entry.content === "string"
          ? entry.content
          : typeof entry.text === "string"
            ? entry.text
            : ""
    result.push({
      entity,
      event: kind,
      before: previous,
      after: current,
      ...(kind === "comment"
        ? {
            comment: {
              text,
              parentId: parentId ?? null,
              mentionIds: body.success ? commentMentionIds(body.data) : [],
            },
          }
        : {}),
    })
  }
  return result
}

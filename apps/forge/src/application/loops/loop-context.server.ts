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
type Activity = {
  entry: Record<string, unknown>
  kind: "comment" | "update"
  parentId: string | null
}
const records = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null
      )
    : []
function activities(raw: Record<string, unknown> | null): Array<Activity> {
  const p = (raw?.properties ?? {}) as Record<string, unknown>
  return [
    ...records(p.comments).map((entry) => ({
      entry,
      kind: "comment" as const,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
    })),
    ...records(p.updates).flatMap((entry) => [
      { entry, kind: "update" as const, parentId: null },
      ...records(entry.comments).map((comment) => ({
        entry: comment,
        kind: "comment" as const,
        parentId: String(entry.id),
      })),
    ]),
  ]
}
function activityPayload(activity: Activity) {
  const { entry, parentId, kind } = activity
  const document = commentDocumentSchema.safeParse(entry.document ?? entry.body)
  const text = document.success
    ? commentPlainText(document.data)
    : typeof entry.body === "string"
      ? entry.body
      : typeof entry.content === "string"
        ? entry.content
        : typeof entry.text === "string"
          ? entry.text
          : ""
  return kind === "comment"
    ? {
        comment: {
          id: String(entry.id),
          text,
          parentId,
          mentionIds: document.success ? commentMentionIds(document.data) : [],
        },
      }
    : { update: { id: String(entry.id), text } }
}
/** Posted activity remains a current source, not an authorization-free copy of
 * a comment/update that has since been removed or edited. */
export function loopActivityContext(
  raw: Record<string, unknown>,
  event: Record<string, unknown>
) {
  const saved = event.comment ?? event.update
  if (saved === undefined) return {}
  if (
    !saved ||
    typeof saved !== "object" ||
    !("id" in saved) ||
    typeof saved.id !== "string"
  )
    throw new ApplicationAccessError(
      "The triggering activity is no longer available."
    )
  const kind = event.comment ? "comment" : "update"
  const activity = activities(raw).find(
    (item) => item.kind === kind && item.entry.id === saved.id
  )
  if (!activity || activity.entry.deleted === true || activity.entry.deletedAt)
    throw new ApplicationAccessError(
      "The triggering activity is no longer available."
    )
  const current = activityPayload(activity)
  const payload = current.comment ?? current.update
  if (!("text" in saved) || saved.text !== payload.text)
    throw new ApplicationAccessError(
      "The triggering activity changed. Run the work again against its current content."
    )
  if (current.comment) {
    const original =
      "mentionIds" in saved && Array.isArray(saved.mentionIds)
        ? saved.mentionIds.filter((id): id is string => typeof id === "string")
        : []
    if (
      JSON.stringify([...new Set(original)].sort()) !==
      JSON.stringify([...new Set(current.comment.mentionIds)].sort())
    )
      throw new ApplicationAccessError(
        "The triggering activity mentions changed."
      )
  }
  return current
}
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
    summary: scalar("summary"),
    health: scalar("health"),
    startDate: scalar("startDate", "start_date"),
    endDate: scalar("endDate", "end_date"),
    dueDate: scalar("dueDate", "due_date"),
    parentId: scalar("parent_id", "parentId"),
    recurrence: scalar("recurrence"),
    snoozed: scalar("snoozed"),
    estimate: scalar("estimate"),
    links: scalar("links"),
    attachments: scalar("attachments"),
    resources: scalar("resources"),
    views: scalar("views"),
    dependencies: list(value("dependencyIds")),
    icon: scalar("icon"),
    descriptionDocument: scalar("descriptionDoc"),
    timezone: scalar("timezone"),
    number: scalar("number"),
  }
}

/** Reload current canonical relationships after checking the source grant.
 * A raw Drizzle entity row omits memberships/labels held in relation tables. */
export async function currentLoopEntitySnapshot(
  tx: Transaction,
  actor: Actor,
  entity: LoopEntity,
  id: string,
  owningTeam: string,
  allPublic = false
) {
  await authorizedLoopEntity(tx, actor, entity, id, owningTeam, allPublic)
  const raw = (
    await tx.execute(
      sql`SELECT forge_loop_snapshot(${entity},${id}::uuid,${actor.workspaceId}) AS snapshot`
    )
  ).rows[0]?.snapshot as Record<string, unknown> | null | undefined
  if (!raw) throw new ApplicationAccessError()
  const teamIds = list(raw.teamIds)
  if (teamIds.length) {
    const readable = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(
          inArray(teams.id, teamIds),
          readableTeamCondition(actor, teams.id),
          (actor.loopScope?.allPublic ?? allPublic)
            ? eq(teams.visibility, "workspace")
            : eq(teams.id, owningTeam)
        )
      )
    raw.teamIds = readable.map((team) => team.id).sort()
  }
  if (entity === "initiative") {
    const projectIds = list(raw.projectIds)
    const visibleTeams = list(raw.teamIds)
    raw.projectIds =
      projectIds.length && visibleTeams.length
        ? (
            await tx
              .select({ id: projects.id })
              .from(projects)
              .where(
                and(
                  inArray(projects.id, projectIds),
                  readableProjectCondition(actor, projects.id),
                  sql`EXISTS(SELECT 1 FROM project_teams pt WHERE pt.workspace_id=${actor.workspaceId} AND pt.project_id=${projects.id} AND pt.team_id IN (${sql.join(
                    visibleTeams.map((teamId) => sql`${teamId}::uuid`),
                    sql`, `
                  )}))`
                )
              )
          )
            .map((project) => project.id)
            .sort()
        : []
  }
  return raw
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
            sql`EXISTS (SELECT 1 FROM initiative_projects ip JOIN project_teams pt ON pt.project_id=ip.project_id AND pt.workspace_id=ip.workspace_id WHERE ip.initiative_id=${initiatives.id} AND ${(actor.loopScope?.allPublic ?? allPublic) ? and(readableTeamCondition(actor, sql`pt.team_id`), sql`EXISTS(SELECT 1 FROM teams t WHERE t.id=pt.team_id AND t.visibility='workspace')`) : sql`pt.team_id=${owningTeam}`})`
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
  const raw = await currentLoopEntitySnapshot(
    tx,
    actor,
    loop.fields.trigger.entity,
    id,
    loop.teamId,
    loop.fields.teamAccess === "all-public-teams"
  )
  const ids = list(raw.teamIds)
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
    context: normalizeLoopSnapshot(loop.fields.trigger.entity, raw),
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
  const oldIds = new Set(activities(before).map((x) => String(x.entry.id)))
  for (const activity of activities(after)) {
    const { entry, kind } = activity
    if (
      !entry ||
      typeof entry !== "object" ||
      oldIds.has(String(entry.id)) ||
      entry.deletedAt ||
      entry.deleted === true ||
      typeof entry.id !== "string"
    )
      continue
    result.push({
      entity,
      event: kind,
      before: previous,
      after: current,
      ...activityPayload(activity),
    })
  }
  return result
}

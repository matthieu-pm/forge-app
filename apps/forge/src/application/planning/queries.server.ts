import "@tanstack/react-start/server-only"
import { and, asc, count, eq, gt, ilike, inArray, or, sql } from "drizzle-orm"
import { z } from "zod"
import {
  ApplicationAccessError,
  hasScope,
  hasWorkspaceRole,
} from "../authorization"
import {
  currentMemberCondition,
  readableDocumentCondition,
  readableIssueCondition,
  readableProjectCondition,
  readableTeamCondition,
  requireCurrentActor,
  requireResourceScope,
} from "../resource-policy.server"
import type { Actor } from "../actor"
import {
  db,
  documents,
  initiativeProjects,
  initiatives,
  issueLabels,
  issueRelations,
  issues,
  projectTeams,
  projects,
  resourceLabels,
} from "@/db"

export type PlanningResource =
  "issue" | "project" | "initiative" | "document" | "label"
const pageInput = z
  .object({
    after: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    search: z.string().trim().max(200).optional(),
  })
  .strict()

function contract(actor: Actor, kind: PlanningResource) {
  if (kind === "issue") requireResourceScope(actor, "issues:read")
  else if (kind === "project") requireResourceScope(actor, "projects:read")
  // No external initiative/document/label scope contract has been enabled.
  else if (actor.authentication.kind !== "session" || actor.scopes !== null)
    throw new ApplicationAccessError()
}

/** Canonical internal read seam. All selection/ranking/export must start here. */
export async function listPlanningResources(
  actor: Actor,
  kind: PlanningResource,
  raw: z.input<typeof pageInput> = {}
) {
  actor = await requireCurrentActor(actor)
  contract(actor, kind)
  const input = pageInput.parse(raw)
  const table = {
    issue: issues,
    project: projects,
    initiative: initiatives,
    document: documents,
    label: resourceLabels,
  }[kind]
  const title =
    kind === "issue"
      ? issues.title
      : kind === "document"
        ? documents.title
        : kind === "project"
          ? projects.name
          : kind === "initiative"
            ? initiatives.name
            : resourceLabels.name
  const visibility =
    kind === "issue"
      ? readableIssueCondition(actor, issues.id)
      : kind === "project"
        ? readableProjectCondition(actor, projects.id)
        : kind === "document"
          ? readableDocumentCondition(actor, documents.id)
          : kind === "label"
            ? or(
                sql`${resourceLabels.teamId} IS NULL`,
                readableTeamCondition(actor, resourceLabels.teamId)
              )
            : currentMemberCondition(actor)
  const rows = await db
    .select({ id: table.id, title })
    .from(table)
    .where(
      and(
        eq(table.workspaceId, actor.workspaceId),
        currentMemberCondition(actor),
        visibility,
        input.after ? gt(table.id, input.after) : undefined,
        input.search
          ? ilike(title, `%${input.search.replace(/[\\%_]/g, "\\$&")}%`)
          : undefined
      )
    )
    .orderBy(asc(table.id))
    .limit(input.limit + 1)
  const items = rows.slice(0, input.limit)
  return {
    items,
    nextCursor: rows.length > input.limit ? items.at(-1)!.id : null,
  }
}

export async function getPlanningResource(
  actor: Actor,
  kind: PlanningResource,
  id: string
) {
  actor = await requireCurrentActor(actor)
  contract(actor, kind)
  z.string().uuid().parse(id)
  if (kind === "issue") {
    const [row] = await db
      .select({
        id: issues.id,
        title: issues.title,
        // Relations require their own read scope and visibility; never expose raw IDs.
        parentId: sql<
          string | null
        >`CASE WHEN ${readableIssueCondition(actor, issues.parentId)} THEN ${issues.parentId} ELSE NULL END`,
        projectId: hasScope(actor, "projects:read")
          ? sql<
              string | null
            >`CASE WHEN ${readableProjectCondition(actor, issues.projectId)} THEN ${issues.projectId} ELSE NULL END`
          : sql<null>`NULL`,
      })
      .from(issues)
      .where(and(eq(issues.id, id), readableIssueCondition(actor, issues.id)))
      .limit(1)
    return row ?? null
  }
  if (kind === "document") {
    const [row] = await db
      .select({
        id: documents.id,
        title: documents.title,
        body: documents.body,
        issueId: sql<
          string | null
        >`CASE WHEN ${readableIssueCondition(actor, documents.issueId)} THEN ${documents.issueId} ELSE NULL END`,
        teamId: sql<
          string | null
        >`CASE WHEN ${readableTeamCondition(actor, documents.teamId)} THEN ${documents.teamId} ELSE NULL END`,
        projectId: sql<
          string | null
        >`CASE WHEN ${readableProjectCondition(actor, documents.projectId)} THEN ${documents.projectId} ELSE NULL END`,
      })
      .from(documents)
      .where(
        and(
          eq(documents.id, id),
          readableDocumentCondition(actor, documents.id)
        )
      )
      .limit(1)
    return row ?? null
  }
  const table =
    kind === "project"
      ? projects
      : kind === "initiative"
        ? initiatives
        : resourceLabels
  const [row] = await db
    .select({ id: table.id, title: table.name })
    .from(table)
    .where(
      and(
        eq(table.id, id),
        eq(table.workspaceId, actor.workspaceId),
        currentMemberCondition(actor),
        kind === "project"
          ? readableProjectCondition(actor, projects.id)
          : kind === "label"
            ? or(
                sql`${resourceLabels.teamId} IS NULL`,
                readableTeamCondition(actor, resourceLabels.teamId)
              )
            : undefined
      )
    )
    .limit(1)
  return row ?? null
}

/** Bounded exports share the exact list contract/cursor, with no hidden totals. */
export const exportPlanningPage = listPlanningResources

export async function planningRollup(
  actor: Actor,
  kind: "project" | "initiative" | "label",
  id: string
) {
  actor = await requireCurrentActor(actor)
  contract(actor, kind)
  requireResourceScope(actor, "issues:read")
  if (!(await getPlanningResource(actor, kind, id))) return null
  const relation =
    kind === "project"
      ? eq(issues.projectId, id)
      : kind === "label"
        ? inArray(
            issues.id,
            db
              .select({ id: issueLabels.issueId })
              .from(issueLabels)
              .where(eq(issueLabels.labelId, id))
          )
        : inArray(
            issues.projectId,
            db
              .select({ id: initiativeProjects.projectId })
              .from(initiativeProjects)
              .where(
                and(
                  eq(initiativeProjects.initiativeId, id),
                  readableProjectCondition(actor, initiativeProjects.projectId)
                )
              )
          )
  const [result] = await db
    .select({ issueCount: count() })
    .from(issues)
    .where(and(relation, readableIssueCondition(actor, issues.id)))
  return result
}

export async function listProjectTeams(actor: Actor, id: string) {
  actor = await requireCurrentActor(actor)
  requireResourceScope(actor, "teams:read")
  if (!(await getPlanningResource(actor, "project", id))) return []
  return db
    .select({ teamId: projectTeams.teamId })
    .from(projectTeams)
    .where(
      and(
        eq(projectTeams.projectId, id),
        readableTeamCondition(actor, projectTeams.teamId)
      )
    )
}

export async function listInitiativeProjects(actor: Actor, id: string) {
  actor = await requireCurrentActor(actor)
  requireResourceScope(actor, "projects:read")
  if (!(await getPlanningResource(actor, "initiative", id))) return []
  return db
    .select({ id: projects.id, title: projects.name })
    .from(projects)
    .innerJoin(
      initiativeProjects,
      eq(initiativeProjects.projectId, projects.id)
    )
    .where(
      and(
        eq(initiativeProjects.initiativeId, id),
        readableProjectCondition(actor, projects.id)
      )
    )
}

export async function listIssueRelations(actor: Actor, id: string) {
  actor = await requireCurrentActor(actor)
  if (!(await getPlanningResource(actor, "issue", id))) return []
  return db
    .select({ id: issueRelations.relatedIssueId, kind: issueRelations.kind })
    .from(issueRelations)
    .where(
      and(
        eq(issueRelations.issueId, id),
        readableIssueCondition(actor, issueRelations.relatedIssueId)
      )
    )
}

/** A shared document can be listed without revealing its private origin's backlinks. */
export async function listIssueDocuments(actor: Actor, id: string) {
  actor = await requireCurrentActor(actor)
  contract(actor, "document")
  if (!(await getPlanningResource(actor, "issue", id))) return []
  return db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(
      and(
        eq(documents.issueId, id),
        readableDocumentCondition(actor, documents.id)
      )
    )
}

export async function shareDocumentWithWorkspace(
  actor: Actor,
  id: string,
  shared: boolean
) {
  contract(actor, "document")
  z.string().uuid().parse(id)
  z.boolean().parse(shared)
  return db.transaction(async (tx) => {
    actor = await requireCurrentActor(actor, tx)
    if (!hasWorkspaceRole(actor, ["owner", "admin"]))
      throw new ApplicationAccessError()
    const [row] = await tx
      .update(documents)
      .set({ sharedWithWorkspace: shared })
      .where(
        and(
          eq(documents.id, id),
          readableDocumentCondition(actor, documents.id),
          // Recheck role in the actual UPDATE as well as before it.
          sql`EXISTS (SELECT 1 FROM member m WHERE m.organization_id = ${actor.workspaceId} AND m.user_id = ${actor.userId} AND string_to_array(replace(m.role, ' ', ''), ',') && ARRAY['owner','admin']::text[])`
        )
      )
      .returning({ id: documents.id })
    if (!row) throw new ApplicationAccessError()
    return row
  })
}

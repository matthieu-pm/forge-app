import "@tanstack/react-start/server-only"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { Actor } from "@/application/actor"
import {
  ApplicationAccessError,
  hasScope,
  hasWorkspaceRole,
} from "@/application/authorization"
import {
  db,
  issues,
  members,
  projectTeams,
  projects,
  teamMembers,
  teams,
} from "@/db"

const relationshipInput = z
  .object({
    issueId: z.string().uuid(),
    targetId: z.string().uuid().nullable(),
  })
  .strict()

export class InvalidPlanningRelationshipError extends Error {
  readonly code = "INVALID_RELATIONSHIP"
  constructor() {
    super("The relationship is invalid or would create a parent cycle.")
  }
}

// Internal canonical command seam. Public composers/adapters remain feature-gated
// until their persistence/authorization stories wire this to a trusted Actor.
async function setRelationship(
  actor: Actor,
  raw: z.input<typeof relationshipInput>,
  kind: "parent" | "project"
) {
  const input = relationshipInput.parse(raw)
  if (
    !hasScope(actor, "issues:write") ||
    !hasScope(actor, "issues:read") ||
    (kind === "project" && !hasScope(actor, "projects:read"))
  )
    throw new ApplicationAccessError()
  try {
    await db.transaction(async (tx) => {
      const membershipRows = await tx
        .select()
        .from(members)
        .where(
          and(
            eq(members.organizationId, actor.workspaceId),
            eq(members.userId, actor.userId)
          )
        )
        .for("share")
      const membership = membershipRows.at(0)
      if (!membership) throw new ApplicationAccessError()
      const currentActor = { ...actor, workspaceRole: membership.role }
      const privileged = hasWorkspaceRole(currentActor, ["owner", "admin"])
      // Fences the complete check/write and makes concurrent parent edits safe at
      // every supported isolation level, matching the direct-SQL trigger guard.
      await tx.execute(
        sql`SELECT public.forge_lock_issue_graph(${actor.workspaceId})`
      )
      const readableTeam = async (teamId: string) => {
        const rows = await tx
          .select()
          .from(teams)
          .where(
            and(
              eq(teams.id, teamId),
              eq(teams.workspaceId, actor.workspaceId),
              sql`${teams.deletedAt} IS NULL`
            )
          )
          .for("share")
        const team = rows.at(0)
        if (!team) return false
        if (privileged || team.visibility === "workspace") return true
        const memberships = await tx
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, team.id),
              eq(teamMembers.workspaceId, actor.workspaceId),
              eq(teamMembers.userId, actor.userId)
            )
          )
          .for("share")
        return memberships.length > 0
      }
      const issueRows = await tx
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.id, input.issueId),
            eq(issues.workspaceId, actor.workspaceId)
          )
        )
        .for("update")
      const issue = issueRows.at(0)
      if (!issue || !(await readableTeam(issue.teamId)))
        throw new ApplicationAccessError()
      if (input.targetId && kind === "parent") {
        const parentRows = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, input.targetId),
              eq(issues.workspaceId, actor.workspaceId)
            )
          )
          .for("share")
        const parent = parentRows.at(0)
        if (!parent || !(await readableTeam(parent.teamId)))
          throw new ApplicationAccessError()
      }
      if (input.targetId && kind === "project") {
        const projectRows = await tx
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, input.targetId),
              eq(projects.workspaceId, actor.workspaceId)
            )
          )
          .for("share")
        const project = projectRows.at(0)
        if (!project) throw new ApplicationAccessError()
        const participating = await tx
          .select()
          .from(projectTeams)
          .where(
            and(
              eq(projectTeams.projectId, project.id),
              eq(projectTeams.workspaceId, actor.workspaceId)
            )
          )
          .for("share")
        const readable = await Promise.all(
          participating.map((t) => readableTeam(t.teamId))
        )
        if (participating.length && !readable.some(Boolean))
          throw new ApplicationAccessError()
      }
      await tx
        .update(issues)
        .set(
          kind === "parent"
            ? { parentId: input.targetId }
            : { projectId: input.targetId }
        )
        .where(
          and(
            eq(issues.id, issue.id),
            eq(issues.workspaceId, actor.workspaceId)
          )
        )
    })
  } catch (error) {
    let cause: unknown = error
    const seen = new Set<unknown>()
    while (cause && typeof cause === "object" && !seen.has(cause)) {
      seen.add(cause)
      const detail = cause as { code?: string; cause?: unknown }
      if (detail.code === "23503" || detail.code === "23514")
        throw new InvalidPlanningRelationshipError()
      cause = detail.cause
    }
    throw error
  }
}

export const setIssueParent = (
  actor: Actor,
  input: z.input<typeof relationshipInput>
) => setRelationship(actor, input, "parent")
export const setIssueProject = (
  actor: Actor,
  input: z.input<typeof relationshipInput>
) => setRelationship(actor, input, "project")

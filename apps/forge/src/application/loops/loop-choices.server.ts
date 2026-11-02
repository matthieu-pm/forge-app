import "@tanstack/react-start/server-only"
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import {
  initiativePriorities,
  initiativeProjectSchema,
  initiativeStatuses,
} from "@/lib/initiatives"
import {
  initiatives,
  issueCycles,
  issueStatuses,
  issues,
  members,
  projects,
  resourceLabels,
  teams,
  users,
} from "@/db"
import {
  readableIssueCondition,
  readableProjectCondition,
  readableTeamCondition,
} from "@/application/resource-policy.server"

export async function loopChoices(
  tx: Transaction,
  actor: Actor,
  teamId: string
) {
  const scope = or(eq(teams.id, teamId), eq(teams.visibility, "workspace"))
  const team = await tx
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(
      and(
        eq(teams.workspaceId, actor.workspaceId),
        isNull(teams.deletedAt),
        scope,
        readableTeamCondition(actor, teams.id)
      )
    )
    .orderBy(teams.name)
    .limit(100)
  const ids = team.map((t) => t.id),
    idParams = sql.join(
      team.map((t) => sql`${t.id}::uuid`),
      sql`,`
    )
  const [issue, project, initiative, cycle, status, labels, people] =
    await Promise.all([
      tx
        .select({ id: issues.id, name: issues.title })
        .from(issues)
        .where(
          and(
            eq(issues.workspaceId, actor.workspaceId),
            inArray(issues.teamId, ids),
            readableIssueCondition(actor, issues.id)
          )
        )
        .orderBy(issues.title)
        .limit(100),
      tx
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, actor.workspaceId),
            readableProjectCondition(actor, projects.id),
            sql`EXISTS(SELECT 1 FROM project_teams pt WHERE pt.project_id=${projects.id} AND pt.team_id=ANY(ARRAY[${idParams}]::uuid[]))`
          )
        )
        .orderBy(projects.name)
        .limit(100),
      tx
        .select({ id: initiatives.id, name: initiatives.name })
        .from(initiatives)
        .where(
          and(
            eq(initiatives.workspaceId, actor.workspaceId),
            sql`EXISTS(SELECT 1 FROM initiative_projects ip JOIN project_teams pt ON pt.project_id=ip.project_id AND pt.workspace_id=ip.workspace_id WHERE ip.initiative_id=${initiatives.id} AND pt.team_id=ANY(ARRAY[${idParams}]::uuid[]))`
          )
        )
        .orderBy(initiatives.name)
        .limit(100),
      tx
        .select({
          id: issueCycles.id,
          name: sql<string>`'Cycle '||${issueCycles.number}`,
        })
        .from(issueCycles)
        .where(
          and(
            eq(issueCycles.workspaceId, actor.workspaceId),
            inArray(issueCycles.teamId, ids)
          )
        )
        .limit(100),
      tx
        .select({ id: issueStatuses.id, name: issueStatuses.name })
        .from(issueStatuses)
        .where(
          and(
            eq(issueStatuses.workspaceId, actor.workspaceId),
            inArray(issueStatuses.teamId, ids)
          )
        )
        .orderBy(issueStatuses.position)
        .limit(100),
      tx
        .select({ id: resourceLabels.id, name: resourceLabels.name })
        .from(resourceLabels)
        .where(
          and(
            eq(resourceLabels.workspaceId, actor.workspaceId),
            or(
              isNull(resourceLabels.teamId),
              inArray(resourceLabels.teamId, ids)
            )
          )
        )
        .orderBy(resourceLabels.name)
        .limit(100),
      tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .innerJoin(members, eq(members.userId, users.id))
        .where(eq(members.organizationId, actor.workspaceId))
        .orderBy(users.name)
        .limit(100),
    ])
  return {
    issue,
    project,
    "issue.project": [{ id: "__none__", name: "No project" }, ...project],
    initiative,
    cycle,
    "issue.cycle": [{ id: "__none__", name: "No cycle" }, ...cycle],
    team,
    status,
    labels: [{ id: "__none__", name: "No labels" }, ...labels],
    assignee: [{ id: "__none__", name: "Unassigned" }, ...people],
    creator: people,
    owner: people,
    lead: people,
    "project.status": initiativeProjectSchema.shape.status.options.map(
      (id) => ({ id, name: id })
    ),
    "initiative.status": initiativeStatuses.map((id) => ({ id, name: id })),
    "project.priority": initiativePriorities.map((id) => ({ id, name: id })),
    "initiative.priority": initiativePriorities.map((id) => ({ id, name: id })),
    priority: [
      { id: "No priority", name: "No priority" },
      { id: "Urgent", name: "Urgent" },
      { id: "High", name: "High" },
      { id: "Medium", name: "Medium" },
      { id: "Low", name: "Low" },
    ],
  }
}

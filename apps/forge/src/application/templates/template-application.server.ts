import "@tanstack/react-start/server-only"
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { z } from "zod"
import { canonicalTemplateIssueCommand } from "./canonical-template-issue.server"
import { loadDirectory } from "./templates.server"
import {
  TemplateValidationError,
  formContent,
} from "./template-forms"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { TemplateDraft, TemplateProperties } from "@/lib/template-contract"
import type {
  ApplyTemplate,
  TemplateApplicationResult,
} from "@/lib/template-application-contract"
import { applyTemplateSchema } from "@/lib/template-application-contract"
import { templatePayloadSchema } from "@/lib/template-contract"
import {
  db,
  initiatives,
  issues,
  organizations,
  projects,
  teamMembers,
  teamTemplates,
  teams,
} from "@/db"
import { commandInputHash } from "@/application/commands/command-input"
import { executeCommand } from "@/application/commands/execute-command.server"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { ApplicationAccessError, hasScope } from "@/application/authorization"
import {
  readableIssueCondition,
  readableProjectCondition,
  readableTeamCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"
import { requireIssueTeam } from "@/application/issues/issues.server"
import { canonicalProjectSaveCommand } from "@/application/planning/projects.server"
import {
  canonicalInitiativeSaveCommand,
  lockProject,
} from "@/application/planning/initiatives.server"
import { readProjectCatalog } from "@/application/planning/project-catalog.server"
import { initiativeSettings } from "@/application/planning/initiative-gate.server"

function gate(actor: Actor) {
  if (process.env.FORGE_FEATURE_TEMPLATES !== "true")
    throw new ApplicationAccessError("Creating from templates is not enabled.")
  if (actor.authentication.kind !== "session" || actor.scopes !== null)
    throw new ApplicationAccessError()
}
const revision = (row: { payload: TemplateDraft; updatedAt: Date | string }) =>
  commandInputHash({
    payload: row.payload,
    updatedAt: new Date(row.updatedAt).toISOString(),
  })

async function templateAccess(
  tx: Transaction,
  actor: Actor,
  row: typeof teamTemplates.$inferSelect
) {
  const ids = [
    ...new Set(
      [row.teamId, row.payload.visibility].filter((id): id is string =>
        Boolean(id)
      )
    ),
  ].sort()
  for (const id of ids) {
    await tx
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(eq(teamMembers.teamId, id), eq(teamMembers.userId, actor.userId))
      )
      .for("share")
    if (
      !(
        await tx
          .select({ id: teams.id })
          .from(teams)
          .where(and(eq(teams.id, id), readableTeamCondition(actor, teams.id)))
          .for("share")
      )[0]
    )
      throw new TemplateValidationError(
        "This template is no longer available to you. Reload templates and choose an accessible template."
      )
  }
}

/** The existing tables remain authoritative; defaults only preselect a template. */
export async function loadApplicationDirectory(
  actor: Actor,
  input: { slug?: string; kind?: "issue" | "project" }
) {
  if (process.env.FORGE_FEATURE_TEMPLATES !== "true")
    return {
      enabled: false as const,
      templates: [],
      teams: [],
      defaultId: null,
    }
  gate(actor)
  const workspace = await loadDirectory(actor)
  const team = input.slug ? await loadDirectory(actor, input.slug) : null
  const accessible = new Set(workspace.teams.map((t) => t.id))
  const combined = [...workspace.templates, ...(team?.templates ?? [])].filter(
    (t) =>
      (!input.kind || t.payload.kind === input.kind) &&
      ["issue", "project"].includes(t.payload.kind) &&
      (!t.payload.visibility || accessible.has(t.payload.visibility))
  )
  let defaultId: string | null = null
  if (team) {
    const selectedTeam = team.teams.find((t) => t.slug === input.slug)!
    const member = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, selectedTeam.id),
          eq(teamMembers.userId, actor.userId)
        )
      )
    defaultId = team.defaults[member.length ? "members" : "nonMembers"]
  }
  return {
    enabled: true as const,
    templates: combined.map((t) => ({ ...t, revision: revision(t) })),
    teams: workspace.teams,
    defaultId: combined.some((t) => t.id === defaultId) ? defaultId : null,
  }
}

/** References for authoring selectors are authorized before they leave the server. */
export async function loadTemplateReferences(actor: Actor) {
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    gate(current)
    const projectRows = hasScope(current, "projects:read")
      ? await tx
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(
            and(
              eq(projects.workspaceId, current.workspaceId),
              readableProjectCondition(current, projects.id)
            )
          )
      : []
    const initiativeRows = (await initiativeSettings(tx, current)).enabled
      ? await tx
          .select({ id: initiatives.id, name: initiatives.name })
          .from(initiatives)
          .where(eq(initiatives.workspaceId, current.workspaceId))
      : []
    return {
      projects: projectRows,
      initiatives: initiativeRows,
      catalog: await readProjectCatalog(tx, current),
    }
  })
}

const resultSchema = z
  .object({
    kind: z.enum(["issue", "project"]),
    id: z.uuid(),
    issueIds: z.array(z.uuid()),
    projectIds: z.array(z.uuid()),
    initiativeIds: z.array(z.uuid()),
  })
  .strict()

export async function applyTemplate(
  actor: Actor,
  raw: ApplyTemplate
): Promise<TemplateApplicationResult> {
  const input = applyTemplateSchema.parse(raw)
  try {
    const result = await executeCommand({
      actor,
      commandKey: input.commandKey,
      operation: "templates.apply@1",
      input,
      status: 201,
      parse: (value) => resultSchema.parse(value),
      authorize: async (tx, current, value) => {
        gate(current)
        if (!value) return
        const [row] = await tx
          .select()
          .from(teamTemplates)
          .where(
            and(
              eq(teamTemplates.id, input.templateId),
              eq(teamTemplates.workspaceId, current.workspaceId)
            )
          )
        if (!row)
          throw new ApplicationAccessError(
            "This template is no longer available. Retain the original creation identity to confirm its result."
          )
        try {
          await templateAccess(tx, current, row)
        } catch {
          throw new ApplicationAccessError()
        }
        if (value.initiativeIds.length) {
          if (!(await initiativeSettings(tx, current)).enabled)
            throw new ApplicationAccessError(
              "Shared initiatives are not enabled for this workspace."
            )
          const found = await tx
            .select({ id: initiatives.id })
            .from(initiatives)
            .where(
              and(
                eq(initiatives.workspaceId, current.workspaceId),
                inArray(initiatives.id, value.initiativeIds)
              )
            )
          if (found.length !== value.initiativeIds.length)
            throw new ApplicationAccessError()
        }
        // Replay returns committed identities only, under current result visibility.
        if (value.projectIds.length) {
          requireResourceScope(current, "projects:read")
          requireResourceScope(current, "projects:write")
          for (const id of value.projectIds) await lockProject(tx, current, id)
        }
        if (value.issueIds.length) {
          requireResourceScope(current, "issues:read")
          requireResourceScope(current, "issues:write")
          const found = await tx
            .select({ id: issues.id, teamId: issues.teamId })
            .from(issues)
            .where(
              and(
                inArray(issues.id, value.issueIds),
                readableIssueCondition(current, issues.id),
                isNull(issues.deletedAt),
                isNull(issues.archivedAt)
              )
            )
          if (found.length !== value.issueIds.length)
            throw new ApplicationAccessError()
          for (const teamId of new Set(found.map((r) => r.teamId)))
            await requireIssueTeam(tx, current, teamId)
        }
      },
      run: async (tx, current) => {
        try {
          await tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.id, current.workspaceId))
            .for("no key update")
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${current.workspaceId},4040))`
          )
          const [row] = await tx
            .select()
            .from(teamTemplates)
            .where(
              and(
                eq(teamTemplates.id, input.templateId),
                eq(teamTemplates.workspaceId, current.workspaceId)
              )
            )
            .for("share")
          if (!row)
            throw new TemplateValidationError(
              "This template was removed. Reload templates and choose another template."
            )
          await templateAccess(tx, current, row)
          if (revision(row) !== input.revision)
            throw new TemplateValidationError(
              "This template changed. Reload templates and review the latest version before creating."
            )
          const parsed = templatePayloadSchema.safeParse(row.payload)
          if (!parsed.success)
            throw new TemplateValidationError(
              "This template contains invalid content. Ask a template administrator to repair it."
            )
          const template = parsed.data as TemplateDraft
          if (template.kind === "document")
            throw new TemplateValidationError(
              "Choose an issue or project template."
            )
          const events: Array<{
            topic: string
            payload: Record<string, unknown>
          }> = []
          const issueIds: Array<string> = [],
            projectIds: Array<string> = [],
            initiativeIds: Array<string> = []
          async function createIssue(
            title: string,
            content: TemplateDraft["content"],
            properties: TemplateProperties,
            parentId = "",
            projectId?: string
          ) {
            if (properties.teamIds.length > 1)
              throw new TemplateValidationError(
                "Choose one team for each issue in this template."
              )
            const teamId =
              properties.teamIds[0] ??
              input.teamId ??
              template.properties.teamIds[0] ??
              row.teamId
            if (!teamId)
              throw new TemplateValidationError(
                "Choose a team before creating this issue."
              )
            const command = await canonicalTemplateIssueCommand(tx, current, {
              commandKey: input.commandKey,
              teamId,
              title,
              content,
              properties,
              parentId,
              projectId,
              triage: Boolean(input.triage),
            })
            await command.authorize(tx, current, undefined)
            const created = await command.run(tx, current)
            issueIds.push(created.value.issueId)
            events.push(...created.events)
            return created.value.issueId
          }
          let id: string
          if (template.kind === "issue") {
            if (template.issues.length || template.milestones.length)
              throw new TemplateValidationError(
                "Move project issues and milestones to a project template."
              )
            id = await createIssue(
              input.title ?? template.title,
              formContent(template, input.answers),
              template.properties
            )
            for (const child of template.subIssues)
              await createIssue(
                child.title,
                child.content,
                child.properties,
                id
              )
          } else {
            if (input.triage)
              throw new TemplateValidationError(
                "Choose an issue template for triage."
              )
            if (
              Object.keys(input.answers).length ||
              template.fields.length ||
              template.subIssues.length
            )
              throw new TemplateValidationError(
                "Move form fields and sub-issues to an issue template."
              )
            const p = template.properties
            if (p.project || p.assignee || p.estimate)
              throw new TemplateValidationError(
                "Move issue-only properties to an issue template."
              )
            const catalog = await readProjectCatalog(tx, current)
            const statuses = catalog.statuses.statuses.filter(
              (s) => s.id === p.status || s.name === p.status
            )
            if (statuses.length !== 1)
              throw new TemplateValidationError(
                "The project status is unavailable. Choose a current project status in the template."
              )
            const labelIds = p.labels.map((label) => {
              const matches = catalog.labels.labels.filter(
                (l) => !l.archived && (l.id === label || l.name === label)
              )
              if (matches.length !== 1)
                throw new TemplateValidationError(
                  "A project label is unavailable. Choose an active label in the template."
                )
              return matches[0].id
            })
            id = crypto.randomUUID()
            const dependencyIds: Array<string> = []
            const blocking: Array<typeof projects.$inferSelect> = []
            for (const dependency of p.dependencies) {
              const matches = await tx
                .select()
                .from(projects)
                .where(
                  and(
                    eq(projects.workspaceId, current.workspaceId),
                    readableProjectCondition(current, projects.id),
                    or(
                      sql`${projects.id}::text=${dependency.name}`,
                      eq(projects.name, dependency.name)
                    )
                  )
                )
              if (matches.length !== 1)
                throw new TemplateValidationError(
                  "A dependency project is unavailable or ambiguous. Choose an accessible project in the template."
                )
              if (dependency.direction === "blockedBy")
                dependencyIds.push(matches[0].id)
              else blocking.push(matches[0])
            }
            const command = canonicalProjectSaveCommand(
              current,
              input.commandKey,
              [
                {
                  id,
                  expectedRevision: null,
                  changes: {
                    name: input.title ?? template.title,
                    summary: template.summary,
                    description: template.content,
                    icon: template.icon,
                    statusId: statuses[0].id,
                    priority: p.priority,
                    teamIds: p.teamIds.length
                      ? p.teamIds
                      : input.teamId
                        ? [input.teamId]
                        : row.teamId
                          ? [row.teamId]
                          : [],
                    leadId: p.lead ?? "",
                    memberIds: p.members,
                    labelIds,
                    dependencyIds,
                    milestones: template.milestones.map((m) => ({
                      id: crypto.randomUUID(),
                      name: m.title,
                      description: m.content,
                      completed: false,
                    })),
                  },
                },
              ]
            )
            await command.authorize(tx, current, undefined)
            events.push(...(await command.run(tx, current)).events)
            projectIds.push(id)
            for (const target of [
              ...new Map(blocking.map((p) => [p.id, p])).values(),
            ]) {
              const visible = await tx
                .select({ id: projects.id })
                .from(projects)
                .where(
                  and(
                    eq(projects.workspaceId, current.workspaceId),
                    readableProjectCondition(current, projects.id)
                  )
                )
              const visibleIds = new Set(visible.map((p) => p.id))
              const command = canonicalProjectSaveCommand(
                current,
                input.commandKey,
                [
                  {
                    id: target.id,
                    expectedRevision: target.revision,
                    changes: {
                      dependencyIds: [
                        ...new Set([
                          ...(
                            (target.properties
                              .dependencyIds as Array<string>) ?? []
                          ).filter((id) => visibleIds.has(id)),
                          id,
                        ]),
                      ],
                    },
                  },
                ]
              )
              await command.authorize(tx, current, undefined)
              events.push(...(await command.run(tx, current)).events)
              projectIds.push(target.id)
            }
            for (const initiative of new Set(p.initiatives)) {
              const found = await tx
                .select()
                .from(initiatives)
                .where(
                  and(
                    eq(initiatives.workspaceId, current.workspaceId),
                    or(
                      sql`${initiatives.id}::text=${initiative}`,
                      eq(initiatives.name, initiative)
                    )
                  )
                )
                .for("update")
              if (found.length !== 1)
                throw new TemplateValidationError(
                  "An initiative is unavailable or ambiguous. Choose an active initiative in the template."
                )
              const command = canonicalInitiativeSaveCommand(
                current,
                input.commandKey,
                [
                  {
                    id: found[0].id,
                    expectedRevision: found[0].revision,
                    changes: {},
                    addProjectIds: [id],
                    removeProjectIds: [],
                  },
                ]
              )
              await command.authorize(tx, current)
              initiativeIds.push(found[0].id)
              events.push(...(await command.run(tx, current)).events)
            }
            for (const child of template.issues) {
              if (child.properties.project)
                throw new TemplateValidationError(
                  "Remove the existing project selection from nested issues; they belong to the new project."
                )
              await createIssue(
                child.title,
                child.content,
                child.properties,
                "",
                id
              )
            }
          }
          return {
            value: {
              kind: template.kind,
              id,
              issueIds,
              projectIds: [...new Set(projectIds)],
              initiativeIds: [...new Set(initiativeIds)],
            },
            resource: { type: template.kind, id },
            events,
          }
        } catch (error) {
          // Only failures raised before COMMIT are repairable. Transport/COMMIT failures must keep the exact retry identity.
          if (error instanceof ApplicationAccessError)
            throw new TemplateValidationError(
              "A referenced team, project, or initiative is no longer accessible or enabled. Repair the template references and try again."
            )
          if (error instanceof Error && error.constructor === Error)
            throw new TemplateValidationError(error.message)
          throw error
        }
      },
    })
    const { initiativeIds: _initiativeIds, ...value } = result.value
    return { ok: true, replayed: result.replayed, value }
  } catch (error) {
    if (error instanceof TemplateValidationError || error instanceof z.ZodError)
      return {
        ok: false,
        code: "TEMPLATE_VALIDATION",
        message:
          error instanceof z.ZodError
            ? "Check the template title and content, then try again."
            : error.message,
      }
    throw error
  }
}

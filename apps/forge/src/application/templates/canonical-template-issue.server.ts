import "@tanstack/react-start/server-only"
import { and, eq, isNull, or, sql } from "drizzle-orm"
import { canonicalIssueCreationCommand } from "../issues/issues.server"
import { TemplateValidationError, templateDocumentText } from "./template-forms"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { TemplateDraft, TemplateProperties } from "@/lib/template-contract"
import { issueStatuses, resourceLabels } from "@/db"
import { blankIssueDraft } from "@/lib/issue-record-contract"

export async function canonicalTemplateIssueCommand(
  tx: Transaction,
  current: Actor,
  input: {
    commandKey: string
    teamId: string
    title: string
    content: TemplateDraft["content"]
    properties: TemplateProperties
    parentId?: string
    projectId?: string
    triage?: boolean
    dueDate?: string
  }
) {
  const {
    commandKey,
    teamId,
    title,
    content,
    properties,
    parentId = "",
    projectId,
    triage = false,
    dueDate = "",
  } = input
  if (properties.teamIds.length > 1)
    throw new TemplateValidationError("Choose one team for each issue.")
  if (
    properties.initiatives.length ||
    properties.dependencies.length ||
    properties.lead ||
    properties.members.length
  )
    throw new TemplateValidationError(
      "Issue properties contain project-only settings. Move those settings to the project template."
    )
  const statuses = await tx
    .select()
    .from(issueStatuses)
    .where(
      and(
        eq(issueStatuses.workspaceId, current.workspaceId),
        eq(issueStatuses.teamId, teamId),
        or(
          eq(issueStatuses.id, properties.status),
          eq(issueStatuses.name, properties.status)
        )
      )
    )
    .for("share")
  if (statuses.length !== 1)
    throw new TemplateValidationError(
      "An issue status in this template is unavailable. Choose a current status in the template and try again."
    )
  const labelNames: Array<string> = []
  for (const label of properties.labels) {
    const matches = await tx
      .select()
      .from(resourceLabels)
      .where(
        and(
          eq(resourceLabels.workspaceId, current.workspaceId),
          or(isNull(resourceLabels.teamId), eq(resourceLabels.teamId, teamId)),
          or(
            sql`${resourceLabels.id}::text=${label}`,
            eq(resourceLabels.name, label)
          )
        )
      )
      .for("share")
    const active = matches.filter((l) => !l.definition?.archived)
    if (active.length !== 1)
      throw new TemplateValidationError(
        "An issue label is unavailable or ambiguous. Choose an active label in the template."
      )
    labelNames.push(active[0].name)
  }
  const text = templateDocumentText(content)
  return canonicalIssueCreationCommand(current, {
    commandKey,
    teamId,
    assigneeId: properties.assignee || null,
    draft: {
      ...blankIssueDraft(statuses[0].id),
      title,
      description: text,
      descriptionDoc: content,
      priority: properties.priority,
      assignee: properties.assignee ?? "",
      labels: labelNames.join(","),
      project: projectId ?? properties.project ?? "",
      dueDate,
      parentId,
      triage: !parentId && triage,
      estimate: properties.estimate,
    },
  })
}

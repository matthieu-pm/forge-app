import "@tanstack/react-start/server-only"
import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { DefinitionConflictError } from "./definitions.server"
import type { Actor } from "@/application/actor"
import {
  issueDefinitionScopes,
  issueLabels,
  issues,
  resourceLabels,
} from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import {
  readableIssueCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import {
  canTransition,
  defaultDefinitionValue,
} from "@/lib/issue-definition-contract"

const classificationSchema = z
  .object({
    issueId: z.uuid(),
    commandKey: z.string().min(1).max(255),
    expectedStatusId: z.string().min(1),
    statusId: z.string().min(1),
    labelIds: z
      .array(z.uuid())
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict()
// Shared command seam for FOR-41's canonical composers and subsequent API/tool adapters.
export async function setCanonicalIssueClassification(
  actor: Actor,
  raw: z.infer<typeof classificationSchema>
) {
  const input = classificationSchema.parse(raw)
  const { commandKey, ...commandInput } = input
  return executeCommand({
    actor,
    commandKey,
    operation: "issues.classify@1",
    input: commandInput,
    status: 200,
    parse: (value) => z.object({ issueId: z.uuid() }).parse(value),
    authorize: async (tx, current) => {
      requireResourceScope(current, "issues:read")
      requireResourceScope(current, "issues:write")
      const row = (
        await tx
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              eq(issues.id, input.issueId),
              readableIssueCondition(current, issues.id)
            )
          )
      )[0]
      if (!row) throw new ApplicationAccessError()
    },
    run: async (tx, current) => {
      const identity = (
        await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, input.issueId),
              eq(issues.workspaceId, current.workspaceId)
            )
          )
      )[0]
      if (!identity) throw new ApplicationAccessError()
      await tx
        .insert(issueDefinitionScopes)
        .values({
          workspaceId: current.workspaceId,
          teamId: identity.teamId,
          scopeKey: identity.teamId,
          value: defaultDefinitionValue(),
        })
        .onConflictDoNothing()
      const scope = (
        await tx
          .select()
          .from(issueDefinitionScopes)
          .where(
            and(
              eq(issueDefinitionScopes.workspaceId, current.workspaceId),
              eq(issueDefinitionScopes.teamId, identity.teamId)
            )
          )
          .for("share")
      )[0]
      const issue = (
        await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, input.issueId),
              readableIssueCondition(current, issues.id)
            )
          )
          .for("update")
      )[0]
      if (!issue || issue.teamId !== identity.teamId)
        throw new DefinitionConflictError()
      if (issue.statusId !== input.expectedStatusId)
        throw new DefinitionConflictError(
          "This issue's status changed. Reload before moving it."
        )
      if (
        !scope.value.statuses.statuses.some((s) => s.id === input.statusId) ||
        !canTransition(scope.value.transitions, issue.statusId, input.statusId)
      )
        throw new Error(
          "This status transition is not allowed by the team workflow."
        )
      const previous = await tx
        .select()
        .from(issueLabels)
        .where(
          and(
            eq(issueLabels.workspaceId, current.workspaceId),
            eq(issueLabels.issueId, issue.id)
          )
        )
      const labels = input.labelIds.length
        ? await tx
            .select()
            .from(resourceLabels)
            .where(
              and(
                eq(resourceLabels.workspaceId, current.workspaceId),
                inArray(resourceLabels.id, input.labelIds)
              )
            )
            .for("share")
        : []
      if (
        labels.length !== input.labelIds.length ||
        labels.some(
          (l) =>
            (l.teamId !== null && l.teamId !== issue.teamId) ||
            (l.definition?.archived &&
              !previous.some((p) => p.labelId === l.id))
        )
      )
        throw new Error("Choose active labels available to this team.")
      await tx
        .update(issues)
        .set({ statusId: input.statusId })
        .where(eq(issues.id, issue.id))
      await tx
        .delete(issueLabels)
        .where(
          and(
            eq(issueLabels.workspaceId, current.workspaceId),
            eq(issueLabels.issueId, issue.id)
          )
        )
      if (input.labelIds.length)
        await tx.insert(issueLabels).values(
          input.labelIds.map((labelId) => ({
            workspaceId: current.workspaceId,
            issueId: issue.id,
            labelId,
          }))
        )
      return {
        value: { issueId: issue.id },
        resource: { type: "issue", id: issue.id },
        events: [],
      }
    },
  })
}

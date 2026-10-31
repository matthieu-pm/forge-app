import "@tanstack/react-start/server-only"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { relationshipErrorMessage } from "./relationship-errors"
import {
  initialAssignmentActivity,
  readIssueRows,
  requireIssueTeam,
  resolveIssueFields,
} from "./issues.server"
import type { Actor } from "@/application/actor"
import type { EditIssueBatch } from "@/lib/canonical-issue-edit-contract"
import {
  db,
  issueLabels,
  issues,
  members,
  organizations,
  teamIssueNumbers,
} from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import { executeCommand } from "@/application/commands/execute-command.server"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { readableIssueCondition } from "@/application/resource-policy.server"
import { blankIssueDraft } from "@/lib/issue-record-contract"
import { editIssueBatchSchema } from "@/lib/canonical-issue-edit-contract"
import { withoutUndefined } from "@/lib/canonical-json"

class IssueEditConflict extends Error {}
export async function editCanonicalIssues(actor: Actor, raw: EditIssueBatch) {
  const input = editIssueBatchSchema.parse(raw),
    ids = input.edits.map((e) => e.issueId)
  try {
    const result = await executeCommand({
      actor,
      commandKey: input.commandKey,
      operation: "issues.edit@1",
      input: withoutUndefined({ teamId: input.teamId, edits: input.edits }),
      status: 200,
      parse: (value) =>
        z
          .object({ issueIds: z.array(z.uuid()) })
          .strict()
          .parse(value),
      authorize: async (tx, current, value) => {
        await requireIssueTeam(tx, current, input.teamId)
        const check = value?.issueIds ?? ids
        const found = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              inArray(issues.id, check),
              eq(issues.workspaceId, current.workspaceId),
              eq(issues.teamId, input.teamId),
              isNull(issues.archivedAt),
              readableIssueCondition(current, issues.id)
            )
          )
        if (found.length !== check.length) throw new ApplicationAccessError()
      },
      run: async (tx, current) => {
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, current.workspaceId))
          .for("no key update")
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${current.workspaceId},4040))`
        )
        await tx.execute(
          sql`SELECT public.forge_lock_issue_graph(${current.workspaceId})`
        )
        const rows = await tx
          .select()
          .from(issues)
          .where(
            and(
              inArray(issues.id, ids),
              eq(issues.workspaceId, current.workspaceId),
              eq(issues.teamId, input.teamId),
              isNull(issues.archivedAt)
            )
          )
          .orderBy(issues.id)
          .for("update")
        if (rows.length !== ids.length) throw new ApplicationAccessError()
        if (
          input.edits.some(
            (e) =>
              rows.find((r) => r.id === e.issueId)!.revision !==
              e.expectedRevision
          )
        )
          throw new IssueEditConflict(
            "These issues changed in another session."
          )
        const originals = await readIssueRows(tx, current, ids),
          createdIds: Array<string> = [],
          events: Array<{ topic: string; payload: Record<string, unknown> }> =
            []
        for (const edit of input.edits) {
          const row = rows.find((r) => r.id === edit.issueId)!,
            before = originals.find((r) => r.issue.id === edit.issueId)!.issue
          if (
            edit.changes.parentId !== undefined &&
            edit.changes.parentId !== (row.parentId ?? "")
          )
            throw new Error(
              "Use relationship controls to change an issue's parent."
            )
          if (edit.triageDecision && !before.triage)
            throw new IssueEditConflict("This issue has already left triage.")
          if (
            edit.triageDecision &&
            (!edit.changes.status ||
              (edit.triageDecision === "accept" &&
                edit.changes.assignee === undefined) ||
              Object.keys(edit.changes).some(
                (key) => !["status", "assignee"].includes(key)
              ))
          )
            throw new Error(
              "Choose a triage status and assignment before deciding."
            )
          const draft = {
            ...before,
            ...edit.changes,
            subIssues: [],
            ...(edit.triageDecision ? { triage: false, snoozed: false } : {}),
          }
          const resolved = await resolveIssueFields(
            tx,
            current,
            {
              teamId: input.teamId,
              commandKey: input.commandKey,
              draft,
              projectImport: edit.projectImport,
              cycleImport: edit.cycleImport,
            },
            { before, assignmentExplicit: edit.changes.assignee !== undefined }
          )
          if (
            edit.triageDecision &&
            (edit.triageDecision === "decline"
              ? resolved.status.group !== "canceled"
              : !["backlog", "unstarted", "started"].includes(
                  resolved.status.group
                ))
          )
            throw new Error("Choose a valid status for this triage decision.")
          // The automation is part of this edit, never a second command. Persist
          // its resulting assignment in both canonical columns and properties.
          draft.assignee = resolved.assignee ?? ""
          if (edit.changes.subscribers !== undefined) {
            const subscribers = [
              ...new Set(
                edit.changes.subscribers
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              ),
            ]
            const found = subscribers.length
              ? await tx
                  .select({ id: members.userId })
                  .from(members)
                  .where(
                    and(
                      eq(members.organizationId, current.workspaceId),
                      inArray(members.userId, subscribers)
                    )
                  )
                  .for("share")
              : []
            if (found.length !== subscribers.length)
              throw new Error(
                "Choose subscribers who are current workspace members."
              )
          }
          const now = new Date().toISOString()
          const activity = Object.entries(edit.changes)
            .filter(([field]) => field !== "subIssues")
            .map(([field, value]) => ({
              id: crypto.randomUUID(),
              author: current.userId,
              text:
                field === "status" && resolved.assignedOnStart
                  ? `moved to ${resolved.status.name} and self-assigned the issue`
                  : `updated ${field}`,
              createdAt: now,
              ...(field === "status" && resolved.assignedOnStart
                ? { automaticAssignment: { from: "", to: current.userId } }
                : {}),
              ...([
                "status",
                "priority",
                "assignee",
                "labels",
                "project",
                "cycle",
              ].includes(field)
                ? {
                    field,
                    from: String(before[field as keyof typeof before] ?? ""),
                    to: String(value ?? ""),
                  }
                : {}),
            }))
          if (edit.triageDecision)
            activity.push({
              id: crypto.randomUUID(),
              author: current.userId,
              text:
                edit.triageDecision === "accept"
                  ? "accepted from triage"
                  : "declined from triage",
              createdAt: now,
            })
          await tx
            .update(issues)
            .set({
              title: draft.title,
              statusId: resolved.status.id,
              assigneeId: resolved.assignee,
              projectId: resolved.projectId,
              cycleId: resolved.cycleId,
              parentId:
                edit.changes.parentId === undefined
                  ? row.parentId
                  : resolved.parentId,
              properties: {
                ...row.properties,
                ...draft,
                // Read projections redact deleted bodies. Keep the authoritative
                // discussion when unrelated issue properties are edited.
                comments: row.properties.comments ?? [],
                activity: [
                  ...before.activity,
                  ...activity,
                ] as typeof before.activity,
                subIssues: [],
              },
            })
            .where(eq(issues.id, row.id))
          await tx
            .delete(issueLabels)
            .where(
              and(
                eq(issueLabels.workspaceId, current.workspaceId),
                eq(issueLabels.issueId, row.id)
              )
            )
          if (resolved.labels.length)
            await tx.insert(issueLabels).values(
              resolved.labels.map((label) => ({
                workspaceId: current.workspaceId,
                issueId: row.id,
                labelId: label.id,
              }))
            )
          events.push({
            topic: "issue.updated",
            payload: { issueId: row.id, teamId: input.teamId },
          })
          if (edit.triageDecision)
            events.push({
              topic: `issue.triage.${edit.triageDecision === "accept" ? "accepted" : "declined"}`,
              payload: { issueId: row.id, teamId: input.teamId },
            })
          const children = edit.changes.subIssues ?? []
          if (children.length) {
            await tx
              .insert(teamIssueNumbers)
              .values({ teamId: input.teamId })
              .onConflictDoNothing()
            const last = (
              await tx
                .update(teamIssueNumbers)
                .set({
                  lastNumber: sql`${teamIssueNumbers.lastNumber}+${children.length}`,
                })
                .where(eq(teamIssueNumbers.teamId, input.teamId))
                .returning()
            )[0].lastNumber
            for (const [index, title] of children.entries()) {
              const childDraft = {
                ...blankIssueDraft(draft.status),
                title,
                parentId: row.id,
              }
              const childResolved = await resolveIssueFields(tx, current, {
                teamId: input.teamId,
                commandKey: input.commandKey,
                draft: childDraft,
              })
              const child = (
                await tx
                  .insert(issues)
                  .values({
                    workspaceId: current.workspaceId,
                    teamId: input.teamId,
                    number: last - children.length + index + 1,
                    title,
                    statusId: draft.status,
                    parentId: row.id,
                    assigneeId: childResolved.assignee,
                    creatorId: current.userId,
                    properties: {
                      ...childDraft,
                      assignee: childResolved.assignee ?? "",
                      activity: initialAssignmentActivity(
                        current,
                        childResolved.assignee,
                        new Date(now)
                      ),
                    },
                  })
                  .returning()
              )[0]
              createdIds.push(child.id)
              events.push({
                topic: "issue.created",
                payload: { issueId: child.id, teamId: input.teamId },
              })
            }
          }
        }
        return {
          value: { issueIds: [...ids, ...createdIds] },
          resource: { type: "issueBatch", id: ids[0] },
          events,
        }
      },
    })
    const records = await db.transaction(async (tx) => {
      const current = await currentCommandActor(tx, actor)
      return readIssueRows(tx, current, result.value.issueIds)
    })
    return { status: "saved" as const, replayed: result.replayed, records }
  } catch (error) {
    if (!(error instanceof IssueEditConflict)) {
      const message = relationshipErrorMessage(error)
      if (message) throw new Error(message)
      throw error
    }
    const records = await db.transaction(async (tx) => {
      const current = await currentCommandActor(tx, actor)
      await requireIssueTeam(tx, current, input.teamId)
      return readIssueRows(tx, current, ids)
    })
    return { status: "conflict" as const, records }
  }
}

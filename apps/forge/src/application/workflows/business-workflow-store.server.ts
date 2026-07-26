import "@tanstack/react-start/server-only"

import { and, eq, inArray, isNull, sql } from "drizzle-orm"

import { businessWorkflowRuns, db } from "@/db"

export const WORKSPACE_INVITATION_WORKFLOW_KIND =
  "workspace-invitation-lifecycle-v1"

export async function reserveInvitationBusinessRun(input: {
  workspaceId: string
  invitationId: string
}) {
  const idempotencyKey = `workspace-invitation:v1:${input.invitationId}`

  await db
    .insert(businessWorkflowRuns)
    .values({
      workspaceId: input.workspaceId,
      kind: WORKSPACE_INVITATION_WORKFLOW_KIND,
      subjectType: "invitation",
      subjectId: input.invitationId,
      idempotencyKey,
    })
    .onConflictDoNothing({
      target: businessWorkflowRuns.idempotencyKey,
    })

  const [run] = await db
    .select()
    .from(businessWorkflowRuns)
    .where(eq(businessWorkflowRuns.idempotencyKey, idempotencyKey))
    .limit(1)

  if (!run) {
    throw new Error("The invitation workflow record could not be reserved.")
  }

  return run
}

export async function recordWorkflowStartAttempt(businessRunId: string) {
  const [run] = await db
    .update(businessWorkflowRuns)
    .set({
      state: "starting",
      startAttempts: sql`${businessWorkflowRuns.startAttempts} + 1`,
      failureCode: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(businessWorkflowRuns.id, businessRunId),
        isNull(businessWorkflowRuns.sdkRunId),
        inArray(businessWorkflowRuns.state, [
          "queued",
          "starting",
          "failed-to-start",
        ])
      )
    )
    .returning()

  return run
}

export async function markWorkflowFailedToStart(businessRunId: string) {
  await db
    .update(businessWorkflowRuns)
    .set({
      state: "failed-to-start",
      failureCode: "workflow_start_exhausted",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(businessWorkflowRuns.id, businessRunId),
        isNull(businessWorkflowRuns.sdkRunId)
      )
    )
}

import "@tanstack/react-start/server-only"

import { and, eq } from "drizzle-orm"
import { start } from "workflow/api"

import { businessWorkflowRuns, db, invitations } from "@/db"
import {
  markWorkflowFailedToStart,
  recordWorkflowStartAttempt,
  reserveInvitationBusinessRun,
} from "@/application/workflows/business-workflow-store.server"
import { runWorkflowStartAttempts } from "@/application/workflows/workflow-start-retry"
import { canRetryInvitationWorkflowRun } from "@/application/workflows/invitation-workflow-policy"
import { workspaceInvitationLifecycleV1 } from "@/workflows/invitation-workflow"

export type InvitationWorkflowStartResult =
  | { state: "queued"; businessRunId: string }
  | { state: "failed-to-start"; businessRunId: string }

async function enqueueReservedRun(
  businessRunId: string
): Promise<InvitationWorkflowStartResult> {
  const queued = await runWorkflowStartAttempts({
    beforeAttempt: async () => {
      return Boolean(await recordWorkflowStartAttempt(businessRunId))
    },
    start: async () => {
      await start(workspaceInvitationLifecycleV1, [businessRunId])
    },
    onFailure: (error, attempt) => {
      console.error("[workflow] invitation start attempt failed", {
        businessRunId,
        attempt,
        error:
          error instanceof Error ? error.name : "UnknownWorkflowStartError",
      })
    },
  })

  if (queued) {
    return { state: "queued", businessRunId }
  }

  await markWorkflowFailedToStart(businessRunId)
  return { state: "failed-to-start", businessRunId }
}

export async function startInvitationWorkflow(invitationId: string) {
  const [invitation] = await db
    .select({
      id: invitations.id,
      workspaceId: invitations.organizationId,
    })
    .from(invitations)
    .where(eq(invitations.id, invitationId))
    .limit(1)

  if (!invitation) {
    throw new Error("The invitation no longer exists.")
  }

  const run = await reserveInvitationBusinessRun({
    workspaceId: invitation.workspaceId,
    invitationId: invitation.id,
  })

  if (run.state === "running" || run.state === "completed") {
    return { state: "queued", businessRunId: run.id } as const
  }
  if (!canRetryInvitationWorkflowRun(run)) {
    throw new Error(
      "The existing invitation workflow cannot be started automatically."
    )
  }

  return enqueueReservedRun(run.id)
}

export async function retryInvitationWorkflow(input: {
  businessRunId: string
  workspaceId: string
}) {
  const [run] = await db
    .select({
      id: businessWorkflowRuns.id,
      sdkRunId: businessWorkflowRuns.sdkRunId,
      state: businessWorkflowRuns.state,
    })
    .from(businessWorkflowRuns)
    .where(
      and(
        eq(businessWorkflowRuns.id, input.businessRunId),
        eq(businessWorkflowRuns.workspaceId, input.workspaceId),
        eq(businessWorkflowRuns.subjectType, "invitation")
      )
    )
    .limit(1)

  if (!run) {
    throw new Error("The invitation workflow could not be found.")
  }
  if (run.state === "running" || run.state === "completed") {
    return { state: "queued", businessRunId: run.id } as const
  }
  if (!canRetryInvitationWorkflowRun(run)) {
    throw new Error(
      "Only an invitation workflow that failed to start can be retried."
    )
  }

  return enqueueReservedRun(run.id)
}

import { createHook, getWorkflowMetadata, sleep } from "workflow"

import {
  claimInvitationRunStep,
  completeInvitationRunStep,
  expireInvitationStep,
  failInvitationRunStep,
  sendInvitationEffectStep,
} from "@/workflows/invitation-workflow-steps"

export async function workspaceInvitationLifecycleV1(businessRunId: string) {
  "use workflow"

  const sdkRunId = getWorkflowMetadata().workflowRunId
  using activeRunClaim = createHook({
    token: `forge:business-workflow:${businessRunId}`,
  })
  const conflict = await activeRunClaim.getConflict()

  if (conflict) {
    return { businessRunId, state: "duplicate" } as const
  }

  const claimed = await claimInvitationRunStep(businessRunId, sdkRunId)
  if (!claimed) {
    return { businessRunId, state: "duplicate" } as const
  }

  try {
    const initial = await sendInvitationEffectStep(businessRunId, "initial")
    if (initial.state !== "delivered") {
      await completeInvitationRunStep(businessRunId)
      return { businessRunId, state: initial.state } as const
    }

    await sleep("24h")

    const reminder = await sendInvitationEffectStep(
      businessRunId,
      "reminder-24h"
    )
    if (reminder.state !== "delivered") {
      await completeInvitationRunStep(businessRunId)
      return { businessRunId, state: reminder.state } as const
    }

    await sleep(new Date(initial.expiresAt))
    await expireInvitationStep(businessRunId)
    await completeInvitationRunStep(businessRunId)
    return { businessRunId, state: "completed" } as const
  } catch (error) {
    await failInvitationRunStep(businessRunId)
    throw error
  }
}

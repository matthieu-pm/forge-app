const RETRYABLE_INVITATION_WORKFLOW_STATES = new Set([
  "queued",
  "starting",
  "failed-to-start",
])

export function canRetryInvitationWorkflowRun(input: {
  sdkRunId: string | null
  state: string
}) {
  return (
    input.sdkRunId === null &&
    RETRYABLE_INVITATION_WORKFLOW_STATES.has(input.state)
  )
}

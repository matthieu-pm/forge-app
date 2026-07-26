import "@tanstack/react-start/server-only"

function enabledWorkspaceIds() {
  return new Set(
    (process.env.FORGE_INVITATION_WORKFLOW_WORKSPACE_ALLOWLIST ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  )
}

export function isInvitationWorkflowEnabled(workspaceId: string) {
  return (
    process.env.FORGE_FEATURE_INVITATION_WORKFLOW === "true" &&
    enabledWorkspaceIds().has(workspaceId)
  )
}

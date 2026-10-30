import "@tanstack/react-start/server-only"

export function startedAssignmentEnabled() {
  return (
    process.env.FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED === "true" &&
    process.env.FORGE_ASSIGN_STARTED_ISSUES_ENABLED === "true"
  )
}

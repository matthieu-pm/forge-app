export const WORKSPACE_MEMBER_LIMIT_MESSAGE =
  "This Free workspace is full. Ask an owner to upgrade or remove a member."

/** Match the database invariant, including Drizzle's wrapped driver cause. */
export function isWorkspaceMemberLimitError(error: unknown) {
  const seen = new Set<unknown>()
  let cause = error
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause)
    const record = cause as Record<string, unknown>
    if (
      record.code === "23514" &&
      record.constraint === "workspace_free_member_limit"
    )
      return true
    cause = record.cause
  }
  return false
}

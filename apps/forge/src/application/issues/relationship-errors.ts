/** PostgreSQL driver errors can wrap the constraint in several cause layers. */
export function relationshipErrorMessage(error: unknown) {
  let cause = error
  const seen = new Set<unknown>()
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause)
    const detail = cause as {
      code?: string
      constraint?: string
      cause?: unknown
    }
    if (detail.code === "23514" && detail.constraint === "issues_cycle_closed")
      return "This cycle is closed. Choose a current or upcoming cycle."
    if (
      detail.code === "23514" &&
      [
        "issues_parent_acyclic",
        "issues_not_self_parent",
        "issue_relations_blocks_acyclic",
      ].includes(detail.constraint ?? "")
    )
      return "This relationship would create a cycle. Choose another issue."
    cause = detail.cause
  }
}

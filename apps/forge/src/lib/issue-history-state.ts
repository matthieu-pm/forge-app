import { createServerFn } from "@tanstack/react-start"
import { browserIssueHistoryQuerySchema } from "./issue-history-contract"

export const loadIssueHistory = createServerFn({ method: "GET" })
  .validator(browserIssueHistoryQuerySchema)
  .handler(async ({ data }) => {
    const [{ getRequest, setResponseHeader }, { requireSessionActor }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/adapters/auth/session-actor.server"),
      ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error("The active session changed. Reload history.")
    const { queryIssueHistory } =
      await import("@/application/issues/issue-history.server")
    return queryIssueHistory(actor, data.query)
  })

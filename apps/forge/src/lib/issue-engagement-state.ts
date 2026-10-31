import { createServerFn } from "@tanstack/react-start"
import { browserIssueEngagementSchema } from "./issue-engagement-contract"

export const persistIssueEngagement = createServerFn({ method: "POST" })
  .validator(browserIssueEngagementSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      { commandIssueEngagement },
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/issues/issue-engagement.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error(
        "The active session changed. Reload before changing this issue."
      )
    return JSON.stringify(await commandIssueEngagement(actor, data.command))
  })

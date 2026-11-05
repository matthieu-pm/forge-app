import { createServerFn } from "@tanstack/react-start"
import { sharedInboxQuerySchema } from "./shared-inbox-contract"

export const loadSharedInbox = createServerFn({ method: "GET" })
  .validator(sharedInboxQuerySchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      { queryInbox },
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/inbox/inbox-query.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error("The active session changed. Reload your inbox.")
    return queryInbox(actor, data.cursor)
  })

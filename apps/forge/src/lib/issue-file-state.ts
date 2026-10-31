import { createServerFn } from "@tanstack/react-start"
import { browserIssueFileSchema } from "./issue-file-contract"

export const persistIssueFiles = createServerFn({ method: "POST" })
  .validator(browserIssueFileSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/issues/issue-files.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error(
        "The active session changed. Reload before changing files."
      )
    const { workspaceId: _w, sessionId: _s, ...input } = data
    try {
      return JSON.stringify({
        status: "saved",
        ...(await service.commandIssueFiles(actor, input)),
      })
    } catch (error) {
      if (error instanceof service.IssueFileInputError)
        return JSON.stringify({
          status: "rejected",
          message: error.message,
          records: [],
        })
      throw error
    }
  })

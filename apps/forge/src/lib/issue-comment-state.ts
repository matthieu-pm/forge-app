import { createServerFn } from "@tanstack/react-start"
import {
  browserIssueCommentSchema,
  mentionQuerySchema,
} from "./issue-comment-contract"

async function context(workspaceId: string, sessionId: string) {
  const [{ getRequest, setResponseHeader }, { requireSessionActor }] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
    ])
  setResponseHeader("Cache-Control", "private, no-store")
  const actor = await requireSessionActor(getRequest())
  if (
    actor.workspaceId !== workspaceId ||
    actor.authentication.kind !== "session" ||
    actor.authentication.sessionId !== sessionId
  )
    throw new Error("The active session changed. Reload before commenting.")
  return actor
}
export const persistIssueComment = createServerFn({ method: "POST" })
  .validator(browserIssueCommentSchema)
  .handler(async ({ data }) => {
    const actor = await context(data.workspaceId, data.sessionId)
    const { commandIssueComment } =
      await import("@/application/issues/issue-comments.server")
    const { workspaceId: _w, sessionId: _s, ...input } = data
    return JSON.stringify(await commandIssueComment(actor, input))
  })
export const loadCommentMentions = createServerFn({ method: "GET" })
  .validator(mentionQuerySchema)
  .handler(async ({ data }) => {
    const actor = await context(data.workspaceId, data.sessionId)
    const { queryCommentMentions } =
      await import("@/application/issues/issue-comments.server")
    return queryCommentMentions(actor, data.issueId, data.query)
  })

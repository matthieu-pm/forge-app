import { createServerFn } from "@tanstack/react-start"
import {
  browserInactiveIssuesSchema,
  browserIssueLifecycleSchema,
} from "./issue-lifecycle-contract"

async function lifecycleActor(identity: {
  workspaceId: string
  sessionId: string
}) {
  const [{ getRequest, setResponseHeader }, { requireSessionActor }] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
    ])
  setResponseHeader("Cache-Control", "private, no-store")
  const actor = await requireSessionActor(getRequest())
  if (
    actor.workspaceId !== identity.workspaceId ||
    actor.authentication.kind !== "session" ||
    actor.authentication.sessionId !== identity.sessionId
  )
    throw new Error("The active session changed. Reload to try again.")
  return actor
}
export const persistIssueLifecycle = createServerFn({ method: "POST" })
  .validator(browserIssueLifecycleSchema)
  .handler(async ({ data }) => {
    const actor = await lifecycleActor(data)
    const { changeIssueLifecycle } =
      await import("@/application/issues/issue-lifecycle.server")
    const { workspaceId: _w, sessionId: _s, ...input } = data
    return JSON.stringify(await changeIssueLifecycle(actor, input))
  })
export const loadInactiveIssues = createServerFn({ method: "GET" })
  .validator(browserInactiveIssuesSchema)
  .handler(async ({ data }) => {
    const actor = await lifecycleActor(data)
    const { listInactiveIssues } =
      await import("@/application/issues/issue-lifecycle.server")
    const { workspaceId: _w, sessionId: _s, ...input } = data
    return JSON.stringify(await listInactiveIssues(actor, input))
  })

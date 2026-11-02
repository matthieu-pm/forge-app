import { createServerFn, createServerOnlyFn } from "@tanstack/react-start"
import {
  browserApplyTemplateSchema,
  templateApplicationQuerySchema,
} from "./template-application-contract"

const applicationDependencies = createServerOnlyFn(async () => {
  const [
    { getRequest, setResponseHeader },
    { requireSessionActor },
    application,
  ] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("@/adapters/auth/session-actor.server"),
    import("@/application/templates/template-application.server"),
  ])
  setResponseHeader("Cache-Control", "private, no-store")
  return { actor: await requireSessionActor(getRequest()), application }
})
export const loadTemplateApplications = createServerFn({ method: "GET" })
  .validator(templateApplicationQuerySchema)
  .handler(async ({ data }) => {
    const { actor, application } = await applicationDependencies()
    return application.loadApplicationDirectory(actor, data)
  })
export const loadTemplateReferences = createServerFn({ method: "GET" }).handler(
  async () => {
    const { actor, application } = await applicationDependencies()
    return application.loadTemplateReferences(actor)
  }
)
export const instantiateTemplate = createServerFn({ method: "POST" })
  .validator(browserApplyTemplateSchema)
  .handler(async ({ data }) => {
    const { actor, application } = await applicationDependencies()
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error(
        "The active session changed. Reload before creating from a template."
      )
    const { workspaceId: _workspaceId, sessionId: _sessionId, ...input } = data
    return application.applyTemplate(actor, input)
  })

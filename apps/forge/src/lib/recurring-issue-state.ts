import { createServerFn, createServerOnlyFn } from "@tanstack/react-start"
import { z } from "zod"
import { deleteTemplateSchema, templateQuerySchema } from "./template-contract"
import { saveRecurringIssueSchema } from "./recurring-issue-contract"

const dependencies = createServerOnlyFn(async () => {
  const [
    { getRequest, setResponseHeader },
    { requireSessionActor },
    application,
  ] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("@/adapters/auth/session-actor.server"),
    import("@/application/recurring-issues/recurring-issues.server"),
  ])
  setResponseHeader("Cache-Control", "private, no-store")
  const actor = await requireSessionActor(getRequest())
  const { requireFeatureWrite } =
    await import("@/application/features/features.server")
  requireFeatureWrite(actor, "recurringIssues")
  return { actor, application }
})
export const loadRecurringIssues = createServerFn({ method: "GET" })
  .validator(templateQuerySchema)
  .handler(async ({ data }) => {
    const { actor, application } = await dependencies()
    return application.loadRecurringIssues(actor, data.slug)
  })
export const saveRecurringIssue = createServerFn({ method: "POST" })
  .validator(
    saveRecurringIssueSchema.extend({
      workspaceId: z.string().min(1),
      sessionId: z.string().min(1),
    })
  )
  .handler(async ({ data }) => {
    const { actor, application } = await dependencies()
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error(
        "The active session changed. Reload before saving the recurring issue."
      )
    const { workspaceId: _workspaceId, sessionId: _sessionId, ...input } = data
    try {
      return {
        ok: true as const,
        ...(await application.saveRecurringIssue(actor, input)),
      }
    } catch (error) {
      const { TemplateValidationError } =
        await import("@/application/templates/template-forms")
      if (error instanceof TemplateValidationError)
        return { ok: false as const, message: error.message }
      throw error
    }
  })
export const deleteRecurringIssue = createServerFn({ method: "POST" })
  .validator(
    deleteTemplateSchema.extend({
      slug: z.string().min(1),
      updatedAt: z.string().datetime(),
    })
  )
  .handler(async ({ data }) => {
    const { actor, application } = await dependencies()
    return application.deleteRecurringIssue(actor, data)
  })

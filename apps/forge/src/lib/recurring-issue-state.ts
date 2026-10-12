import { createServerFn, createServerOnlyFn } from "@tanstack/react-start"
import { z } from "zod"
import { deleteTemplateSchema, templateQuerySchema } from "./template-contract"
import { saveRecurringIssueSchema } from "./recurring-issue-contract"

const dependencies = createServerOnlyFn(async () => {
  const [{ getRequest }, { requireSessionActor }, application] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/recurring-issues/recurring-issues.server"),
    ])
  return { actor: await requireSessionActor(getRequest()), application }
})
export const loadRecurringIssues = createServerFn({ method: "GET" })
  .validator(templateQuerySchema)
  .handler(async ({ data }) => {
    const { actor, application } = await dependencies()
    return application.loadRecurringIssues(actor, data.slug)
  })
export const saveRecurringIssue = createServerFn({ method: "POST" })
  .validator(saveRecurringIssueSchema)
  .handler(async ({ data }) => {
    const { actor, application } = await dependencies()
    return application.saveRecurringIssue(actor, data)
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

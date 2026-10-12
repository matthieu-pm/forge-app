import { createServerFn, createServerOnlyFn } from "@tanstack/react-start"
import {
  defaultTemplateSchema,
  deleteTemplateSchema,
  saveTemplateSchema,
  templateScopeSchema,
} from "@/lib/template-contract"

const dependencies = createServerOnlyFn(async () => {
  const [{ getRequest }, { requireSessionActor }, application] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/templates/templates.server"),
    ])
  return { actor: await requireSessionActor(getRequest()), application }
})
export const loadTemplates = createServerFn({ method: "GET" })
  .validator(templateScopeSchema)
  .handler(async ({ data }) => {
    const { actor, application } = await dependencies()
    return application.loadDirectory(actor, data.slug)
  })
export const saveTemplate = createServerFn({ method: "POST" })
  .validator(saveTemplateSchema)
  .handler(async ({ data }) => {
    const { actor, application } = await dependencies()
    return application.saveTemplate(actor, data)
  })
export const deleteTemplate = createServerFn({ method: "POST" })
  .validator(deleteTemplateSchema)
  .handler(async ({ data }) => {
    const { actor, application } = await dependencies()
    return application.deleteTemplate(actor, data)
  })
export const setDefaultTemplate = createServerFn({ method: "POST" })
  .validator(defaultTemplateSchema)
  .handler(async ({ data }) => {
    const { actor, application } = await dependencies()
    return application.setDefault(actor, data)
  })

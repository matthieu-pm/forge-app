import { createServerFn } from "@tanstack/react-start"
import {
  preferenceImportIdentitySchema,
  preferenceImportPlanSchema,
  preferenceImportRequestSchema,
} from "./preference-import-contract"

async function boundary() {
  const [{ getRequest, setResponseHeader }, { requireSessionActor }, service] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/preferences/preference-import.server"),
    ])
  setResponseHeader("Cache-Control", "private, no-store")
  return { actor: await requireSessionActor(getRequest()), service }
}
export const loadPreferenceImports = createServerFn({ method: "GET" })
  .validator(preferenceImportIdentitySchema)
  .handler(async ({ data }) => {
    const { actor, service } = await boundary()
    return service.loadPreferenceImports(actor, data)
  })
export const preparePreferenceImport = createServerFn({ method: "POST" })
  .validator(preferenceImportPlanSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await boundary()
    return service.preparePreferenceImport(actor, data)
  })
export const applyPreferenceImportField = createServerFn({ method: "POST" })
  .validator(preferenceImportRequestSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await boundary()
    return service.applyPreferenceImportField(actor, data)
  })

import { createServerFn } from "@tanstack/react-start"
import {
  importChoiceSchema,
  importCutoverSchema,
  importFileRequestSchema,
  importIdentitySchema,
  importRequestSchema,
} from "./import-execution-contract"

async function context(data: { workspaceId: string; sessionId: string }) {
  const [{ getRequest, setResponseHeader }, { requireSessionActor }, service] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/imports/imports.server"),
    ])
  setResponseHeader("Cache-Control", "private, no-store")
  const actor = await requireSessionActor(getRequest())
  if (
    actor.workspaceId !== data.workspaceId ||
    actor.authentication.kind !== "session" ||
    actor.authentication.sessionId !== data.sessionId
  )
    throw new Error("The active session changed. Reload before importing.")
  return { actor, service }
}
export const prepareLegacyImport = createServerFn({ method: "POST" })
  .validator(importIdentitySchema)
  .handler(async ({ data }) => {
    const { actor, service } = await context(data)
    return JSON.stringify(await service.prepareImport(actor))
  })
export const loadLegacyImports = createServerFn({ method: "GET" })
  .validator(importIdentitySchema)
  .handler(async ({ data }) => {
    const { actor, service } = await context(data)
    return JSON.stringify(await service.readImports(actor))
  })
export const executeLegacyImport = createServerFn({ method: "POST" })
  .validator(importRequestSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await context(data)
    return JSON.stringify(await service.runImportBatch(actor, data))
  })
export const resolveLegacyImport = createServerFn({ method: "POST" })
  .validator(importChoiceSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await context(data)
    return JSON.stringify(await service.chooseImportConflict(actor, data))
  })
export const bindLegacyImportFile = createServerFn({ method: "POST" })
  .validator(importFileRequestSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await context(data)
    return JSON.stringify(await service.finalizeImportFile(actor, data))
  })

export const retryLegacyImport = createServerFn({ method: "POST" })
  .validator(importRequestSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await context(data)
    return JSON.stringify(await service.retryImportRecords(actor, data))
  })

export const loadLegacyImport = createServerFn({ method: "GET" })
  .validator(importRequestSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await context(data)
    return JSON.stringify(await service.readImport(actor, data.id))
  })

export const pauseLegacyImport = createServerFn({ method: "POST" })
  .validator(importRequestSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await context(data)
    return JSON.stringify(await service.pauseAutomaticImport(actor, data))
  })

export const reconcileLegacyImport = createServerFn({ method: "POST" })
  .validator(importCutoverSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await context(data)
    return JSON.stringify(await service.cutoverImport(actor, data))
  })

export const downloadLegacyImportReport = createServerFn({ method: "GET" })
  .validator(importRequestSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await context(data)
    return JSON.stringify(await service.downloadImportReport(actor, data.id))
  })

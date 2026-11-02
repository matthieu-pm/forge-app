import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import {
  documentCommandSchema,
  documentSourceSchema,
} from "./document-contract"

const binding = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
})
async function context(data: z.infer<typeof binding>) {
  const [{ getRequest, setResponseHeader }, { requireSessionActor }] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
    ])
  setResponseHeader("Cache-Control", "private, no-store")
  const actor = await requireSessionActor(getRequest())
  if (
    actor.workspaceId !== data.workspaceId ||
    actor.authentication.kind !== "session" ||
    actor.authentication.sessionId !== data.sessionId
  )
    throw new Error("The active session changed. Reload before continuing.")
  return actor
}
export const loadSharedDocuments = createServerFn({ method: "GET" })
  .validator(
    binding.extend({
      source: documentSourceSchema.optional(),
      id: z.uuid().optional(),
    })
  )
  .handler(async ({ data }) => {
    const actor = await context(data)
    const { readDocuments } =
      await import("@/application/documents/documents.server")
    return JSON.stringify(await readDocuments(actor, data))
  })
export const loadDocumentHistory = createServerFn({ method: "GET" })
  .validator(
    binding.extend({
      id: z.uuid(),
      before: z.number().int().positive().optional(),
    })
  )
  .handler(async ({ data }) => {
    const actor = await context(data)
    const { readDocumentHistory } =
      await import("@/application/documents/documents.server")
    return JSON.stringify(
      await readDocumentHistory(actor, data.id, data.before)
    )
  })
export const persistSharedDocument = createServerFn({ method: "POST" })
  .validator(
    binding.extend({ commandKey: z.uuid(), command: documentCommandSchema })
  )
  .handler(async ({ data }) => {
    const actor = await context(data)
    const { commandDocument } =
      await import("@/application/documents/documents.server")
    return JSON.stringify(
      await commandDocument(actor, data.commandKey, data.command)
    )
  })

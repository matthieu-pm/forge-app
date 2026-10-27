import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import {
  callIdSchema,
  connectCallSchema,
  importCallSchema,
  noteInputSchema,
  retentionInputSchema,
} from "@/lib/calls"

async function dependencies() {
  const [{ getRequest }, { requireSessionActor }, service] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("@/adapters/auth/session-actor.server"),
    import("@/application/calls/calls.server"),
  ])
  return { actor: await requireSessionActor(getRequest()), service }
}
export const loadCalls = createServerFn({ method: "GET" })
  .validator(z.object({ teamId: z.string().uuid().optional() }))
  .handler(async ({ data }) => {
    const { actor, service } = await dependencies()
    return service.listCalls(actor, data.teamId)
  })
export const loadCall = createServerFn({ method: "GET" })
  .validator(callIdSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await dependencies()
    return service.readCall(actor, data.callId)
  })
export const uploadCall = createServerFn({ method: "POST" })
  .validator(importCallSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await dependencies()
    return service.importCall(actor, data)
  })
export const addNote = createServerFn({ method: "POST" })
  .validator(noteInputSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await dependencies()
    return service.addCallNote(actor, data)
  })
export const updateCallAction = createServerFn({ method: "POST" })
  .validator(
    callIdSchema.extend({ actionId: z.string().uuid(), completed: z.boolean() })
  )
  .handler(async ({ data }) => {
    const { actor, service } = await dependencies()
    return service.setCallAction(actor, data)
  })
export const updateCallRetention = createServerFn({ method: "POST" })
  .validator(retentionInputSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await dependencies()
    return service.saveRetention(actor, data.days)
  })
export const connectMeetingProvider = createServerFn({ method: "POST" })
  .validator(connectCallSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await dependencies()
    return service.beginConnection(actor, data.provider, data.teamId)
  })
export const disconnectMeetingProvider = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { actor, service } = await dependencies()
    return service.disconnectCallProvider(actor, data.id)
  })
export const syncMeetingCalls = createServerFn({ method: "POST" }).handler(
  async () => {
    const { actor, service } = await dependencies()
    return service.syncCalls(actor)
  }
)
export const generateCallRecap = createServerFn({ method: "POST" })
  .validator(callIdSchema)
  .handler(async ({ data }) => {
    const { actor, service } = await dependencies()
    return service.summarizeCall(actor, data.callId)
  })
